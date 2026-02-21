/**
 * @fileoverview sera-core daemon entry point
 * @module sera-core/server
 *
 * Starts the HTTP/WebSocket server (port 9800) and MCP server (port 9877) with:
 * - REST API for audit management and health checks
 * - WebSocket API for client connections (VS Code, dashboard)
 * - MCP HTTP API for Claude Code agent tool calls
 * - Database management with per-audit StorageEngines
 * - EventBridge for cross-client event distribution
 */

import * as http from 'http';
import express from 'express';
import { loadConfig, ensureSeraHome, SeraConfig } from './config';
import { AuditRegistry } from './database/AuditRegistry';
import { DatabaseManager } from './database/DatabaseManager';
import { EventBridge } from './events/EventBridge';
import { WebSocketAPI } from './api/WebSocketAPI';
import { RestAPI } from './api/RestAPI';
import { MCPServer } from './mcp/MCPServer';
import { CoreHandler } from './mcp/handlers/CoreHandler';
import { QuizHandler } from './mcp/handlers/QuizHandler';
import { TestCoverageHandler } from './mcp/handlers/TestCoverageHandler';
import { NotepadHandler } from './mcp/handlers/NotepadHandler';
import { StatsHandler } from './mcp/handlers/StatsHandler';
import { TraceHandler } from './mcp/handlers/TraceHandler';
import { AgentHandler } from './mcp/handlers/AgentHandler';
import { AgentRegistrationStore } from './agents/AgentRegistrationStore';
import { CredentialStore } from './credentials/CredentialStore';
import { BenchmarkStore } from './benchmark/BenchmarkStore';
import { AgentExecutor } from './execution/AgentExecutor';
import { DebugHandler } from './mcp/handlers/DebugHandler';
import { LogBuffer } from './debug/LogBuffer';

export interface SeraCoreOptions {
    /** Override the sera home directory (default: ~/.sera) */
    seraHome?: string;
    /** Override the client/WebSocket port */
    clientPort?: number;
    /** Override the MCP server port */
    mcpPort?: number;
    /** Override the debug MCP server port (testnet mode only, default: mcpPort + 1) */
    debugPort?: number;
    /** Enable testnet mode (debug tools on separate port, event recording) */
    testnet?: boolean;
    /** Override the resources directory for agent registrations */
    resourcesDir?: string;
}

export class SeraCore {
    private config: SeraConfig;
    private registry: AuditRegistry;
    private dbManager: DatabaseManager;
    private bridge: EventBridge;
    private wsApi: WebSocketAPI;
    private restApi: RestAPI;
    private mcpServer: MCPServer;
    private server!: http.Server;
    private registrationStore: AgentRegistrationStore;
    private benchmarkStore: BenchmarkStore;
    private cleanupTimer?: ReturnType<typeof setInterval>;
    private options: SeraCoreOptions;
    private logBuffer?: LogBuffer;
    private debugMcpServer?: MCPServer;

    constructor(options?: SeraCoreOptions) {
        this.options = options || {};
        const seraHome = this.options.seraHome;

        ensureSeraHome(seraHome);
        this.config = loadConfig(seraHome);

        // Apply port overrides
        if (this.options.clientPort !== undefined) {
            this.config.ports.client = this.options.clientPort;
        }
        if (this.options.mcpPort !== undefined) {
            this.config.ports.mcp = this.options.mcpPort;
        }

        this.registry = new AuditRegistry(seraHome);
        this.registry.load();

        this.dbManager = new DatabaseManager(this.registry, this.config.database.flushIntervalMs);
        this.bridge = new EventBridge();

        // Initialize agent registration store
        this.registrationStore = new AgentRegistrationStore(this.options.resourcesDir);

        // Initialize credential store
        const credentialStore = new CredentialStore(seraHome);

        // Initialize benchmark store
        this.benchmarkStore = new BenchmarkStore(seraHome);

        // Initialize agent executor
        const agentExecutor = new AgentExecutor(credentialStore, this.registrationStore);

        this.wsApi = new WebSocketAPI(this.dbManager, this.registry, this.bridge);
        this.restApi = new RestAPI(
            this.registry, this.dbManager,
            () => this.wsApi.getClientCount(),
            this.registrationStore,
            credentialStore,
            this.benchmarkStore,
            agentExecutor,
        );

        // Initialize MCP server with handlers
        this.mcpServer = new MCPServer(this.dbManager, this.registry, this.bridge);
        this.registerMcpHandlers();

        // Testnet mode: spin up a separate debug MCP server with event recording
        if (this.options.testnet) {
            this.logBuffer = new LogBuffer();
            this.bridge.enableRecording();

            // Debug tools go on their own MCPServer instance (separate port)
            this.debugMcpServer = new MCPServer(this.dbManager, this.registry, this.bridge);
            this.debugMcpServer.registerHandler(new DebugHandler(
                this.logBuffer,
                this.bridge,
                () => this.mcpServer.getSessionList(),
            ));
            console.log('[sera-core] Testnet mode: debug MCP server configured, event recording on');
        }
    }

    /**
     * Register all portable MCP handlers
     */
    private registerMcpHandlers(): void {
        this.mcpServer.registerHandler(new CoreHandler(
            () => this.mcpServer.getActiveSessionCount()
        ));
        this.mcpServer.registerHandler(new QuizHandler());
        this.mcpServer.registerHandler(new TestCoverageHandler());
        this.mcpServer.registerHandler(new NotepadHandler());
        this.mcpServer.registerHandler(new StatsHandler());
        this.mcpServer.registerHandler(new TraceHandler());
        this.mcpServer.registerHandler(new AgentHandler(this.registrationStore));

        console.log('[sera-core] MCP handlers registered');
    }

    /**
     * Start the sera-core daemon
     */
    async start(): Promise<void> {
        // Initialize benchmark store (async - needs sql.js WASM)
        await this.benchmarkStore.initialize();

        const app = express();

        // CORS - allow editor dev server and other local origins
        app.use((_req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
            next();
        });

        app.use(express.json());
        app.use(this.restApi.getRouter());

        this.server = http.createServer(app);
        this.wsApi.attach(this.server);

        // Start client WebSocket + REST server
        await new Promise<void>((resolve) => {
            this.server.listen(this.config.ports.client, () => {
                console.log(`[sera-core] Client server started on port ${this.config.ports.client}`);
                console.log(`[sera-core] REST API: http://localhost:${this.config.ports.client}/api/health`);
                console.log(`[sera-core] WebSocket: ws://localhost:${this.config.ports.client}`);
                console.log(`[sera-core] Registered audits: ${this.registry.listAudits().length}`);
                resolve();
            });
        });

        // Start MCP server on separate port
        await this.mcpServer.start(this.config.ports.mcp);
        console.log(`[sera-core] MCP server: http://localhost:${this.config.ports.mcp}/mcp`);

        // Start debug MCP server on its own port (testnet mode only)
        if (this.debugMcpServer) {
            const debugPort = this.options.debugPort ?? (this.config.ports.mcp + 1);
            await this.debugMcpServer.start(debugPort);
            console.log(`[sera-core] Debug MCP server: http://localhost:${debugPort}/mcp`);
        }

        // Start periodic session cleanup
        this.cleanupTimer = setInterval(() => {
            this.mcpServer.cleanupStaleSessions(90_000);
        }, 30_000);
    }

    /**
     * Get the effective client port (useful for tests with random ports)
     */
    getClientPort(): number {
        return this.config.ports.client;
    }

    /**
     * Get the effective MCP port (useful for tests with random ports)
     */
    getMcpPort(): number {
        return this.config.ports.mcp;
    }

    /**
     * Get the effective debug MCP port (testnet mode only)
     */
    getDebugPort(): number {
        return this.options.debugPort ?? (this.config.ports.mcp + 1);
    }

    /**
     * Whether this instance is running in testnet mode
     */
    isTestnet(): boolean {
        return this.options.testnet === true;
    }

    /**
     * Get the log buffer (testnet mode only)
     */
    getLogBuffer(): LogBuffer | undefined {
        return this.logBuffer;
    }

    /**
     * Get the event bridge (for test access to recorded events)
     */
    getEventBridge(): EventBridge {
        return this.bridge;
    }

    /**
     * Stop the sera-core daemon gracefully
     */
    async stop(): Promise<void> {
        console.log('[sera-core] Shutting down...');

        // Clear periodic cleanup timer
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }

        // Stop MCP server
        await this.mcpServer.stop();

        // Stop debug MCP server
        if (this.debugMcpServer) {
            await this.debugMcpServer.stop();
        }

        // Close WebSocket connections
        this.wsApi.shutdown();

        // Shut down benchmark store
        await this.benchmarkStore.shutdown();

        // Shut down all database engines
        await this.dbManager.shutdownAll();

        // Close HTTP server
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log('[sera-core] Server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    const core = new SeraCore();

    // Handle shutdown signals
    const shutdown = async () => {
        await core.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Prevent crashes from unhandled errors - log and continue
    process.on('uncaughtException', (err) => {
        console.error('[sera-core] Uncaught exception (process stays alive):', err.message);
        console.error(err.stack);
    });
    process.on('unhandledRejection', (reason) => {
        console.error('[sera-core] Unhandled rejection (process stays alive):', reason);
    });

    await core.start();
}

// Only run if this is the entry point (not imported)
if (require.main === module) {
    main().catch((err) => {
        console.error('[sera-core] Fatal error:', err);
        process.exit(1);
    });
}
