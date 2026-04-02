/**
 * @fileoverview Unit tests for CoreHandler
 *
 * Tests all 5 tools: heartbeat, log_conversation_summary,
 * log_prompt, submit_contract_map, submit_flow_diagram.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CoreHandler } from './CoreHandler';
import { HandlerContext } from '@sera/types';

// ============================================================================
// Mock database
// ============================================================================

interface MockRow {
    [key: string]: unknown;
}

function buildMockContext(): {
    ctx: HandlerContext;
    tables: Record<string, MockRow[]>;
} {
    const tables: Record<string, MockRow[]> = {
        sessionbridge_heartbeats: [],
        sessionbridge_claude_sessions: [],
        sessionbridge_claude_conversation_log: [],
        sessionbridge_ai_prompts: [],
        sessionbridge_visualizations: [],
    };

    const ctx: HandlerContext = {
        auditSlug: 'test-audit',
        sessionId: 'ctx-session-1',
        agentType: 'hunter',
        workspacePath: '/tmp',
        db: {
            write: async (_appletId: string, tableName: string, row: Record<string, unknown>) => {
                const fullTable = `sessionbridge_${tableName}`;
                if (!tables[fullTable]) tables[fullTable] = [];
                const existing = tables[fullTable].findIndex(r => r.id === row.id);
                if (existing >= 0) {
                    tables[fullTable][existing] = row;
                } else {
                    tables[fullTable].push(row);
                }
            },
            query: async () => [],
            sql: async (query: string, params: unknown[]) => {
                if (query.includes('sessionbridge_claude_sessions') && query.includes('sessionId = ?')) {
                    const sessionId = params[0];
                    return tables.sessionbridge_claude_sessions.filter(r => r.sessionId === sessionId);
                }
                return [];
            },
            delete: async () => 0,
        },
        bridge: {
            emit: () => {},
            broadcastStorageUpdate: () => {},
        },
    };

    return { ctx, tables };
}

// ============================================================================
// Tests
// ============================================================================

describe('CoreHandler', () => {
    let handler: CoreHandler;
    let activeCount: number;

    beforeEach(() => {
        activeCount = 3;
        handler = new CoreHandler(() => activeCount);
    });

    // ========================================================================
    // Tool definitions
    // ========================================================================

    it('returns 5 tool definitions', () => {
        const tools = handler.getToolDefinitions();
        expect(tools).toHaveLength(5);
        const names = tools.map(t => t.name);
        expect(names).toContain('heartbeat');
        expect(names).toContain('log_conversation_summary');
        expect(names).toContain('log_prompt');
        expect(names).toContain('submit_contract_map');
        expect(names).toContain('submit_flow_diagram');
    });

    it('declares required table schemas', () => {
        const schemas = handler.getRequiredTableSchemas();
        expect(schemas).toHaveLength(1);
        expect(schemas[0].appletId).toBe('sessionbridge');
        expect(schemas[0].schemas.length).toBe(5);
    });

    it('rejects unknown tool names', async () => {
        const { ctx } = buildMockContext();
        await expect(handler.handleToolCall('unknown_tool', {}, ctx))
            .rejects.toThrow('Unknown core tool');
    });

    // ========================================================================
    // heartbeat
    // ========================================================================

    describe('heartbeat', () => {
        it('creates new session on first heartbeat', async () => {
            const { ctx, tables } = buildMockContext();

            const result = await handler.handleToolCall('heartbeat', {
                session_id: 'session-abc',
                agent_type: 'hunter',
            }, ctx) as { status: string; session_active: boolean; connected_agents: number };

            expect(result.status).toBe('ok');
            expect(result.session_active).toBe(true);
            expect(result.connected_agents).toBe(3);
            expect(tables.sessionbridge_claude_sessions).toHaveLength(1);
            expect(tables.sessionbridge_claude_sessions[0].sessionId).toBe('session-abc');
            expect(tables.sessionbridge_claude_sessions[0].agentType).toBe('hunter');
            expect(tables.sessionbridge_heartbeats).toHaveLength(1);
        });

        it('updates existing session on subsequent heartbeats', async () => {
            const { ctx, tables } = buildMockContext();

            // Create initial session
            tables.sessionbridge_claude_sessions.push({
                id: 1,
                sessionId: 'session-abc',
                agentType: 'hunter',
                startedAt: '2025-01-01T00:00:00Z',
                lastHeartbeat: '2025-01-01T00:00:00Z',
                promptCount: 5,
                totalTokens: 1000,
            });

            const result = await handler.handleToolCall('heartbeat', {
                session_id: 'session-abc',
                agent_type: 'hunter',
            }, ctx) as { status: string };

            expect(result.status).toBe('ok');
            // Session should be updated, not duplicated
            expect(tables.sessionbridge_claude_sessions).toHaveLength(1);
            // Last heartbeat should be updated
            expect(tables.sessionbridge_claude_sessions[0].lastHeartbeat).not.toBe('2025-01-01T00:00:00Z');
        });

        it('returns active session count from callback', async () => {
            const { ctx } = buildMockContext();
            activeCount = 7;

            const result = await handler.handleToolCall('heartbeat', {
                session_id: 'session-xyz',
                agent_type: 'tester',
            }, ctx) as { connected_agents: number };

            expect(result.connected_agents).toBe(7);
        });
    });

    // ========================================================================
    // log_conversation_summary
    // ========================================================================

    describe('log_conversation_summary', () => {
        it('writes conversation log entry', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('log_conversation_summary', {
                summary: 'Analyzed Vault.sol for reentrancy',
                prompt_count: 3,
                tokens_used: 5000,
            }, ctx);

            expect(tables.sessionbridge_claude_conversation_log).toHaveLength(1);
            const entry = tables.sessionbridge_claude_conversation_log[0];
            expect(entry.summary).toBe('Analyzed Vault.sol for reentrancy');
            expect(entry.promptCount).toBe(3);
            expect(entry.tokensUsed).toBe(5000);
            expect(entry.sessionId).toBe('ctx-session-1');
        });
    });

    // ========================================================================
    // log_prompt
    // ========================================================================

    describe('log_prompt', () => {
        it('logs prompt with heartbeat', async () => {
            const { ctx, tables } = buildMockContext();

            const result = await handler.handleToolCall('log_prompt', {
                prompt: 'Find reentrancy bugs in Vault.sol',
                session_id: 'session-abc',
                agent_type: 'hunter',
            }, ctx) as string;

            expect(result).toMatch(/^prompt_/);
            expect(tables.sessionbridge_ai_prompts).toHaveLength(1);
            expect(tables.sessionbridge_ai_prompts[0].prompt).toBe('Find reentrancy bugs in Vault.sol');
            expect(tables.sessionbridge_ai_prompts[0].promptLength).toBe('Find reentrancy bugs in Vault.sol'.length);
            // Also creates a heartbeat
            expect(tables.sessionbridge_heartbeats).toHaveLength(1);
        });

        it('stores transcript_path when provided', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('log_prompt', {
                prompt: 'test prompt',
                session_id: 'session-abc',
                agent_type: 'gatherer',
                transcript_path: '/tmp/transcript.json',
            }, ctx);

            expect(tables.sessionbridge_ai_prompts[0].transcriptPath).toBe('/tmp/transcript.json');
        });

        it('stores null transcript_path when not provided', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('log_prompt', {
                prompt: 'test prompt',
                session_id: 'session-abc',
                agent_type: 'hunter',
            }, ctx);

            expect(tables.sessionbridge_ai_prompts[0].transcriptPath).toBeNull();
        });
    });

    // ========================================================================
    // submit_contract_map
    // ========================================================================

    describe('submit_contract_map', () => {
        it('creates visualization and returns map_id', async () => {
            const { ctx, tables } = buildMockContext();

            const result = await handler.handleToolCall('submit_contract_map', {
                name: 'Vault Architecture',
                mermaid: 'graph TD\n  A-->B',
                contracts: ['Vault', 'Token', 'Oracle'],
                description: 'High-level contract relationships',
            }, ctx) as { map_id: string };

            expect(result.map_id).toMatch(/^map_/);
            expect(tables.sessionbridge_visualizations).toHaveLength(1);
            const viz = tables.sessionbridge_visualizations[0];
            expect(viz.vizType).toBe('contract_map');
            expect(viz.name).toBe('Vault Architecture');
            expect(viz.mermaid).toBe('graph TD\n  A-->B');
            expect(JSON.parse(viz.metadata as string).contracts).toEqual(['Vault', 'Token', 'Oracle']);
        });
    });

    // ========================================================================
    // submit_flow_diagram
    // ========================================================================

    describe('submit_flow_diagram', () => {
        it('creates visualization and returns diagram_id', async () => {
            const { ctx, tables } = buildMockContext();

            const result = await handler.handleToolCall('submit_flow_diagram', {
                flow_name: 'Deposit Flow',
                mermaid: 'sequenceDiagram\n  User->>Vault: deposit()',
                entry_points: ['deposit', 'depositETH'],
                critical_paths: ['deposit -> _validate -> _transfer'],
            }, ctx) as { diagram_id: string };

            expect(result.diagram_id).toMatch(/^diagram_/);
            expect(tables.sessionbridge_visualizations).toHaveLength(1);
            const viz = tables.sessionbridge_visualizations[0];
            expect(viz.vizType).toBe('flow_diagram');
            expect(viz.name).toBe('Deposit Flow');
            const meta = JSON.parse(viz.metadata as string);
            expect(meta.entry_points).toEqual(['deposit', 'depositETH']);
            expect(meta.critical_paths).toEqual(['deposit -> _validate -> _transfer']);
        });
    });
});
