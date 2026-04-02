/**
 * @fileoverview Unit tests for TraceHandler
 *
 * Tests the 5 graph traversal tools by mocking the cartography database
 * (cartography_nodes and cartography_edges tables) via HandlerContext.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TraceHandler } from './TraceHandler';
import { HandlerContext } from '@sera/types';

// ============================================================================
// Mock database builder
// ============================================================================

interface MockNode {
    nodeId: string;
    name: string;
    nodeType: string;
    repoId: string;
    data: string;
}

interface MockEdge {
    fromNodeId: string;
    toNodeId: string;
    edgeType: string;
    repoId: string;
}

function buildMockContext(nodes: MockNode[], edges: MockEdge[]): HandlerContext {
    return {
        auditSlug: 'test',
        sessionId: 'test-session',
        agentType: 'hunter',
        workspacePath: '/tmp',
        db: {
            write: async () => {},
            query: async () => [],
            delete: async () => 0,
            sql: async (query: string, params: unknown[]) => {
                // Route queries to the right mock data
                if (query.includes('cartography_edges') && query.includes('repoId')) {
                    const [repoId, edgeType] = params as string[];
                    return edges.filter(e => e.repoId === repoId && e.edgeType === edgeType);
                }
                if (query.includes('cartography_edges') && query.includes('fromNodeId')) {
                    const [nodeId, edgeType] = params as string[];
                    return edges.filter(e => e.fromNodeId === nodeId && e.edgeType === edgeType);
                }
                if (query.includes('cartography_edges') && query.includes('toNodeId')) {
                    const [nodeId, edgeType] = params as string[];
                    return edges.filter(e => e.toNodeId === nodeId && e.edgeType === edgeType);
                }
                if (query.includes('cartography_nodes') && query.includes('nodeId')) {
                    const [nodeId] = params as string[];
                    return nodes.filter(n => n.nodeId === nodeId);
                }
                if (query.includes('cartography_nodes') && query.includes('repoId') && query.includes('nodeType')) {
                    const [repoId, nodeType] = params as string[];
                    return nodes.filter(n => n.repoId === repoId && n.nodeType === nodeType);
                }
                return [];
            },
        },
        bridge: {
            emit: () => {},
            broadcastStorageUpdate: () => {},
        },
    };
}

// ============================================================================
// Test data factory
// ============================================================================

function makeContractNode(repoId: string, contractId: string, contractName: string, filePath: string): MockNode {
    return {
        nodeId: contractId,
        name: contractName,
        nodeType: 'contract',
        repoId,
        data: JSON.stringify({ path: filePath }),
    };
}

function makeFuncNode(
    repoId: string,
    funcId: string,
    funcName: string,
    contractId: string,
    lines: [number, number] = [10, 20]
): MockNode {
    return {
        nodeId: funcId,
        name: funcName,
        nodeType: 'function',
        repoId,
        data: JSON.stringify({ contractId, lines }),
    };
}

function makeStateVarNode(repoId: string, varId: string, varName: string): MockNode {
    return {
        nodeId: varId,
        name: varName,
        nodeType: 'statevar',
        repoId,
        data: '{}',
    };
}

function makeCallEdge(repoId: string, from: string, to: string, type: 'CALLS_INTERNAL' | 'CALLS_EXTERNAL' = 'CALLS_INTERNAL'): MockEdge {
    return { fromNodeId: from, toNodeId: to, edgeType: type, repoId };
}

function makeAccessEdge(repoId: string, funcId: string, varId: string, type: 'READS' | 'WRITES'): MockEdge {
    return { fromNodeId: funcId, toNodeId: varId, edgeType: type, repoId };
}

// ============================================================================
// Standard test graph
// ============================================================================

const REPO = 'repo-1';

// A -> B -> C -> D (linear chain)
// A -> E (branch)
// E -> D (converge)
function standardGraph() {
    const contractNode = makeContractNode(REPO, 'contract_Vault', 'Vault', 'contracts/Vault.sol');
    const contractNode2 = makeContractNode(REPO, 'contract_Token', 'Token', 'contracts/Token.sol');

    const nodes: MockNode[] = [
        contractNode,
        contractNode2,
        makeFuncNode(REPO, 'func_Vault_deposit', 'deposit', 'contract_Vault', [10, 30]),
        makeFuncNode(REPO, 'func_Vault_withdraw', 'withdraw', 'contract_Vault', [32, 50]),
        makeFuncNode(REPO, 'func_Vault__transfer', '_transfer', 'contract_Vault', [52, 60]),
        makeFuncNode(REPO, 'func_Vault__validate', '_validate', 'contract_Vault', [62, 70]),
        makeFuncNode(REPO, 'func_Token_mint', 'mint', 'contract_Token', [10, 25]),
    ];

    const edges: MockEdge[] = [
        // deposit -> withdraw -> _transfer -> mint (linear)
        makeCallEdge(REPO, 'func_Vault_deposit', 'func_Vault_withdraw'),
        makeCallEdge(REPO, 'func_Vault_withdraw', 'func_Vault__transfer'),
        makeCallEdge(REPO, 'func_Vault__transfer', 'func_Token_mint', 'CALLS_EXTERNAL'),
        // deposit -> _validate (branch)
        makeCallEdge(REPO, 'func_Vault_deposit', 'func_Vault__validate'),
        // _validate -> mint (converge)
        makeCallEdge(REPO, 'func_Vault__validate', 'func_Token_mint', 'CALLS_EXTERNAL'),
    ];

    return { nodes, edges };
}

// ============================================================================
// Tests
// ============================================================================

describe('TraceHandler', () => {
    let handler: TraceHandler;

    beforeEach(() => {
        handler = new TraceHandler();
    });

    // ========================================================================
    // getToolDefinitions
    // ========================================================================

    it('returns 5 tool definitions', () => {
        const tools = handler.getToolDefinitions();
        expect(tools).toHaveLength(5);
        const names = tools.map(t => t.name);
        expect(names).toContain('trace_calls_to');
        expect(names).toContain('trace_calls_from');
        expect(names).toContain('trace_interacting_functions');
        expect(names).toContain('trace_read_slot');
        expect(names).toContain('trace_write_slot');
    });

    it('rejects unknown tool names', async () => {
        const { nodes, edges } = standardGraph();
        const ctx = buildMockContext(nodes, edges);
        await expect(handler.handleToolCall('unknown_tool', {}, ctx))
            .rejects.toThrow('Unknown trace tool');
    });

    // ========================================================================
    // trace_calls_to (reverse BFS)
    // ========================================================================

    describe('trace_calls_to', () => {
        it('finds paths from entry points to target', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_to', {
                repo_id: REPO,
                function_id: 'func_Token_mint',
            }, ctx) as string;

            // Should find paths to mint
            expect(result).toContain('trace_calls_to');
            expect(result).toContain('mint');
            // deposit is an entry point (no callers)
            expect(result).toContain('deposit');
        });

        it('returns single-node path for an entry point (no callers)', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_to', {
                repo_id: REPO,
                function_id: 'func_Vault_deposit',
            }, ctx) as string;

            // Entry point itself forms a path of length 1
            expect(result).toContain('Paths (1)');
            expect(result).toContain('deposit');
        });

        it('throws when function not found', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            await expect(handler.handleToolCall('trace_calls_to', {
                repo_id: REPO,
                function_id: 'nonexistent',
            }, ctx)).rejects.toThrow('Function not found');
        });

        it('respects max_depth limit', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_to', {
                repo_id: REPO,
                function_id: 'func_Token_mint',
                max_depth: 1,
            }, ctx) as string;

            // With depth 1, can only go one hop back from mint
            expect(result).toContain('trace_calls_to');
        });

        it('respects max_paths limit', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_to', {
                repo_id: REPO,
                function_id: 'func_Token_mint',
                max_paths: 1,
            }, ctx) as string;

            expect(result).toContain('truncated');
        });

        it('handles cycle in call graph without infinite loop', async () => {
            const nodes: MockNode[] = [
                makeContractNode(REPO, 'contract_A', 'A', 'A.sol'),
                makeFuncNode(REPO, 'func_A_foo', 'foo', 'contract_A'),
                makeFuncNode(REPO, 'func_A_bar', 'bar', 'contract_A'),
            ];
            const edges: MockEdge[] = [
                makeCallEdge(REPO, 'func_A_foo', 'func_A_bar'),
                makeCallEdge(REPO, 'func_A_bar', 'func_A_foo'), // cycle
            ];
            const ctx = buildMockContext(nodes, edges);

            // Should not hang, cycle detection should prevent infinite loop
            const result = await handler.handleToolCall('trace_calls_to', {
                repo_id: REPO,
                function_id: 'func_A_bar',
            }, ctx) as string;

            expect(result).toContain('trace_calls_to');
        });

        it('caps max_depth at 20', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            // Should not throw with a very high depth - it gets capped
            const result = await handler.handleToolCall('trace_calls_to', {
                repo_id: REPO,
                function_id: 'func_Token_mint',
                max_depth: 100,
            }, ctx) as string;

            expect(result).toContain('trace_calls_to');
        });
    });

    // ========================================================================
    // trace_calls_from (forward DFS)
    // ========================================================================

    describe('trace_calls_from', () => {
        it('finds all reachable functions from source', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_Vault_deposit',
            }, ctx) as string;

            expect(result).toContain('trace_calls_from');
            expect(result).toContain('deposit');
            // Should reach withdraw, _transfer, _validate, mint
            expect(result).toContain('withdraw');
            expect(result).toContain('_transfer');
            expect(result).toContain('mint');
            expect(result).toContain('_validate');
            expect(result).toContain('4 functions');
        });

        it('returns empty tree for leaf function', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_Token_mint',
            }, ctx) as string;

            expect(result).toContain('0 functions');
        });

        it('throws when function not found', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            await expect(handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'nonexistent',
            }, ctx)).rejects.toThrow('Function not found');
        });

        it('respects max_depth', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_Vault_deposit',
                max_depth: 1,
            }, ctx) as string;

            // Depth 1 from deposit: withdraw and _validate only
            expect(result).toContain('withdraw');
            expect(result).toContain('_validate');
        });

        it('handles cycle in call graph without infinite loop', async () => {
            const nodes: MockNode[] = [
                makeContractNode(REPO, 'contract_A', 'A', 'A.sol'),
                makeFuncNode(REPO, 'func_A_foo', 'foo', 'contract_A'),
                makeFuncNode(REPO, 'func_A_bar', 'bar', 'contract_A'),
            ];
            const edges: MockEdge[] = [
                makeCallEdge(REPO, 'func_A_foo', 'func_A_bar'),
                makeCallEdge(REPO, 'func_A_bar', 'func_A_foo'), // cycle
            ];
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_A_foo',
            }, ctx) as string;

            expect(result).toContain('trace_calls_from');
            expect(result).toContain('1 function');
        });

        it('marks external calls in output', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_Vault__transfer',
            }, ctx) as string;

            // mint is in Token (external to Vault)
            expect(result).toContain('[external]');
        });
    });

    // ========================================================================
    // trace_interacting_functions
    // ========================================================================

    describe('trace_interacting_functions', () => {
        it('returns callers and callees', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_interacting_functions', {
                repo_id: REPO,
                function_id: 'func_Vault_withdraw',
            }, ctx) as string;

            expect(result).toContain('Callers');
            expect(result).toContain('deposit');  // caller
            expect(result).toContain('Callees');
            expect(result).toContain('_transfer'); // callee
        });

        it('returns (none) for functions with no callers', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_interacting_functions', {
                repo_id: REPO,
                function_id: 'func_Vault_deposit',
            }, ctx) as string;

            expect(result).toContain('### Callers');
            expect(result).toContain('(none)');
        });

        it('returns (none) for functions with no callees', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_interacting_functions', {
                repo_id: REPO,
                function_id: 'func_Token_mint',
            }, ctx) as string;

            expect(result).toContain('### Callees');
            expect(result).toContain('(none)');
        });

        it('includes state access when requested', async () => {
            const stateVarNode = makeStateVarNode(REPO, 'var_Vault_balance', 'balance');
            const { nodes, edges } = standardGraph();
            nodes.push(stateVarNode);
            edges.push(
                makeAccessEdge(REPO, 'func_Vault_withdraw', 'var_Vault_balance', 'READS'),
                makeAccessEdge(REPO, 'func_Vault_withdraw', 'var_Vault_balance', 'WRITES'),
            );
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_interacting_functions', {
                repo_id: REPO,
                function_id: 'func_Vault_withdraw',
                include_state_access: true,
            }, ctx) as string;

            expect(result).toContain('State Access');
            expect(result).toContain('Reads:');
            expect(result).toContain('Writes:');
        });

        it('detects state overlaps between callers/callees', async () => {
            const stateVarNode = makeStateVarNode(REPO, 'var_Vault_balance', 'balance');
            const { nodes, edges } = standardGraph();
            nodes.push(stateVarNode);
            // withdraw reads balance, deposit also reads balance
            edges.push(
                makeAccessEdge(REPO, 'func_Vault_withdraw', 'var_Vault_balance', 'READS'),
                makeAccessEdge(REPO, 'func_Vault_deposit', 'var_Vault_balance', 'READS'),
            );
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_interacting_functions', {
                repo_id: REPO,
                function_id: 'func_Vault_withdraw',
                include_state_access: true,
            }, ctx) as string;

            expect(result).toContain('State Overlaps');
            expect(result).toContain('balance');
        });

        it('shows empty state overlaps when no shared vars', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_interacting_functions', {
                repo_id: REPO,
                function_id: 'func_Vault_withdraw',
                include_state_access: true,
            }, ctx) as string;

            // No READS/WRITES edges, so no state section with overlaps
            expect(result).toContain('State Access');
            expect(result).toContain('(none)');
        });

        it('throws for unknown function', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            await expect(handler.handleToolCall('trace_interacting_functions', {
                repo_id: REPO,
                function_id: 'nonexistent',
            }, ctx)).rejects.toThrow('Function not found');
        });
    });

    // ========================================================================
    // trace_read_slot
    // ========================================================================

    describe('trace_read_slot', () => {
        it('finds functions that read a state variable', async () => {
            const stateVar = makeStateVarNode(REPO, 'var_Vault_totalSupply', 'totalSupply');
            const { nodes, edges } = standardGraph();
            nodes.push(stateVar);
            edges.push(
                makeAccessEdge(REPO, 'func_Vault_deposit', 'var_Vault_totalSupply', 'READS'),
                makeAccessEdge(REPO, 'func_Vault_withdraw', 'var_Vault_totalSupply', 'READS'),
            );
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_read_slot', {
                repo_id: REPO,
                state_var_name: 'totalSupply',
            }, ctx) as string;

            expect(result).toContain('trace_read_slot');
            expect(result).toContain('totalSupply');
            expect(result).toContain('Read by (2)');
            expect(result).toContain('deposit');
            expect(result).toContain('withdraw');
        });

        it('returns empty when variable not found', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_read_slot', {
                repo_id: REPO,
                state_var_name: 'nonExistentVar',
            }, ctx) as string;

            expect(result).toContain('No functions read this variable');
        });

        it('uses partial match as fallback', async () => {
            const stateVar = makeStateVarNode(REPO, 'var_Vault_totalSupply', 'totalSupplyAmount');
            const { nodes, edges } = standardGraph();
            nodes.push(stateVar);
            edges.push(
                makeAccessEdge(REPO, 'func_Vault_deposit', 'var_Vault_totalSupply', 'READS'),
            );
            const ctx = buildMockContext(nodes, edges);

            // Search with partial name
            const result = await handler.handleToolCall('trace_read_slot', {
                repo_id: REPO,
                state_var_name: 'totalSupply',
            }, ctx) as string;

            // Should fall back to partial match
            expect(result).toContain('deposit');
        });

        it('reports when no functions access variable', async () => {
            const stateVar = makeStateVarNode(REPO, 'var_Vault_unused', 'unused');
            const { nodes, edges } = standardGraph();
            nodes.push(stateVar);
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_read_slot', {
                repo_id: REPO,
                state_var_name: 'unused',
            }, ctx) as string;

            expect(result).toContain('No functions read this variable');
        });
    });

    // ========================================================================
    // trace_write_slot
    // ========================================================================

    describe('trace_write_slot', () => {
        it('finds functions that write a state variable', async () => {
            const stateVar = makeStateVarNode(REPO, 'var_Vault_balance', 'balance');
            const { nodes, edges } = standardGraph();
            nodes.push(stateVar);
            edges.push(
                makeAccessEdge(REPO, 'func_Vault_deposit', 'var_Vault_balance', 'WRITES'),
            );
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_write_slot', {
                repo_id: REPO,
                state_var_name: 'balance',
            }, ctx) as string;

            expect(result).toContain('trace_write_slot');
            expect(result).toContain('balance');
            expect(result).toContain('Written by (1)');
            expect(result).toContain('deposit');
        });

        it('shows declared contract in output', async () => {
            const stateVar = makeStateVarNode(REPO, 'var_Vault_balance', 'balance');
            const { nodes, edges } = standardGraph();
            nodes.push(stateVar);
            edges.push(
                makeAccessEdge(REPO, 'func_Vault_deposit', 'var_Vault_balance', 'WRITES'),
            );
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_write_slot', {
                repo_id: REPO,
                state_var_name: 'balance',
            }, ctx) as string;

            expect(result).toContain('Declared in:');
            expect(result).toContain('Vault');
        });
    });

    // ========================================================================
    // Adjacency cache
    // ========================================================================

    describe('adjacency cache', () => {
        it('reuses cached adjacency for same repo', async () => {
            const { nodes, edges } = standardGraph();
            let sqlCallCount = 0;
            const ctx = buildMockContext(nodes, edges);
            const origSql = ctx.db.sql;
            ctx.db.sql = async (query: string, params: unknown[]) => {
                sqlCallCount++;
                return origSql(query, params);
            };

            // First call builds cache
            await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_Vault_deposit',
            }, ctx);

            const firstCallCount = sqlCallCount;

            // Second call should reuse cache (fewer SQL calls for edges)
            await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_Vault_withdraw',
            }, ctx);

            // Second call should make fewer SQL calls because adjacency is cached
            const secondCallCount = sqlCallCount - firstCallCount;
            expect(secondCallCount).toBeLessThan(firstCallCount);
        });
    });

    // ========================================================================
    // Output formatting
    // ========================================================================

    describe('output formatting', () => {
        it('trace_calls_to includes file path', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            const result = await handler.handleToolCall('trace_calls_to', {
                repo_id: REPO,
                function_id: 'func_Token_mint',
            }, ctx) as string;

            expect(result).toContain('contracts/Token.sol');
        });

        it('uses 1-based line numbers in output', async () => {
            const { nodes, edges } = standardGraph();
            const ctx = buildMockContext(nodes, edges);

            // deposit has 0-based lines [10, 30], should display as L11:L31
            const result = await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_Vault_deposit',
            }, ctx) as string;

            expect(result).toContain('L11');
            expect(result).toContain('L31');
        });

        it('handles single-line functions', async () => {
            const nodes: MockNode[] = [
                makeContractNode(REPO, 'contract_A', 'A', 'A.sol'),
                makeFuncNode(REPO, 'func_A_get', 'get', 'contract_A', [5, 5]),
            ];
            const ctx = buildMockContext(nodes, []);

            const result = await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_A_get',
            }, ctx) as string;

            // Single line: should show L6 (not L6:L6)
            expect(result).toContain('L6');
            expect(result).not.toContain('L6:L6');
        });

        it('handles nodes with invalid JSON data gracefully', async () => {
            const nodes: MockNode[] = [
                makeContractNode(REPO, 'contract_A', 'A', 'A.sol'),
                {
                    nodeId: 'func_A_broken',
                    name: 'broken',
                    nodeType: 'function',
                    repoId: REPO,
                    data: 'not-json',
                },
            ];
            const ctx = buildMockContext(nodes, []);

            const result = await handler.handleToolCall('trace_calls_from', {
                repo_id: REPO,
                function_id: 'func_A_broken',
            }, ctx) as string;

            // Should not throw, should use defaults
            expect(result).toContain('broken');
        });
    });
});
