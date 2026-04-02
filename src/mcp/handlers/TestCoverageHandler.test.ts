/**
 * @fileoverview Unit tests for TestCoverageHandler
 *
 * Tests all 7 tools: submit_test_mapping, get_test_requests,
 * mark_test_complete, report_test_failure, get_test_mappings,
 * update_test_mapping, clear_test_mappings.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TestCoverageHandler } from './TestCoverageHandler';
import { HandlerContext } from '@sera/types';

// ============================================================================
// Mock database (in-memory table simulation)
// ============================================================================

interface MockRow {
    [key: string]: unknown;
}

function buildMockContext(): {
    ctx: HandlerContext;
    tables: Record<string, MockRow[]>;
    emitted: Array<{ event: string; data: unknown }>;
} {
    const tables: Record<string, MockRow[]> = {
        sessionbridge_test_mappings: [],
        sessionbridge_test_requests: [],
    };
    const emitted: Array<{ event: string; data: unknown }> = [];

    const ctx: HandlerContext = {
        auditSlug: 'test-audit',
        sessionId: 'session-1',
        agentType: 'hunter',
        workspacePath: '/tmp',
        db: {
            write: async (_appletId: string, tableName: string, row: Record<string, unknown>) => {
                const fullTable = `sessionbridge_${tableName}`;
                if (!tables[fullTable]) tables[fullTable] = [];
                // Upsert by id
                const existing = tables[fullTable].findIndex(r => r.id === row.id);
                if (existing >= 0) {
                    tables[fullTable][existing] = row;
                } else {
                    tables[fullTable].push(row);
                }
            },
            query: async () => [],
            sql: async (query: string, params: unknown[]) => {
                // Handle SELECT queries
                if (query.includes('SELECT COUNT(*)')) {
                    const table = query.includes('test_mappings') ? 'sessionbridge_test_mappings' : 'sessionbridge_test_requests';
                    return [{ count: tables[table]?.length || 0 }];
                }
                if (query.includes('DELETE FROM')) {
                    if (query.includes('WHERE id = ?')) {
                        const table = query.includes('test_mappings') ? 'sessionbridge_test_mappings' : 'sessionbridge_test_requests';
                        const id = params[0];
                        tables[table] = tables[table].filter(r => r.id !== id);
                    } else if (query.includes('test_mappings')) {
                        tables.sessionbridge_test_mappings = [];
                    }
                    return [];
                }
                if (query.includes('SELECT * FROM sessionbridge_test_mappings')) {
                    return [...tables.sessionbridge_test_mappings];
                }
                if (query.includes('SELECT * FROM sessionbridge_test_requests')) {
                    if (query.includes('requestId = ?')) {
                        const reqId = params[0];
                        return tables.sessionbridge_test_requests.filter(r => r.requestId === reqId);
                    }
                    if (query.includes("status = 'pending'")) {
                        return tables.sessionbridge_test_requests.filter(r => r.status === 'pending');
                    }
                    return [...tables.sessionbridge_test_requests];
                }
                return [];
            },
            delete: async () => 0,
        },
        bridge: {
            emit: (event: string, data: unknown) => { emitted.push({ event, data }); },
            broadcastStorageUpdate: () => {},
        },
    };

    return { ctx, tables, emitted };
}

// ============================================================================
// Tests
// ============================================================================

describe('TestCoverageHandler', () => {
    let handler: TestCoverageHandler;

    beforeEach(() => {
        handler = new TestCoverageHandler();
    });

    // ========================================================================
    // Tool definitions
    // ========================================================================

    it('returns 7 tool definitions', () => {
        const tools = handler.getToolDefinitions();
        expect(tools).toHaveLength(7);
        const names = tools.map(t => t.name);
        expect(names).toContain('submit_test_mapping');
        expect(names).toContain('get_test_requests');
        expect(names).toContain('mark_test_complete');
        expect(names).toContain('report_test_failure');
        expect(names).toContain('get_test_mappings');
        expect(names).toContain('update_test_mapping');
        expect(names).toContain('clear_test_mappings');
    });

    it('declares required table schemas', () => {
        const schemas = handler.getRequiredTableSchemas();
        expect(schemas).toHaveLength(1);
        expect(schemas[0].appletId).toBe('sessionbridge');
        expect(schemas[0].schemas).toHaveLength(2);
        expect(schemas[0].schemas[0].name).toBe('test_mappings');
        expect(schemas[0].schemas[1].name).toBe('test_requests');
    });

    it('rejects unknown tool names', async () => {
        const { ctx } = buildMockContext();
        await expect(handler.handleToolCall('unknown_tool', {}, ctx))
            .rejects.toThrow('Unknown test coverage tool');
    });

    // ========================================================================
    // submit_test_mapping
    // ========================================================================

    describe('submit_test_mapping', () => {
        it('creates a new mapping and returns mapping_id', async () => {
            const { ctx, tables } = buildMockContext();

            const result = await handler.handleToolCall('submit_test_mapping', {
                target_function: { file: 'Vault.sol', name: 'deposit', line: 42 },
                tests: [
                    { file: 'test/Vault.t.sol', test_name: 'test_deposit', test_type: 'happy_path', one_liner: 'deposits correctly', line: 10 },
                ],
                coverage_gaps: ['reentrancy check', 'zero amount'],
            }, ctx) as { mapping_id: string };

            expect(result.mapping_id).toMatch(/^mapping_/);
            expect(tables.sessionbridge_test_mappings).toHaveLength(1);
        });

        it('deduplicates by target function (file + name)', async () => {
            const { ctx, tables } = buildMockContext();

            // First submission
            await handler.handleToolCall('submit_test_mapping', {
                target_function: { file: 'Vault.sol', name: 'deposit', line: 42 },
                tests: [{ file: 'test.sol', test_name: 'test1', test_type: 'happy_path', one_liner: 'v1', line: 1 }],
                coverage_gaps: [],
            }, ctx);

            expect(tables.sessionbridge_test_mappings).toHaveLength(1);

            // Second submission for same function - should replace
            await handler.handleToolCall('submit_test_mapping', {
                target_function: { file: 'Vault.sol', name: 'deposit', line: 42 },
                tests: [{ file: 'test.sol', test_name: 'test2', test_type: 'negative', one_liner: 'v2', line: 5 }],
                coverage_gaps: ['new gap'],
            }, ctx);

            expect(tables.sessionbridge_test_mappings).toHaveLength(1);
        });

        it('stores coverage_gaps as null when empty', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('submit_test_mapping', {
                target_function: { file: 'Token.sol', name: 'transfer', line: 10 },
                tests: [],
                coverage_gaps: undefined,
            }, ctx);

            expect(tables.sessionbridge_test_mappings).toHaveLength(1);
            expect(tables.sessionbridge_test_mappings[0].coverageGaps).toBeNull();
        });
    });

    // ========================================================================
    // get_test_requests
    // ========================================================================

    describe('get_test_requests', () => {
        it('returns only pending requests', async () => {
            const { ctx, tables } = buildMockContext();

            tables.sessionbridge_test_requests.push(
                { requestId: 'req-1', target: 'func1', missingCases: '[]', priority: 'high', status: 'pending', createdAt: new Date().toISOString() },
                { requestId: 'req-2', target: 'func2', missingCases: '[]', priority: 'low', status: 'completed', createdAt: new Date().toISOString() },
            );

            const result = await handler.handleToolCall('get_test_requests', {}, ctx) as unknown[];
            expect(result).toHaveLength(1);
            expect((result[0] as Record<string, unknown>).requestId).toBe('req-1');
        });

        it('returns empty array when no pending requests', async () => {
            const { ctx } = buildMockContext();
            const result = await handler.handleToolCall('get_test_requests', {}, ctx) as unknown[];
            expect(result).toHaveLength(0);
        });
    });

    // ========================================================================
    // mark_test_complete
    // ========================================================================

    describe('mark_test_complete', () => {
        it('marks a pending request as completed', async () => {
            const { ctx, tables } = buildMockContext();
            tables.sessionbridge_test_requests.push({
                id: 1,
                requestId: 'req-1',
                target: 'func1',
                missingCases: '[]',
                priority: 'high',
                status: 'pending',
                createdAt: new Date().toISOString(),
            });

            const result = await handler.handleToolCall('mark_test_complete', {
                request_id: 'req-1',
                test_file: 'test/Vault.t.sol',
                cases_covered: ['reentrancy', 'zero amount'],
            }, ctx) as { success: boolean };

            expect(result.success).toBe(true);
            expect(tables.sessionbridge_test_requests[0].status).toBe('completed');
            expect(tables.sessionbridge_test_requests[0].testFile).toBe('test/Vault.t.sol');
            expect(tables.sessionbridge_test_requests[0].completedAt).toBeDefined();
        });

        it('throws when request not found', async () => {
            const { ctx } = buildMockContext();

            await expect(handler.handleToolCall('mark_test_complete', {
                request_id: 'nonexistent',
                test_file: 'test.sol',
                cases_covered: [],
            }, ctx)).rejects.toThrow('Test request not found: nonexistent');
        });
    });

    // ========================================================================
    // report_test_failure
    // ========================================================================

    describe('report_test_failure', () => {
        it('emits test:failure event via bridge', async () => {
            const { ctx, emitted } = buildMockContext();

            const result = await handler.handleToolCall('report_test_failure', {
                test_file: 'test/Vault.t.sol',
                test_name: 'test_reentrancy',
                error: 'assertion failed',
                severity: 'blocker',
            }, ctx) as { reported: boolean };

            expect(result.reported).toBe(true);
            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('test:failure');
            expect((emitted[0].data as Record<string, unknown>).testFile).toBe('test/Vault.t.sol');
            expect((emitted[0].data as Record<string, unknown>).severity).toBe('blocker');
        });
    });

    // ========================================================================
    // get_test_mappings
    // ========================================================================

    describe('get_test_mappings', () => {
        it('returns all mappings when no file filter', async () => {
            const { ctx, tables } = buildMockContext();
            tables.sessionbridge_test_mappings.push(
                {
                    id: 1,
                    mappingId: 'mapping_1',
                    sessionId: 'session-1',
                    targetFunction: JSON.stringify({ file: 'Vault.sol', name: 'deposit', line: 10 }),
                    tests: JSON.stringify([]),
                    coverageGaps: JSON.stringify(['gap1']),
                    createdAt: '2025-01-01T00:00:00Z',
                },
                {
                    id: 2,
                    mappingId: 'mapping_2',
                    sessionId: 'session-1',
                    targetFunction: JSON.stringify({ file: 'Token.sol', name: 'transfer', line: 20 }),
                    tests: JSON.stringify([]),
                    coverageGaps: null,
                    createdAt: '2025-01-02T00:00:00Z',
                },
            );

            const result = await handler.handleToolCall('get_test_mappings', {}, ctx) as unknown[];
            expect(result).toHaveLength(2);

            const first = result[0] as Record<string, unknown>;
            expect(first.mapping_id).toBe('mapping_1');
            expect((first.target_function as Record<string, unknown>).file).toBe('Vault.sol');
            expect(first.coverage_gaps).toEqual(['gap1']);
        });

        it('filters by file when provided', async () => {
            const { ctx, tables } = buildMockContext();
            tables.sessionbridge_test_mappings.push(
                {
                    id: 1,
                    mappingId: 'mapping_1',
                    sessionId: 'session-1',
                    targetFunction: JSON.stringify({ file: 'contracts/Vault.sol', name: 'deposit', line: 10 }),
                    tests: JSON.stringify([]),
                    coverageGaps: null,
                    createdAt: '2025-01-01T00:00:00Z',
                },
                {
                    id: 2,
                    mappingId: 'mapping_2',
                    sessionId: 'session-1',
                    targetFunction: JSON.stringify({ file: 'contracts/Token.sol', name: 'transfer', line: 20 }),
                    tests: JSON.stringify([]),
                    coverageGaps: null,
                    createdAt: '2025-01-02T00:00:00Z',
                },
            );

            const result = await handler.handleToolCall('get_test_mappings', { file: 'Vault.sol' }, ctx) as unknown[];
            expect(result).toHaveLength(1);
            expect((result[0] as Record<string, unknown>).mapping_id).toBe('mapping_1');
        });

        it('returns empty coverage_gaps when null', async () => {
            const { ctx, tables } = buildMockContext();
            tables.sessionbridge_test_mappings.push({
                id: 1,
                mappingId: 'mapping_1',
                sessionId: 'session-1',
                targetFunction: JSON.stringify({ file: 'Vault.sol', name: 'deposit', line: 10 }),
                tests: JSON.stringify([]),
                coverageGaps: null,
                createdAt: '2025-01-01T00:00:00Z',
            });

            const result = await handler.handleToolCall('get_test_mappings', {}, ctx) as unknown[];
            expect((result[0] as Record<string, unknown>).coverage_gaps).toEqual([]);
        });
    });

    // ========================================================================
    // update_test_mapping
    // ========================================================================

    describe('update_test_mapping', () => {
        it('delegates to submit (delete + insert)', async () => {
            const { ctx, tables } = buildMockContext();

            // Initial mapping
            tables.sessionbridge_test_mappings.push({
                id: 1,
                mappingId: 'mapping_1',
                sessionId: 'session-1',
                targetFunction: JSON.stringify({ file: 'Vault.sol', name: 'deposit', line: 10 }),
                tests: JSON.stringify([]),
                coverageGaps: null,
                createdAt: '2025-01-01T00:00:00Z',
            });

            const result = await handler.handleToolCall('update_test_mapping', {
                target_function: { file: 'Vault.sol', name: 'deposit', line: 10 },
                tests: [{ file: 'test.sol', test_name: 'test_updated', test_type: 'negative', one_liner: 'updated', line: 5 }],
                coverage_gaps: ['new gap'],
            }, ctx) as { mapping_id: string };

            expect(result.mapping_id).toMatch(/^mapping_/);
            // Old one should be deleted, new one inserted
            expect(tables.sessionbridge_test_mappings).toHaveLength(1);
        });
    });

    // ========================================================================
    // clear_test_mappings
    // ========================================================================

    describe('clear_test_mappings', () => {
        it('clears all mappings and returns count', async () => {
            const { ctx, tables } = buildMockContext();
            tables.sessionbridge_test_mappings.push(
                { id: 1, mappingId: 'mapping_1' },
                { id: 2, mappingId: 'mapping_2' },
            );

            const result = await handler.handleToolCall('clear_test_mappings', {}, ctx) as { cleared: boolean; count: number };

            expect(result.cleared).toBe(true);
            expect(result.count).toBe(2);
            expect(tables.sessionbridge_test_mappings).toHaveLength(0);
        });

        it('handles empty table', async () => {
            const { ctx } = buildMockContext();
            const result = await handler.handleToolCall('clear_test_mappings', {}, ctx) as { cleared: boolean; count: number };

            expect(result.cleared).toBe(true);
            expect(result.count).toBe(0);
        });
    });
});
