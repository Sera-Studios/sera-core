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
import { ResourceStore } from './resources/ResourceStore';
import { VersionStore } from './versioning/VersionStore';
import { AgentExecutor } from './execution/AgentExecutor';
import { ResourceHandler } from './mcp/handlers/ResourceHandler';
import { VersionHandler } from './mcp/handlers/VersionHandler';
import { SchemaHandler } from './mcp/handlers/SchemaHandler';
import { DebugHandler } from './mcp/handlers/DebugHandler';
import { LogBuffer } from './debug/LogBuffer';
import { seedBuiltinSchemas } from './schemas/builtinSchemas';
import { createAuthMiddleware } from './api/authMiddleware';
import { configureLogging, createLogger, setCaptureCallback } from './logging/Logger';
import { MetricsCollector } from './monitoring/MetricsCollector';
import { EventLogStore } from './monitoring/EventLogStore';
import { MonitoringService } from './monitoring/MonitoringService';
import { createMetricsMiddleware } from './api/metricsMiddleware';
import { SystemHandler } from './mcp/handlers/SystemHandler';
import { FetcherRegistry } from './benchmark/DatasetFetcher';
import { ValidFindingsFetcher } from './benchmark/fetchers/ValidFindingsFetcher';

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
    private resourceStore: ResourceStore;
    private versionStore: VersionStore;
    private credentialStore: CredentialStore;
    private metricsCollector: MetricsCollector;
    private eventLogStore: EventLogStore;
    private monitoringService: MonitoringService;
    private cleanupTimer?: ReturnType<typeof setInterval>;
    private options: SeraCoreOptions;
    private logBuffer?: LogBuffer;
    private debugMcpServer?: MCPServer;

    constructor(options?: SeraCoreOptions) {
        this.options = options || {};
        const seraHome = this.options.seraHome;

        ensureSeraHome(seraHome);
        this.config = loadConfig(seraHome);

        // Configure structured logging
        configureLogging({ format: this.config.logging.format, level: this.config.logging.level });

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
        this.credentialStore = new CredentialStore(seraHome);

        // Initialize monitoring
        this.metricsCollector = new MetricsCollector();
        this.eventLogStore = new EventLogStore(seraHome);
        this.monitoringService = new MonitoringService(
            this.metricsCollector, this.config, createLogger('monitoring'),
        );

        // Initialize benchmark store
        this.benchmarkStore = new BenchmarkStore(seraHome);

        // Initialize resource store (global audit knowledge database)
        this.resourceStore = new ResourceStore(seraHome);

        // Initialize version store (agent version lineage and experiments)
        this.versionStore = new VersionStore(seraHome);

        // Initialize agent executor
        const agentExecutor = new AgentExecutor(this.credentialStore, this.registrationStore);

        this.wsApi = new WebSocketAPI(this.dbManager, this.registry, this.bridge);
        // Initialize fetcher registry for dataset imports
        const fetcherRegistry = new FetcherRegistry();
        fetcherRegistry.register(new ValidFindingsFetcher());

        this.restApi = new RestAPI(
            this.registry, this.dbManager,
            () => this.wsApi.getClientCount(),
            this.registrationStore,
            this.credentialStore,
            this.benchmarkStore,
            agentExecutor,
            this.resourceStore,
            this.versionStore,
            this.metricsCollector,
            fetcherRegistry,
        );

        // Initialize MCP server with handlers (pass config + credentialStore for auth, metricsCollector for metrics)
        this.mcpServer = new MCPServer(this.dbManager, this.registry, this.bridge, this.config, this.credentialStore, this.metricsCollector);
        this.registerMcpHandlers();

        // Testnet mode: spin up a separate debug MCP server with event recording
        if (this.options.testnet) {
            this.logBuffer = new LogBuffer();
            this.bridge.enableRecording();

            // Route structured log output to LogBuffer for debug tools
            setCaptureCallback((entry) => {
                this.logBuffer!.capture(entry.level, entry.message, entry.data);
            });

            // Debug tools go on their own MCPServer instance (separate port)
            this.debugMcpServer = new MCPServer(this.dbManager, this.registry, this.bridge, this.config, this.credentialStore, this.metricsCollector);
            this.debugMcpServer.registerHandler(new DebugHandler(
                this.logBuffer,
                this.bridge,
                () => this.mcpServer.getSessionList(),
            ));
        }
    }

    /**
     * Register all portable MCP handlers
     */
    private registerMcpHandlers(): void {
        const log = createLogger('sera-core');
        this.mcpServer.registerHandler(new CoreHandler(
            () => this.mcpServer.getActiveSessionCount()
        ));
        this.mcpServer.registerHandler(new QuizHandler());
        this.mcpServer.registerHandler(new TestCoverageHandler());
        this.mcpServer.registerHandler(new NotepadHandler());
        this.mcpServer.registerHandler(new StatsHandler());
        this.mcpServer.registerHandler(new TraceHandler());
        this.mcpServer.registerHandler(new AgentHandler(this.registrationStore));
        this.mcpServer.registerHandler(new ResourceHandler(this.resourceStore));
        this.mcpServer.registerHandler(new VersionHandler(this.versionStore, this.registrationStore));
        this.mcpServer.registerHandler(new SchemaHandler(this.resourceStore));
        this.mcpServer.registerHandler(new SystemHandler(
            this.metricsCollector,
            () => this.buildHealthData(),
        ));

        log.info('MCP handlers registered');
    }

    /**
     * Start the sera-core daemon
     */
    async start(): Promise<void> {
        const log = createLogger('sera-core');

        // Initialize async stores (need sql.js WASM)
        await this.benchmarkStore.initialize();
        this.benchmarkStore.seedDefaultCategories();
        await this.resourceStore.initialize();
        const schemaSeed = seedBuiltinSchemas(this.resourceStore);
        log.info('Built-in schemas seeded', { count: schemaSeed.seeded });
        await this.versionStore.initialize();
        await this.eventLogStore.initialize();

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
        app.use(createMetricsMiddleware(this.metricsCollector));
        app.use(createAuthMiddleware(this.config, this.credentialStore));
        app.use(this.restApi.getRouter());

        this.server = http.createServer(app);
        this.wsApi.attach(this.server);

        // Start client WebSocket + REST server
        await new Promise<void>((resolve) => {
            this.server.listen(this.config.ports.client, () => {
                log.info('Client server started', {
                    port: this.config.ports.client,
                    rest: `http://localhost:${this.config.ports.client}/api/health`,
                    ws: `ws://localhost:${this.config.ports.client}`,
                    audits: this.registry.listAudits().length,
                });
                resolve();
            });
        });

        // Start MCP server on separate port
        await this.mcpServer.start(this.config.ports.mcp);
        log.info('MCP server started', { port: this.config.ports.mcp });

        // Start debug MCP server on its own port (testnet mode only)
        if (this.debugMcpServer) {
            const debugPort = this.options.debugPort ?? (this.config.ports.mcp + 1);
            await this.debugMcpServer.start(debugPort);
            log.info('Debug MCP server started', { port: debugPort });
        }

        // Start monitoring service
        this.monitoringService.start();

        // Log server start event
        this.eventLogStore.log('server_start', {
            version: '0.1.0',
            clientPort: this.config.ports.client,
            mcpPort: this.config.ports.mcp,
        });

        // Start periodic session cleanup
        this.cleanupTimer = setInterval(() => {
            this.mcpServer.cleanupStaleSessions(90_000);
        }, 30_000);
    }

    /**
     * Build health data for the enhanced health endpoint and system_health MCP tool.
     */
    private buildHealthData(): import('./mcp/handlers/SystemHandler').HealthData {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        const summary = this.metricsCollector.getSummary(60);
        const toolCounts = this.metricsCollector.getToolCallCounts(60);

        // Sort tools by call count descending
        const topTools = Object.entries(toolCounts)
            .map(([name, calls]) => ({ name, calls }))
            .sort((a, b) => b.calls - a.calls)
            .slice(0, 10);

        const totalRequests = summary.requests.total;
        const totalErrors = summary.errors.length;
        const avgLatency = totalRequests > 0
            ? Math.round(
                Object.values(summary.requests.byPath)
                    .reduce((sum, p) => sum + p.avgLatencyMs * p.count, 0) / totalRequests * 10
              ) / 10
            : 0;

        // Dependency checks
        const checks: Record<string, unknown> = {
            database: { status: 'healthy', activeAudits: this.registry.listAudits().length },
            credentialStore: { status: 'healthy' },
        };

        try {
            const agentCount = this.registrationStore.size;
            checks.agentStore = { status: 'healthy', agentsLoaded: agentCount };
        } catch {
            checks.agentStore = { status: 'degraded' };
        }

        // Determine overall status
        const allHealthy = Object.values(checks).every(
            (c: any) => c.status === 'healthy',
        );
        const status = allHealthy ? 'healthy' : 'degraded';

        return {
            status,
            uptime,
            version: '0.1.0',
            checks,
            metrics: {
                requestsLastHour: totalRequests,
                errorsLastHour: totalErrors,
                avgLatencyMs: avgLatency,
                topTools,
            },
        };
    }

    private startTime: number = Date.now();

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
        const log = createLogger('sera-core');
        log.info('Shutting down...');

        // Stop monitoring
        this.monitoringService.stop();

        // Log shutdown event
        this.eventLogStore.log('server_stop');

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

        // Shut down global stores
        await this.benchmarkStore.shutdown();
        await this.resourceStore.shutdown();
        await this.versionStore.shutdown();
        await this.eventLogStore.shutdown();

        // Shut down all database engines
        await this.dbManager.shutdownAll();

        // Close HTTP server
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    log.info('Server stopped');
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
    const processLog = createLogger('sera-core');
    process.on('uncaughtException', (err) => {
        processLog.error('Uncaught exception (process stays alive)', { message: err.message, stack: err.stack });
    });
    process.on('unhandledRejection', (reason) => {
        processLog.error('Unhandled rejection (process stays alive)', { reason: String(reason) });
    });

    await core.start();
}

// Only run if this is the entry point (not imported)
if (require.main === module) {
    main().catch((err) => {
        const fatalLog = createLogger('sera-core');
        fatalLog.error('Fatal error', { error: String(err) });
        process.exit(1);
    });
}
