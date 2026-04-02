/**
 * @fileoverview sera-core MCP Server - HTTP JSON-RPC endpoint for Claude Code agents
 * @module sera-core/mcp/MCPServer
 *
 * Runs on a dedicated port (default 9877). Agents connect via HTTP POST to /mcp
 * or /mcp/:audit-slug for audit-scoped routing. Each agent session is tracked
 * via the register_agent tool. Tool calls are dispatched to registered
 * PortableMcpHandlers with a per-call HandlerContext providing scoped database
 * and bridge access.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import {
    McpToolDefinition,
    McpToolResult,
    McpSession,
    PortableMcpHandler,
    HandlerContext,
    HandlerDatabaseOps,
    HandlerBridgeOps,
} from '@sera/types';
import { DatabaseManager } from '../database/DatabaseManager';
import { AuditRegistry } from '../database/AuditRegistry';
import { EventBridge } from '../events/EventBridge';
import { StorageEngine } from '../database/StorageEngine';
import { SeraConfig } from '../config';
import { CredentialStore } from '../credentials/CredentialStore';
import { validateBearerAuth } from '../api/authMiddleware';
import { MetricsCollector } from '../monitoring/MetricsCollector';
import { createLogger } from '../logging/Logger';

interface SessionState {
    sessionId: string;
    agentType: string;
    auditSlug: string | null;
    workspacePath: string | null;
    lastHeartbeat: Date;
    agentId: string | null;
    agentName: string | null;
    agentVersion: string | null;
    registeredAt: Date | null;
}

/** Built-in register_agent tool definition */
const REGISTER_AGENT_TOOL: McpToolDefinition = {
    name: 'register_agent',
    description: 'Register this agent session. Call once at session start. Returns an agent_id to include in all subsequent tool calls.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_name: {
                type: 'string',
                description: 'Agent role name (e.g. "hunter", "cartographer")',
            },
            agent_version: {
                type: 'string',
                description: 'Agent version string (e.g. "0.0.1")',
            },
        },
        required: ['agent_name', 'agent_version'],
    },
};

export class MCPServer {
    private httpServer?: http.Server;
    private toolRegistry: Map<string, PortableMcpHandler> = new Map();
    private sessions: Map<string, SessionState> = new Map();
    /** Reverse lookup: agentId -> sessionId */
    private agentIdToSession: Map<string, string> = new Map();
    private dbManager: DatabaseManager;
    private registry: AuditRegistry;
    private bridge: EventBridge;
    private config?: SeraConfig;
    private credentialStore?: CredentialStore;
    private metricsCollector?: MetricsCollector;
    private log = createLogger('mcp');

    /** Default audit slug used when agent doesn't specify workspace */
    private defaultAuditSlug: string | null = null;

    constructor(
        dbManager: DatabaseManager,
        registry: AuditRegistry,
        bridge: EventBridge,
        config?: SeraConfig,
        credentialStore?: CredentialStore,
        metricsCollector?: MetricsCollector,
    ) {
        this.dbManager = dbManager;
        this.registry = registry;
        this.bridge = bridge;
        this.config = config;
        this.credentialStore = credentialStore;
        this.metricsCollector = metricsCollector;
    }

    // ========================================================================
    // HANDLER REGISTRATION
    // ========================================================================

    /**
     * Register a portable handler for its declared tools
     */
    registerHandler(handler: PortableMcpHandler): void {
        for (const tool of handler.getToolDefinitions()) {
            this.toolRegistry.set(tool.name, handler);
        }
        this.log.info('Handler registered', { tools: handler.getToolDefinitions().length });
    }

    // ========================================================================
    // SERVER LIFECYCLE
    // ========================================================================

    /**
     * Start the MCP HTTP server
     */
    async start(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.httpServer = http.createServer(async (req, res) => {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                const url = req.url || '/';

                // Auth check (skip for /health and OPTIONS)
                if (this.config && this.credentialStore && url !== '/health') {
                    const authResult = validateBearerAuth({
                        authHeader: req.headers.authorization,
                        config: this.config,
                        credentialStore: this.credentialStore,
                        remoteAddress: req.socket.remoteAddress || '',
                    });
                    if (!authResult.valid) {
                        res.writeHead(authResult.statusCode || 401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: authResult.error }));
                        return;
                    }
                }

                try {
                    // Parse URL: /mcp or /mcp/:slug
                    const mcpMatch = url.match(/^\/mcp(?:\/([a-zA-Z0-9_-]+))?$/);

                    if (mcpMatch && req.method === 'POST') {
                        const urlAuditSlug = mcpMatch[1] || null;
                        await this.handleMCPRequest(req, res, urlAuditSlug);
                    } else if (url === '/mcp/tools' && req.method === 'GET') {
                        this.handleToolsList(res);
                    } else if (url === '/health' && req.method === 'GET') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'ok',
                            service: 'sera-core-mcp',
                            port,
                            sessions: this.sessions.size,
                            tools: this.getTools().length,
                        }));
                    } else {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Not found' }));
                    }
                } catch (error) {
                    this.log.error('Request error', { error: String(error) });
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(error) }));
                }
            });

            this.httpServer.on('error', (err) => {
                reject(err);
            });

            this.httpServer.listen(port, () => {
                this.log.info('MCP server started', { port });
                resolve();
            });
        });
    }

    /**
     * Stop the MCP HTTP server
     */
    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.httpServer) {
                this.httpServer.close(() => {
                    this.log.info('MCP server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    // ========================================================================
    // JSON-RPC DISPATCH
    // ========================================================================

    /**
     * Handle an MCP JSON-RPC request
     * @param urlAuditSlug - Audit slug extracted from URL path, if present
     */
    private async handleMCPRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        urlAuditSlug: string | null
    ): Promise<void> {
        const body = await this.readBody(req);

        try {
            const request = JSON.parse(body);

            if (request.method === 'initialize') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'sera-core', version: '1.0.0' },
                    },
                }));
            } else if (request.method === 'notifications/initialized') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
            } else if (request.method === 'tools/list') {
                const tools = this.getTools();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: { tools },
                }));
            } else if (request.method === 'tools/call') {
                const { name, arguments: args } = request.params;
                const result = await this.handleToolCall(name, args || {}, urlAuditSlug);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: request.id,
                    result,
                }));
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: { code: -32601, message: `Unknown method: ${request.method}` },
                }));
            }
        } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32700, message: 'Parse error', data: String(error) },
            }));
        }
    }

    // ========================================================================
    // TOOL DISPATCH
    // ========================================================================

    /**
     * Get all registered tool definitions, plus built-in tools.
     * Injects an optional agent_id property into every tool's input schema.
     */
    getTools(): McpToolDefinition[] {
        const allTools: McpToolDefinition[] = [];
        const seen = new Set<string>();

        // Add built-in register_agent tool
        allTools.push(REGISTER_AGENT_TOOL);
        seen.add(REGISTER_AGENT_TOOL.name);

        for (const handler of new Set(this.toolRegistry.values())) {
            for (const tool of handler.getToolDefinitions()) {
                if (!seen.has(tool.name)) {
                    // Inject agent_id into every handler tool's schema
                    const augmented: McpToolDefinition = {
                        ...tool,
                        inputSchema: {
                            ...tool.inputSchema,
                            properties: {
                                ...tool.inputSchema.properties,
                                agent_id: {
                                    type: 'string',
                                    description: 'Agent ID from register_agent. Include on every call for session tracking.',
                                },
                            },
                        },
                    };
                    allTools.push(augmented);
                    seen.add(tool.name);
                }
            }
        }

        return allTools;
    }

    /**
     * Handle a tool call. Builds HandlerContext and delegates to the registered handler.
     * @param urlAuditSlug - Audit slug from URL path (takes priority over session/default)
     */
    private async handleToolCall(
        toolName: string,
        args: Record<string, unknown>,
        urlAuditSlug: string | null
    ): Promise<McpToolResult> {
        const callStart = Date.now();
        this.log.info('Tool call', { tool: toolName, ...(urlAuditSlug ? { audit: urlAuditSlug } : {}) });

        try {
            // Extract agent_id for session tracking (also passed through to handlers)
            const agentId = args.agent_id as string | undefined;
            const handlerArgs = { ...args };

            // Resolve session from agent_id
            let session: SessionState | undefined;
            if (agentId) {
                const sessionId = this.agentIdToSession.get(agentId);
                if (sessionId) {
                    session = this.sessions.get(sessionId);
                }
            }

            // Handle built-in register_agent tool
            if (toolName === 'register_agent') {
                return this.handleRegisterAgent(handlerArgs, urlAuditSlug);
            }

            // Check handler registry for all other tools
            const handler = this.toolRegistry.get(toolName);
            if (!handler) {
                return this.errorResult(`Unknown tool: ${toolName}`);
            }

            // Resolve session context (legacy fallback)
            const sessionId = (handlerArgs.session_id as string) || session?.sessionId || `mcp_${Date.now()}`;
            const agentType = session?.agentName || (handlerArgs.agent_type as string) || 'hunter';

            // Track session on heartbeat (legacy support)
            if (toolName === 'heartbeat') {
                this.trackSession(sessionId, agentType);
            }

            // Resolve audit slug: URL path > session > default
            const auditSlug = urlAuditSlug
                || session?.auditSlug
                || this.sessions.get(sessionId)?.auditSlug
                || this.resolveDefaultAudit();

            if (!auditSlug) {
                return this.errorResult(
                    'No audit context. Register via /mcp/:audit-slug or ensure at least one audit exists.'
                );
            }

            // Validate URL slug exists in registry
            if (urlAuditSlug && !this.registry.auditExists(urlAuditSlug)) {
                return this.errorResult(
                    `Unknown audit slug: ${urlAuditSlug}. Check the MCP URL in .mcp.json.`
                );
            }

            // Ensure table schemas are registered for this handler
            await this.ensureTablesRegistered(handler, auditSlug);

            // Build context with agent info if available
            const context = await this.buildContext(
                auditSlug, sessionId, agentType,
                session?.workspacePath || '',
                session?.agentId || agentId,
                session?.agentName,
                session?.agentVersion
            );

            const result = await handler.handleToolCall(toolName, handlerArgs, context);

            // Record tool call metric
            if (this.metricsCollector) {
                this.metricsCollector.record({
                    timestamp: callStart,
                    method: 'POST',
                    path: '/mcp',
                    statusCode: 200,
                    durationMs: Date.now() - callStart,
                    toolName,
                });
            }

            return this.successResult(result);
        } catch (error) {
            this.log.error('Tool call error', { tool: toolName, error: String(error) });

            // Record error metric
            if (this.metricsCollector) {
                this.metricsCollector.record({
                    timestamp: callStart,
                    method: 'POST',
                    path: '/mcp',
                    statusCode: 500,
                    durationMs: Date.now() - callStart,
                    toolName,
                });
            }

            return this.errorResult(`Error: ${error}`);
        }
    }

    // ========================================================================
    // AGENT REGISTRATION
    // ========================================================================

    /**
     * Handle the built-in register_agent tool call
     */
    private async handleRegisterAgent(
        args: Record<string, unknown>,
        urlAuditSlug: string | null
    ): Promise<McpToolResult> {
        const agentName = args.agent_name as string;
        const agentVersion = args.agent_version as string;

        if (!agentName || !agentVersion) {
            return this.errorResult('agent_name and agent_version are required.');
        }

        // Generate unique agent ID
        const shortId = crypto.randomBytes(3).toString('hex');
        const agentId = `${agentName}-${shortId}`;

        // Resolve audit slug
        const auditSlug = urlAuditSlug || this.resolveDefaultAudit();
        if (!auditSlug) {
            return this.errorResult('No audit context available. Use /mcp/:audit-slug URL.');
        }

        if (urlAuditSlug && !this.registry.auditExists(urlAuditSlug)) {
            return this.errorResult(`Unknown audit slug: ${urlAuditSlug}`);
        }

        // Create session state
        const sessionId = `agent_${agentId}`;
        const session: SessionState = {
            sessionId,
            agentType: agentName,
            auditSlug,
            workspacePath: null,
            lastHeartbeat: new Date(),
            agentId,
            agentName,
            agentVersion,
            registeredAt: new Date(),
        };

        this.sessions.set(sessionId, session);
        this.agentIdToSession.set(agentId, sessionId);

        this.log.info('Agent registered', { agentId, agentName, agentVersion, audit: auditSlug });

        // Persist to claude_sessions table for visibility
        try {
            const engine = await this.dbManager.getEngine(auditSlug);
            engine.write('sessionbridge', 'claude_sessions', {
                sessionId,
                agentType: agentName,
                startedAt: new Date().toISOString(),
                lastHeartbeat: new Date().toISOString(),
                promptCount: 0,
                totalTokens: 0,
            });
        } catch (err) {
            // Non-fatal - session still works in memory
            this.log.warn('Failed to persist agent session', { error: String(err) });
        }

        return this.successResult({
            agent_id: agentId,
            audit_slug: auditSlug,
            message: 'Registered. Include agent_id in all subsequent tool calls.',
        });
    }

    // ========================================================================
    // SESSION MANAGEMENT
    // ========================================================================

    private trackSession(sessionId: string, agentType: string): void {
        let session = this.sessions.get(sessionId);
        if (!session) {
            // Try to resolve audit from any available workspace
            const audits = this.registry.listAudits();
            const auditSlug = audits.length > 0 ? audits[0].slug : null;

            session = {
                sessionId,
                agentType,
                auditSlug,
                workspacePath: null,
                lastHeartbeat: new Date(),
                agentId: null,
                agentName: null,
                agentVersion: null,
                registeredAt: null,
            };
            this.sessions.set(sessionId, session);
            this.log.info('New session', { sessionId, agentType, audit: auditSlug });
        } else {
            session.lastHeartbeat = new Date();
        }
    }

    /**
     * Get count of active sessions
     */
    getActiveSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Get a summary list of all active sessions (for debug tools)
     */
    getSessionList(): Array<{ sessionId: string; agentType: string; agentId: string | null; auditSlug: string | null; lastHeartbeat: string }> {
        const result: Array<{ sessionId: string; agentType: string; agentId: string | null; auditSlug: string | null; lastHeartbeat: string }> = [];
        for (const [, session] of this.sessions) {
            result.push({
                sessionId: session.sessionId,
                agentType: session.agentType,
                agentId: session.agentId,
                auditSlug: session.auditSlug,
                lastHeartbeat: session.lastHeartbeat.toISOString(),
            });
        }
        return result;
    }

    /**
     * Clean up stale sessions
     */
    cleanupStaleSessions(timeoutMs: number): string[] {
        const now = Date.now();
        const stale: string[] = [];

        for (const [sessionId, session] of this.sessions) {
            if (now - session.lastHeartbeat.getTime() > timeoutMs) {
                stale.push(sessionId);
                // Clean up reverse lookup
                if (session.agentId) {
                    this.agentIdToSession.delete(session.agentId);
                }
                this.sessions.delete(sessionId);
                this.log.info('Session expired', { sessionId });
            }
        }

        return stale;
    }

    // ========================================================================
    // CONTEXT BUILDING
    // ========================================================================

    /**
     * Build a HandlerContext for a tool call
     */
    private async buildContext(
        auditSlug: string,
        sessionId: string,
        agentType: string,
        workspacePath: string,
        agentId?: string | null,
        agentName?: string | null,
        agentVersion?: string | null
    ): Promise<HandlerContext> {
        const engine = await this.dbManager.getEngine(auditSlug);

        const db: HandlerDatabaseOps = {
            write: async (appletId: string, table: string, data: Record<string, any>) => {
                engine.write(appletId, table, data);
                // Broadcast storage update to all connected WebSocket clients
                this.bridge.broadcastStorageUpdate(
                    'sera-core-mcp', auditSlug, appletId, table, 'insert', data
                );
            },
            query: async (appletId: string, table: string, filter?: Record<string, any>) => {
                return engine.query(appletId, table, filter);
            },
            sql: async (query: string, params?: any[]) => {
                return engine.sql(query, params);
            },
            delete: async (appletId: string, table: string, filter: Record<string, any>) => {
                const count = engine.delete(appletId, table, filter);
                this.bridge.broadcastStorageUpdate(
                    'sera-core-mcp', auditSlug, appletId, table, 'delete', filter
                );
                return count;
            },
        };

        const bridge: HandlerBridgeOps = {
            emit: (event: string, data: Record<string, any>) => {
                this.bridge.broadcastBridgeEvent({
                    auditSlug,
                    event,
                    data,
                    source: 'sera-core-mcp',
                    timestamp: new Date().toISOString(),
                });
            },
            broadcastStorageUpdate: (appletId: string, table: string, action: 'insert' | 'update' | 'delete', data: any) => {
                this.bridge.broadcastStorageUpdate(
                    'sera-core-mcp', auditSlug, appletId, table, action, data
                );
            },
        };

        const context: HandlerContext = { auditSlug, sessionId, agentType, workspacePath, db, bridge };
        if (agentId) { context.agentId = agentId; }
        if (agentName) { context.agentName = agentName; }
        if (agentVersion) { context.agentVersion = agentVersion; }

        return context;
    }

    /**
     * Resolve the default audit slug when no session context exists
     */
    private resolveDefaultAudit(): string | null {
        if (this.defaultAuditSlug && this.registry.auditExists(this.defaultAuditSlug)) {
            return this.defaultAuditSlug;
        }

        const audits = this.registry.listAudits();
        if (audits.length === 1) {
            this.defaultAuditSlug = audits[0].slug;
            return this.defaultAuditSlug;
        }

        return audits.length > 0 ? audits[0].slug : null;
    }

    /**
     * Ensure a handler's required table schemas are registered in the engine
     */
    private async ensureTablesRegistered(handler: PortableMcpHandler, auditSlug: string): Promise<void> {
        if (!handler.getRequiredTableSchemas) { return; }

        const engine = await this.dbManager.getEngine(auditSlug);
        const requirements = handler.getRequiredTableSchemas();

        for (const req of requirements) {
            engine.registerTables(req.appletId, req.schemas);
        }
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    private handleToolsList(res: http.ServerResponse): void {
        const tools = this.getTools();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tools }));
    }

    private successResult(data: unknown): McpToolResult {
        return {
            content: [{
                type: 'text',
                text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
            }],
        };
    }

    private errorResult(message: string): McpToolResult {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ error: message }),
            }],
            isError: true,
        };
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk; });
            req.on('end', () => resolve(body));
            req.on('error', reject);
        });
    }
}
