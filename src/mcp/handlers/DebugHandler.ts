/**
 * @fileoverview Debug MCP Handler - testnet-only inspection tools
 * @module sera-core/mcp/handlers/DebugHandler
 *
 * Provides diagnostic tools for inspecting sera-core internals during
 * testing and development. Only registered when running in testnet mode.
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
} from '@sera/types';
import { LogBuffer, LogEntry } from '../../debug/LogBuffer';
import { EventBridge, RecordedEvent } from '../../events/EventBridge';

const TOOL_DEFINITIONS: McpToolDefinition[] = [
    {
        name: 'debug_get_logs',
        description: '[Testnet] Get recent server log entries from the LogBuffer.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Max entries to return (default: 100)',
                },
                level: {
                    type: 'string',
                    enum: ['info', 'warn', 'error'],
                    description: 'Filter by log level',
                },
            },
            required: [],
        },
    },
    {
        name: 'debug_get_event_log',
        description: '[Testnet] Get recorded EventBridge events.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Max events to return (default: all)',
                },
                type: {
                    type: 'string',
                    enum: ['storage-update', 'bridge-event'],
                    description: 'Filter by event type',
                },
            },
            required: [],
        },
    },
    {
        name: 'debug_query_audit',
        description: '[Testnet] Execute raw SQL against the current audit database.',
        inputSchema: {
            type: 'object',
            properties: {
                sql: { type: 'string', description: 'SQL query to execute' },
                params: {
                    type: 'array',
                    items: {},
                    description: 'Bind parameters for the query',
                },
            },
            required: ['sql'],
        },
    },
    {
        name: 'debug_list_sessions',
        description: '[Testnet] List all active MCP sessions with agent info.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'debug_get_storage_state',
        description: '[Testnet] Dump registered tables, row counts, and dirty state for the current audit.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
];

export class DebugHandler implements PortableMcpHandler {
    private logBuffer: LogBuffer;
    private bridge: EventBridge;
    private getSessionList: () => Array<{ sessionId: string; agentType: string; agentId: string | null; auditSlug: string | null; lastHeartbeat: string }>;

    constructor(
        logBuffer: LogBuffer,
        bridge: EventBridge,
        getSessionList: () => Array<{ sessionId: string; agentType: string; agentId: string | null; auditSlug: string | null; lastHeartbeat: string }>,
    ) {
        this.logBuffer = logBuffer;
        this.bridge = bridge;
        this.getSessionList = getSessionList;
    }

    getToolDefinitions(): McpToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    async handleToolCall(toolName: string, args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> {
        switch (toolName) {
            case 'debug_get_logs':
                return this.handleGetLogs(args);
            case 'debug_get_event_log':
                return this.handleGetEventLog(args);
            case 'debug_query_audit':
                return this.handleQueryAudit(args, ctx);
            case 'debug_list_sessions':
                return this.handleListSessions();
            case 'debug_get_storage_state':
                return this.handleGetStorageState(ctx);
            default:
                throw new Error(`Unknown debug tool: ${toolName}`);
        }
    }

    private handleGetLogs(args: Record<string, unknown>): LogEntry[] {
        const limit = (args.limit as number) || 100;
        const level = args.level as string | undefined;

        let entries = this.logBuffer.getEntries(limit);
        if (level) {
            entries = entries.filter(e => e.level === level);
        }
        return entries;
    }

    private handleGetEventLog(args: Record<string, unknown>): RecordedEvent[] {
        const limit = args.limit as number | undefined;
        const type = args.type as string | undefined;

        let events = this.bridge.getRecordedEvents();
        if (type) {
            events = events.filter(e => e.type === type);
        }
        if (limit !== undefined && events.length > limit) {
            events = events.slice(-limit);
        }
        return events;
    }

    private async handleQueryAudit(args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown[]> {
        const sql = args.sql as string;
        const params = (args.params as any[]) || [];
        return ctx.db.sql(sql, params);
    }

    private handleListSessions(): unknown {
        return this.getSessionList();
    }

    private async handleGetStorageState(ctx: HandlerContext): Promise<unknown> {
        // Query sqlite_master for all tables in this audit's DB
        const tables = await ctx.db.sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );

        const state: Array<{ table: string; rowCount: number }> = [];
        for (const t of tables) {
            const countResult = await ctx.db.sql(`SELECT COUNT(*) as count FROM "${t.name}"`);
            state.push({
                table: t.name,
                rowCount: countResult[0]?.count ?? 0,
            });
        }

        return state;
    }
}
