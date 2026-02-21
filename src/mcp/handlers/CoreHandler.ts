/**
 * @fileoverview Core MCP Handler for sera-core
 * @module sera-core/mcp/handlers/CoreHandler
 *
 * Handles session management, issue triage, and visualization tools.
 * Writes directly to the sessionbridge_* tables via HandlerContext.db.
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
    TableSchema,
} from '@sera/types';

// Table schemas matching SessionBridgeStorageIntegration
const SESSIONBRIDGE_SCHEMAS: TableSchema[] = [
    {
        name: 'claude_sessions',
        fields: [
            { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
            { name: 'sessionId', type: 'TEXT', required: true },
            { name: 'agentType', type: 'TEXT', required: true },
            { name: 'startedAt', type: 'TEXT', required: true },
            { name: 'lastHeartbeat', type: 'TEXT', required: true },
            { name: 'endedAt', type: 'TEXT', required: false },
            { name: 'promptCount', type: 'INTEGER', required: true, defaultValue: 0 },
            { name: 'totalTokens', type: 'INTEGER', required: true, defaultValue: 0 },
        ],
        indexes: [
            { fields: ['sessionId'], unique: true },
            { fields: ['agentType'] },
        ],
    },
    {
        name: 'claude_conversation_log',
        fields: [
            { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
            { name: 'sessionId', type: 'TEXT', required: true },
            { name: 'summary', type: 'TEXT', required: true },
            { name: 'promptCount', type: 'INTEGER', required: true },
            { name: 'tokensUsed', type: 'INTEGER', required: true },
            { name: 'timestamp', type: 'TEXT', required: true },
        ],
        indexes: [{ fields: ['sessionId'] }, { fields: ['timestamp'] }],
    },
    {
        name: 'heartbeats',
        fields: [
            { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
            { name: 'source', type: 'TEXT', required: true },
            { name: 'agentType', type: 'TEXT', required: false },
            { name: 'timestamp', type: 'TEXT', required: true },
        ],
        indexes: [{ fields: ['source'] }, { fields: ['timestamp'] }],
    },
    {
        name: 'visualizations',
        fields: [
            { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
            { name: 'vizId', type: 'TEXT', required: true },
            { name: 'sessionId', type: 'TEXT', required: true },
            { name: 'vizType', type: 'TEXT', required: true },
            { name: 'name', type: 'TEXT', required: true },
            { name: 'mermaid', type: 'TEXT', required: true },
            { name: 'metadata', type: 'TEXT', required: false },
            { name: 'description', type: 'TEXT', required: false },
            { name: 'createdAt', type: 'TEXT', required: true },
        ],
        indexes: [
            { fields: ['vizId'], unique: true },
            { fields: ['sessionId'] },
            { fields: ['vizType'] },
        ],
    },
    {
        name: 'ai_prompts',
        fields: [
            { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
            { name: 'promptId', type: 'TEXT', required: true },
            { name: 'sessionId', type: 'TEXT', required: true },
            { name: 'statsSessionId', type: 'TEXT', required: false },
            { name: 'agentType', type: 'TEXT', required: true },
            { name: 'prompt', type: 'TEXT', required: true },
            { name: 'promptLength', type: 'INTEGER', required: true },
            { name: 'timestamp', type: 'TEXT', required: true },
            { name: 'transcriptPath', type: 'TEXT', required: false },
        ],
        indexes: [
            { fields: ['promptId'], unique: true },
            { fields: ['sessionId'] },
            { fields: ['timestamp'] },
            { fields: ['agentType'] },
        ],
    },
];

// Tool definitions (matching extension's CORE_TOOLS, HUNTER_TOOLS, VISUALIZER_TOOLS)
const TOOL_DEFINITIONS: McpToolDefinition[] = [
    {
        name: 'heartbeat',
        description: 'Keep the audit session alive. Call every 30 seconds.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_type: { type: 'string', enum: ['hunter', 'tester', 'visualizer'], description: 'Agent type' },
                session_id: { type: 'string', description: 'Unique session ID' },
            },
            required: ['agent_type', 'session_id'],
        },
    },
    {
        name: 'log_conversation_summary',
        description: 'Log a summary of recent conversation.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string' },
                prompt_count: { type: 'number' },
                tokens_used: { type: 'number' },
            },
            required: ['summary', 'prompt_count', 'tokens_used'],
        },
    },
    {
        name: 'log_prompt',
        description: 'Log a user prompt for tracking.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string' },
                session_id: { type: 'string' },
                agent_type: { type: 'string', enum: ['hunter', 'gatherer', 'alchemist', 'visualizer'] },
                transcript_path: { type: 'string' },
            },
            required: ['prompt', 'session_id', 'agent_type'],
        },
    },
    {
        name: 'submit_contract_map',
        description: 'Submit a contract relationship visualization.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                mermaid: { type: 'string' },
                contracts: { type: 'array', items: { type: 'string' } },
                description: { type: 'string' },
            },
            required: ['name', 'mermaid', 'contracts', 'description'],
        },
    },
    {
        name: 'submit_flow_diagram',
        description: 'Submit a specific flow diagram.',
        inputSchema: {
            type: 'object',
            properties: {
                flow_name: { type: 'string' },
                mermaid: { type: 'string' },
                entry_points: { type: 'array', items: { type: 'string' } },
                critical_paths: { type: 'array', items: { type: 'string' } },
            },
            required: ['flow_name', 'mermaid', 'entry_points', 'critical_paths'],
        },
    },
];

/**
 * The getActiveSessionCount callback type
 */
type GetActiveSessionCount = () => number;

export class CoreHandler implements PortableMcpHandler {
    private getActiveSessionCount: GetActiveSessionCount;

    constructor(getActiveSessionCount: GetActiveSessionCount) {
        this.getActiveSessionCount = getActiveSessionCount;
    }

    getToolDefinitions(): McpToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    getRequiredTableSchemas() {
        return [{ appletId: 'sessionbridge', schemas: SESSIONBRIDGE_SCHEMAS }];
    }

    async handleToolCall(toolName: string, args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> {
        switch (toolName) {
            case 'heartbeat':
                return this.handleHeartbeat(args, ctx);
            case 'log_conversation_summary':
                return this.handleLogConversation(args, ctx);
            case 'log_prompt':
                return this.handleLogPrompt(args, ctx);
            case 'submit_contract_map':
                return this.handleSubmitContractMap(args, ctx);
            case 'submit_flow_diagram':
                return this.handleSubmitFlowDiagram(args, ctx);
            default:
                throw new Error(`Unknown core tool: ${toolName}`);
        }
    }

    // ========================================================================
    // HANDLERS
    // ========================================================================

    private async handleHeartbeat(args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> {
        const sessionId = args.session_id as string;
        const agentType = args.agent_type as string;
        const now = new Date().toISOString();

        await ctx.db.write('sessionbridge', 'heartbeats', {
            id: Date.now(),
            source: `claude-${sessionId}`,
            agentType,
            timestamp: now,
        });

        // Check if session exists
        const sessions = await ctx.db.sql(
            `SELECT * FROM sessionbridge_claude_sessions WHERE sessionId = ?`, [sessionId]
        );

        if (sessions.length === 0) {
            await ctx.db.write('sessionbridge', 'claude_sessions', {
                id: Date.now(),
                sessionId,
                agentType,
                startedAt: now,
                lastHeartbeat: now,
                promptCount: 0,
                totalTokens: 0,
            });
            console.log(`[CoreHandler] New session: ${sessionId} (${agentType})`);
        } else {
            await ctx.db.write('sessionbridge', 'claude_sessions', {
                ...sessions[0],
                lastHeartbeat: now,
            });
        }

        return {
            status: 'ok',
            session_active: true,
            connected_agents: this.getActiveSessionCount(),
        };
    }

    private async handleLogConversation(args: Record<string, unknown>, ctx: HandlerContext): Promise<void> {
        await ctx.db.write('sessionbridge', 'claude_conversation_log', {
            id: Date.now(),
            sessionId: ctx.sessionId,
            summary: args.summary as string,
            promptCount: args.prompt_count as number,
            tokensUsed: args.tokens_used as number,
            timestamp: new Date().toISOString(),
        });
    }

    private async handleLogPrompt(args: Record<string, unknown>, ctx: HandlerContext): Promise<string> {
        const promptId = `prompt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date().toISOString();

        await ctx.db.write('sessionbridge', 'heartbeats', {
            id: Date.now(),
            source: `claude-prompt-${args.agent_type}`,
            agentType: args.agent_type as string,
            timestamp: now,
        });

        await ctx.db.write('sessionbridge', 'ai_prompts', {
            id: Date.now() + 1,
            promptId,
            sessionId: args.session_id as string,
            statsSessionId: null,
            agentType: args.agent_type as string,
            prompt: args.prompt as string,
            promptLength: (args.prompt as string).length,
            timestamp: now,
            transcriptPath: (args.transcript_path as string) || null,
        });

        console.log(`[CoreHandler] Prompt logged: ${promptId} (${args.agent_type})`);
        return promptId;
    }

    private async handleSubmitContractMap(args: Record<string, unknown>, ctx: HandlerContext): Promise<{ map_id: string }> {
        const mapId = `map_${Date.now()}`;

        await ctx.db.write('sessionbridge', 'visualizations', {
            id: Date.now(),
            vizId: mapId,
            sessionId: ctx.sessionId,
            vizType: 'contract_map',
            name: args.name as string,
            mermaid: args.mermaid as string,
            metadata: JSON.stringify({ contracts: args.contracts }),
            description: (args.description as string) || null,
            createdAt: new Date().toISOString(),
        });

        console.log(`[CoreHandler] Contract map submitted: ${mapId}`);
        return { map_id: mapId };
    }

    private async handleSubmitFlowDiagram(args: Record<string, unknown>, ctx: HandlerContext): Promise<{ diagram_id: string }> {
        const diagramId = `diagram_${Date.now()}`;

        await ctx.db.write('sessionbridge', 'visualizations', {
            id: Date.now(),
            vizId: diagramId,
            sessionId: ctx.sessionId,
            vizType: 'flow_diagram',
            name: args.flow_name as string,
            mermaid: args.mermaid as string,
            metadata: JSON.stringify({
                entry_points: args.entry_points,
                critical_paths: args.critical_paths,
            }),
            createdAt: new Date().toISOString(),
        });

        console.log(`[CoreHandler] Flow diagram submitted: ${diagramId}`);
        return { diagram_id: diagramId };
    }
}
