/**
 * @fileoverview sera-core MCP Server - HTTP JSON-RPC endpoint for Claude Code agents
 * @module sera-core/mcp/MCPServer
 *
 * Runs on a dedicated port (default 9877). Agents connect via HTTP POST to /mcp.
 * Each agent session is tracked and mapped to an audit via the first heartbeat.
 * Tool calls are dispatched to registered PortableMcpHandlers with a per-call
 * HandlerContext providing scoped database and bridge access.
 */

import * as http from 'http';
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

interface SessionState {
    sessionId: string;
    agentType: string;
    auditSlug: string | null;
    workspacePath: string | null;
    lastHeartbeat: Date;
}

export class MCPServer {
    private httpServer?: http.Server;
    private toolRegistry: Map<string, PortableMcpHandler> = new Map();
    private sessions: Map<string, SessionState> = new Map();
    private dbManager: DatabaseManager;
    private registry: AuditRegistry;
    private bridge: EventBridge;

    /** Default audit slug used when agent doesn't specify workspace */
    private defaultAuditSlug: string | null = null;

    constructor(dbManager: DatabaseManager, registry: AuditRegistry, bridge: EventBridge) {
        this.dbManager = dbManager;
        this.registry = registry;
        this.bridge = bridge;
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
        console.log(`[MCP] Handler registered (${handler.getToolDefinitions().length} tools)`);
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
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                const url = req.url || '/';

                try {
                    if (url === '/mcp' && req.method === 'POST') {
                        await this.handleMCPRequest(req, res);
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
                    console.error('[MCP] Request error:', error);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(error) }));
                }
            });

            this.httpServer.on('error', (err) => {
                reject(err);
            });

            this.httpServer.listen(port, () => {
                console.log(`[sera-core] MCP server started on port ${port}`);
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
                    console.log('[sera-core] MCP server stopped');
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

    private async handleMCPRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
                const result = await this.handleToolCall(name, args || {});
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
     * Get all registered tool definitions
     */
    getTools(): McpToolDefinition[] {
        const allTools: McpToolDefinition[] = [];
        const seen = new Set<string>();

        for (const handler of new Set(this.toolRegistry.values())) {
            for (const tool of handler.getToolDefinitions()) {
                if (!seen.has(tool.name)) {
                    allTools.push(tool);
                    seen.add(tool.name);
                }
            }
        }

        return allTools;
    }

    /**
     * Handle a tool call. Builds HandlerContext and delegates to the registered handler.
     */
    private async handleToolCall(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        console.log(`[MCP] Tool call: ${toolName}`);

        try {
            const handler = this.toolRegistry.get(toolName);
            if (!handler) {
                return this.errorResult(`Unknown tool: ${toolName}`);
            }

            // Resolve session context
            const sessionId = (args.session_id as string) || `mcp_${Date.now()}`;
            const agentType = (args.agent_type as string) || 'hunter';

            // Track session on heartbeat
            if (toolName === 'heartbeat') {
                this.trackSession(sessionId, agentType);
            }

            // Resolve audit slug from session or default
            const session = this.sessions.get(sessionId);
            const auditSlug = session?.auditSlug || this.resolveDefaultAudit();

            if (!auditSlug) {
                return this.errorResult(
                    'No audit context. Send a heartbeat first or ensure at least one audit exists.'
                );
            }

            // Ensure table schemas are registered for this handler
            await this.ensureTablesRegistered(handler, auditSlug);

            // Build context
            const context = await this.buildContext(auditSlug, sessionId, agentType, session?.workspacePath || '');

            const result = await handler.handleToolCall(toolName, args, context);
            return this.successResult(result);
        } catch (error) {
            console.error(`[MCP] Error in tool ${toolName}:`, error);
            return this.errorResult(`Error: ${error}`);
        }
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
            };
            this.sessions.set(sessionId, session);
            console.log(`[MCP] New session: ${sessionId} (${agentType}) audit=${auditSlug}`);
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
     * Clean up stale sessions
     */
    cleanupStaleSessions(timeoutMs: number): string[] {
        const now = Date.now();
        const stale: string[] = [];

        for (const [sessionId, session] of this.sessions) {
            if (now - session.lastHeartbeat.getTime() > timeoutMs) {
                stale.push(sessionId);
                this.sessions.delete(sessionId);
                console.log(`[MCP] Session expired: ${sessionId}`);
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
        workspacePath: string
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

        return { auditSlug, sessionId, agentType, workspacePath, db, bridge };
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
