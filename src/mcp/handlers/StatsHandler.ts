/**
 * @fileoverview Stats MCP Handler (servlet) for sera-core
 * @module sera-core/mcp/handlers/StatsHandler
 *
 * Handles session tracking, aggregate stats, and intervention records.
 * Pure database operations - no VS Code dependencies.
 * The extension's StatsApplet reacts to storage:update events to
 * refresh dashboard and session state.
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
    TableSchema,
} from '@sera/types';
import { createLogger } from '../../logging/Logger';

const log = createLogger('stats-handler');

// ============================================================================
// TABLE SCHEMAS
// ============================================================================

const STATS_SCHEMA: TableSchema = {
    name: 'stats',
    fields: [
        { name: 'id', type: 'INTEGER', primaryKey: true, required: true, defaultValue: 1 },
        { name: 'totalTime', type: 'INTEGER', required: true, defaultValue: 0 },
        { name: 'totalPoints', type: 'INTEGER', required: true, defaultValue: 0 },
        { name: 'nonce', type: 'INTEGER', required: true, defaultValue: 0 },
    ],
};

const SESSION_SCHEMA: TableSchema = {
    name: 'session',
    version: '2',
    fields: [
        { name: 'nonce', type: 'INTEGER', primaryKey: true, required: true },
        { name: 'startTime', type: 'INTEGER', required: true },
        { name: 'lastActivityTime', type: 'INTEGER', required: false, defaultValue: 0 },
        { name: 'duration', type: 'INTEGER', required: true, defaultValue: 0 },
        { name: 'points', type: 'INTEGER', required: true, defaultValue: 0 },
        { name: 'peakMultiplier', type: 'REAL', required: true, defaultValue: 1.0 },
        { name: 'idle', type: 'INTEGER', required: true, defaultValue: 0 },
        { name: 'metadata', type: 'TEXT', required: false },
    ],
    indexes: [
        { fields: ['nonce'], unique: true },
    ],
};

const INTERVENTION_SCHEMA: TableSchema = {
    name: 'intervention',
    fields: [
        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
        { name: 'sessionNonce', type: 'INTEGER', required: true },
        { name: 'strategyId', type: 'TEXT', required: true },
        { name: 'strategyName', type: 'TEXT', required: true },
        { name: 'triggeredAt', type: 'INTEGER', required: true },
        { name: 'outcome', type: 'TEXT', required: true },
        { name: 'extensionDurationSec', type: 'INTEGER', required: false },
        { name: 'contextSnapshot', type: 'TEXT', required: true },
        { name: 'strategyMetadata', type: 'TEXT', required: false },
    ],
    indexes: [
        { fields: ['sessionNonce'] },
        { fields: ['strategyId'] },
        { fields: ['outcome'] },
    ],
};

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOL_DEFINITIONS: McpToolDefinition[] = [
    {
        name: 'save_stats',
        description: 'Update the aggregate stats row (total time, points, session nonce).',
        inputSchema: {
            type: 'object',
            properties: {
                totalTime: { type: 'number', description: 'Total audit time in milliseconds' },
                totalPoints: { type: 'number', description: 'Total accumulated points' },
                nonce: { type: 'number', description: 'Current session nonce' },
            },
            required: ['totalTime', 'totalPoints', 'nonce'],
        },
    },
    {
        name: 'get_stats',
        description: 'Query current aggregate stats (total time, points, session nonce).',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'save_session',
        description: 'Write a completed session record.',
        inputSchema: {
            type: 'object',
            properties: {
                nonce: { type: 'number', description: 'Session nonce (unique identifier)' },
                startTime: { type: 'number', description: 'Session start timestamp (ms)' },
                lastActivityTime: { type: 'number', description: 'Last activity timestamp (ms)' },
                duration: { type: 'number', description: 'Session duration in milliseconds' },
                points: { type: 'number', description: 'Points earned in this session' },
                peakMultiplier: { type: 'number', description: 'Peak streak multiplier reached' },
                idle: { type: 'boolean', description: 'Whether the session ended idle' },
                metadata: { type: 'string', description: 'Optional JSON metadata string' },
            },
            required: ['nonce', 'startTime', 'lastActivityTime', 'duration', 'points', 'peakMultiplier', 'idle'],
        },
    },
    {
        name: 'get_sessions',
        description: 'Query session history ordered by nonce descending.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Max number of sessions to return (default 50)' },
            },
            required: [],
        },
    },
    {
        name: 'save_intervention',
        description: 'Record an intervention outcome from a gamification strategy.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Unique intervention ID' },
                sessionNonce: { type: 'number', description: 'Session nonce when intervention occurred' },
                strategyId: { type: 'string', description: 'Strategy identifier' },
                strategyName: { type: 'string', description: 'Human-readable strategy name' },
                triggeredAt: { type: 'number', description: 'Timestamp when intervention triggered (ms)' },
                outcome: { type: 'string', enum: ['success', 'failure'], description: 'Intervention outcome' },
                extensionDurationSec: { type: 'number', description: 'Optional session extension in seconds' },
                contextSnapshot: { type: 'string', description: 'JSON snapshot of context at trigger time' },
                strategyMetadata: { type: 'string', description: 'Optional JSON strategy metadata' },
            },
            required: ['id', 'sessionNonce', 'strategyId', 'strategyName', 'triggeredAt', 'outcome', 'contextSnapshot'],
        },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class StatsHandler implements PortableMcpHandler {
    getToolDefinitions(): McpToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    getRequiredTableSchemas() {
        return [{ appletId: 'stats', schemas: [STATS_SCHEMA, SESSION_SCHEMA, INTERVENTION_SCHEMA] }];
    }

    async handleToolCall(toolName: string, args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> {
        switch (toolName) {
            case 'save_stats':
                return this.handleSaveStats(args, ctx);
            case 'get_stats':
                return this.handleGetStats(ctx);
            case 'save_session':
                return this.handleSaveSession(args, ctx);
            case 'get_sessions':
                return this.handleGetSessions(args, ctx);
            case 'save_intervention':
                return this.handleSaveIntervention(args, ctx);
            default:
                throw new Error(`Unknown stats tool: ${toolName}`);
        }
    }

    // ========================================================================
    // STATS
    // ========================================================================

    private async handleSaveStats(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ success: boolean }> {
        await ctx.db.write('stats', 'stats', {
            id: 1,
            totalTime: args.totalTime as number,
            totalPoints: args.totalPoints as number,
            nonce: args.nonce as number,
        });

        log.info('Stats saved', { totalTime: args.totalTime as number, totalPoints: args.totalPoints as number, nonce: args.nonce as number });
        return { success: true };
    }

    private async handleGetStats(
        ctx: HandlerContext
    ): Promise<{ totalTime: number; totalPoints: number; nonce: number }> {
        const rows = await ctx.db.sql(
            `SELECT * FROM stats_stats WHERE id = 1`,
            []
        );

        if (rows.length === 0) {
            return { totalTime: 0, totalPoints: 0, nonce: 0 };
        }

        const row = rows[0];
        return {
            totalTime: row.totalTime,
            totalPoints: row.totalPoints,
            nonce: row.nonce,
        };
    }

    // ========================================================================
    // SESSIONS
    // ========================================================================

    private async handleSaveSession(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ success: boolean; nonce: number }> {
        const nonce = args.nonce as number;

        await ctx.db.write('stats', 'session', {
            nonce,
            startTime: args.startTime as number,
            lastActivityTime: args.lastActivityTime as number,
            duration: args.duration as number,
            points: args.points as number,
            peakMultiplier: args.peakMultiplier as number,
            idle: (args.idle as boolean) ? 1 : 0,
            metadata: (args.metadata as string) || null,
        });

        log.info('Session saved', { nonce, duration: args.duration as number });
        return { success: true, nonce };
    }

    private async handleGetSessions(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ count: number; sessions: unknown[] }> {
        const limit = (args.limit as number) || 50;

        const sessions = await ctx.db.sql(
            `SELECT * FROM stats_session ORDER BY nonce DESC LIMIT ?`,
            [limit]
        );

        return {
            count: sessions.length,
            sessions: sessions.map((s: any) => ({
                nonce: s.nonce,
                startTime: s.startTime,
                lastActivityTime: s.lastActivityTime,
                duration: s.duration,
                points: s.points,
                peakMultiplier: s.peakMultiplier,
                idle: s.idle === 1,
                metadata: s.metadata ? s.metadata : null,
            })),
        };
    }

    // ========================================================================
    // INTERVENTIONS
    // ========================================================================

    private async handleSaveIntervention(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ success: boolean; id: string }> {
        const id = args.id as string;

        await ctx.db.write('stats', 'intervention', {
            id,
            sessionNonce: args.sessionNonce as number,
            strategyId: args.strategyId as string,
            strategyName: args.strategyName as string,
            triggeredAt: args.triggeredAt as number,
            outcome: args.outcome as string,
            extensionDurationSec: (args.extensionDurationSec as number) || null,
            contextSnapshot: args.contextSnapshot as string,
            strategyMetadata: (args.strategyMetadata as string) || null,
        });

        log.info('Intervention saved', { id, outcome: String(args.outcome) });
        return { success: true, id };
    }
}
