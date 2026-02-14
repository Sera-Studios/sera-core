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

export class SeraCore {
    private config: SeraConfig;
    private registry: AuditRegistry;
    private dbManager: DatabaseManager;
    private bridge: EventBridge;
    private wsApi: WebSocketAPI;
    private restApi: RestAPI;
    private mcpServer: MCPServer;
    private server!: http.Server;

    constructor() {
        ensureSeraHome();
        this.config = loadConfig();

        this.registry = new AuditRegistry();
        this.registry.load();

        this.dbManager = new DatabaseManager(this.registry, this.config.database.flushIntervalMs);
        this.bridge = new EventBridge();

        this.wsApi = new WebSocketAPI(this.dbManager, this.registry, this.bridge);
        this.restApi = new RestAPI(this.registry, this.dbManager, () => this.wsApi.getClientCount());

        // Initialize MCP server with handlers
        this.mcpServer = new MCPServer(this.dbManager, this.registry, this.bridge);
        this.registerMcpHandlers();
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

        console.log('[sera-core] MCP handlers registered');
    }

    /**
     * Start the sera-core daemon
     */
    async start(): Promise<void> {
        const app = express();
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

        // Start periodic session cleanup
        setInterval(() => {
            this.mcpServer.cleanupStaleSessions(90_000);
        }, 30_000);
    }

    /**
     * Stop the sera-core daemon gracefully
     */
    async stop(): Promise<void> {
        console.log('[sera-core] Shutting down...');

        // Stop MCP server
        await this.mcpServer.stop();

        // Close WebSocket connections
        this.wsApi.shutdown();

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

    await core.start();
}

// Only run if this is the entry point (not imported)
if (require.main === module) {
    main().catch((err) => {
        console.error('[sera-core] Fatal error:', err);
        process.exit(1);
    });
}
