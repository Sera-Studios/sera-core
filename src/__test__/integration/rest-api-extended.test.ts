/**
 * @fileoverview Extended REST API integration tests
 *
 * Tests routes not covered by rest-api.test.ts: table queries, metrics,
 * credentials, resources, versions, and agent execution endpoints.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { createTestnet, TestnetInstance } from '../TestHarness';

function httpRequest(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>
): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const payload = body ? JSON.stringify(body) : undefined;
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode!, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode!, data });
                }
            });
        });

        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

describe('REST API (extended)', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) { await testnet.teardown(); }
    });

    // ========================================================================
    // Health endpoints
    // ========================================================================

    describe('GET /api/health/metrics', () => {
        it('returns metrics summary', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest('GET', `${testnet.clientUrl}/api/health/metrics`);

            expect(status).toBe(200);
            const result = data as { period: { minutes: number }; requests: { total: number } };
            expect(result.period.minutes).toBe(60);
            expect(result.requests.total).toBeGreaterThanOrEqual(0);
        });

        it('accepts minutes query parameter', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest('GET', `${testnet.clientUrl}/api/health/metrics?minutes=5`);

            expect(status).toBe(200);
            const result = data as { period: { minutes: number } };
            expect(result.period.minutes).toBe(5);
        });
    });

    // ========================================================================
    // Table query endpoints
    // ========================================================================

    describe('GET /api/audits/:slug/tables/:table', () => {
        it('queries audit table data', async () => {
            testnet = await createTestnet({ auditSlug: 'table-test' });

            // First submit something via MCP so we have data
            const mcpClient = new (await import('../McpTestClient')).McpTestClient(
                `${testnet.mcpUrl}/table-test`
            );
            await mcpClient.initialize();
            await mcpClient.callTool('heartbeat', {
                agent_type: 'hunter',
                session_id: 'test-session',
            });

            // Query the heartbeats table via REST
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/audits/table-test/tables/sessionbridge_heartbeats`
            );

            expect(status).toBe(200);
            const result = data as { records: unknown[] };
            expect(result.records).toBeDefined();
            expect(result.records.length).toBeGreaterThan(0);
        });

        it('returns 404 for unknown audit', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/audits/nonexistent/tables/foo`
            );
            expect(status).toBe(404);
        });
    });

    // ========================================================================
    // Findings endpoint
    // ========================================================================

    describe('GET /api/audits/:slug/findings', () => {
        it('returns findings from audit', async () => {
            testnet = await createTestnet({ auditSlug: 'findings-test' });

            // Submit a finding via MCP
            const mcpClient = new (await import('../McpTestClient')).McpTestClient(
                `${testnet.mcpUrl}/findings-test`
            );
            await mcpClient.initialize();
            await mcpClient.callTool('submit_finding', {
                file: 'contracts/Vault.sol',
                start_line: 42,
                end_line: 42,
                title: 'Reentrancy',
                severity: 'critical',
                description: 'External call before state update',
                recommendation: 'Use CEI pattern',
            });

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/audits/findings-test/findings`
            );

            expect(status).toBe(200);
            const result = data as { findings: unknown[] };
            expect(result.findings).toBeDefined();
        });
    });

    // ========================================================================
    // Agent registration REST endpoints
    // ========================================================================

    describe('agent registration API', () => {
        it('POST + GET + DELETE registration lifecycle', async () => {
            testnet = await createTestnet();

            const regBody = {
                id: 'test-agent-1',
                name: 'Test Agent',
                version: '1.0.0',
                description: 'A test agent',
                roles: ['execution'],
                execution: { type: 'script', scriptPath: '/tmp/agent.py' },
                interface: { inputs: [], outputs: [] },
                defaultTimeout: 300,
                persist: false,
            };

            // Register
            const { status: regStatus, data: regData } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/agents/registrations`,
                regBody
            );
            expect(regStatus).toBe(201);
            expect((regData as { registered: string }).registered).toBe('test-agent-1');

            // List
            const { data: listData } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/registrations`
            );
            const list = listData as { registrations: Array<{ id: string }>; total: number };
            expect(list.registrations.some(r => r.id === 'test-agent-1')).toBe(true);

            // Get single
            const { status: getStatus, data: getData } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/registrations/test-agent-1`
            );
            expect(getStatus).toBe(200);
            expect((getData as { id: string }).id).toBe('test-agent-1');

            // Delete
            const { status: delStatus } = await httpRequest(
                'DELETE',
                `${testnet.clientUrl}/api/agents/registrations/test-agent-1`
            );
            expect(delStatus).toBe(200);
        });

        it('GET registration returns 404 for unknown id', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/registrations/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('POST registration with script content persists and registers', async () => {
            testnet = await createTestnet();

            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/agents/registrations`,
                {
                    id: 'script-agent',
                    name: 'Script Agent',
                    version: '1.0.0',
                    description: 'Script-based agent',
                    roles: ['execution'],
                    execution: { type: 'script', scriptPath: 'script-agent.py' },
                    interface: { inputs: [], outputs: [] },
                    defaultTimeout: 300,
                    persist: true,
                    scriptContent: 'print("hello")',
                }
            );
            expect(status).toBe(201);
        });

        it('POST reload reloads registrations from disk', async () => {
            testnet = await createTestnet();

            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/agents/registrations/reload`
            );
            expect(status).toBe(200);
        });
    });

    // ========================================================================
    // Credential endpoints
    // ========================================================================

    describe('credential API', () => {
        it('POST + GET + DELETE credential lifecycle', async () => {
            testnet = await createTestnet();

            // Save
            const { status: saveStatus, data: saveData } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/credentials`,
                {
                    provider: 'test-provider',
                    name: 'Test API Key',
                    apiKey: 'secret-value-123',
                }
            );
            expect(saveStatus).toBe(201);
            const saved = saveData as { id: string; provider: string };
            expect(saved.id).toBeDefined();

            // List
            const { status: listStatus, data: listData } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/credentials`
            );
            expect(listStatus).toBe(200);
            const creds = listData as { credentials: Array<{ id: string; provider: string; name: string }> };
            expect(creds.credentials.length).toBeGreaterThan(0);
            const testCred = creds.credentials.find(c => c.provider === 'test-provider');
            expect(testCred).toBeDefined();

            // Delete
            if (testCred) {
                const { status: delStatus } = await httpRequest(
                    'DELETE',
                    `${testnet.clientUrl}/api/credentials/${testCred.id}`
                );
                expect(delStatus).toBe(200);
            }
        });
    });

    // ========================================================================
    // Resource endpoints
    // ========================================================================

    describe('resource API', () => {
        it('POST + GET + PATCH + DELETE resource lifecycle', async () => {
            testnet = await createTestnet();

            // Create
            const { status: createStatus, data: createData } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/resources`,
                {
                    type: 'prompt',
                    name: 'Test Prompt',
                    language: 'solidity',
                    content: 'Find reentrancy bugs',
                }
            );
            expect(createStatus).toBe(201);
            const created = createData as { resource_id: string; slug: string };
            expect(created.resource_id).toBeDefined();

            // List
            const { status: listStatus, data: listData } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/resources`
            );
            expect(listStatus).toBe(200);
            const resources = listData as { resources: Array<{ id: string; name: string }> };
            expect(resources.resources.length).toBeGreaterThan(0);

            // Get single
            const { status: getStatus, data: getData } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/resources/${created.resource_id}`
            );
            expect(getStatus).toBe(200);
            expect((getData as { resource: { name: string } }).resource.name).toBe('Test Prompt');

            // Update
            const { status: patchStatus } = await httpRequest(
                'PATCH',
                `${testnet.clientUrl}/api/resources/${created.resource_id}`,
                { name: 'Updated Prompt' }
            );
            expect(patchStatus).toBe(200);

            // Delete
            const { status: delStatus } = await httpRequest(
                'DELETE',
                `${testnet.clientUrl}/api/resources/${created.resource_id}`
            );
            expect(delStatus).toBe(200);
        });

        it('GET resource returns 404 for unknown id', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/resources/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('filters resources by type', async () => {
            testnet = await createTestnet();

            await httpRequest('POST', `${testnet.clientUrl}/api/resources`, {
                type: 'role',
                name: 'Test Role',
                language: 'solidity',
                content: 'You are a hunter',
            });

            const { data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/resources?type=role`
            );
            const result = data as { resources: Array<{ type: string }> };
            for (const r of result.resources) {
                expect(r.type).toBe('role');
            }
        });
    });

    // ========================================================================
    // Version endpoints
    // ========================================================================

    describe('version API', () => {
        it('lists versions with agent_id', async () => {
            testnet = await createTestnet();

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/versions?agent_id=test-agent`
            );
            expect(status).toBe(200);
            const result = data as { versions: unknown[]; total: number };
            expect(result.versions).toBeDefined();
            expect(result.total).toBeGreaterThanOrEqual(0);
        });

        it('returns 400 without agent_id', async () => {
            testnet = await createTestnet();

            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/versions`
            );
            expect(status).toBe(400);
        });

        it('GET version returns 404 for unknown id', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/versions/nonexistent`
            );
            expect(status).toBe(404);
        });
    });

    // ========================================================================
    // Benchmark endpoints
    // ========================================================================

    describe('benchmark API (extended)', () => {
        it('GET /api/benchmarks/categories returns array', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/categories`
            );
            expect(status).toBe(200);
            const result = data as { categories: unknown[] };
            expect(result.categories).toBeDefined();
        });

        it('POST + GET benchmark category lifecycle', async () => {
            testnet = await createTestnet();

            const { status: createStatus, data: createData } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/categories`,
                {
                    id: 'test-cat-1',
                    name: 'Test Category',
                    description: 'Testing category',
                    fetcherId: 'sherlock',
                    metrics: [
                        { name: 'precision', type: 'percentage', weight: 0.5, description: 'Precision' },
                        { name: 'recall', type: 'percentage', weight: 0.5, description: 'Recall' },
                    ],
                }
            );
            expect(createStatus).toBe(201);
            const created = createData as { id: string };

            // Get by id
            const { status: getStatus } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/categories/${created.id}`
            );
            expect(getStatus).toBe(200);
        });

        it('GET benchmark subsets', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/subsets`
            );
            expect(status).toBe(200);
        });

        it('POST + GET + DELETE benchmark subset lifecycle', async () => {
            testnet = await createTestnet();

            // Create a contest first
            await httpRequest('POST', `${testnet.clientUrl}/api/benchmarks/contests`, {
                id: 'test-contest',
                source: 'sherlock',
                name: 'Test Contest',
                language: 'solidity',
            });

            // Create subset
            const { status: createStatus } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/subsets`,
                {
                    name: 'test-subset',
                    contestIds: ['test-contest'],
                }
            );
            expect(createStatus).toBe(201);

            // Delete subset
            const { status: delStatus } = await httpRequest(
                'DELETE',
                `${testnet.clientUrl}/api/benchmarks/subsets/test-subset`
            );
            expect(delStatus).toBe(200);
        });

        it('PATCH contest metadata', async () => {
            testnet = await createTestnet();

            // Create contest with required fields
            // Use full contest shape (matching benchmark-api.test.ts pattern)
            const { status: postStatus } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/contests`,
                {
                    id: 'patch-contest',
                    source: 'sherlock',
                    externalId: 'ext-p',
                    name: 'Patch Me',
                    sponsor: 'Test',
                    temporalBucket: '2025-Q1',
                    codeRepoUrl: 'https://github.com/test',
                    codeRepoPath: '/path/to/code',
                    scopeFiles: ['src/A.sol'],
                    totalFindings: 2,
                    findingsBySeverity: { high: 1, medium: 1 },
                }
            );
            expect(postStatus).toBe(201);

            // Patch it
            const { status } = await httpRequest(
                'PATCH',
                `${testnet.clientUrl}/api/benchmarks/contests/patch-contest`,
                { tags: ['defi', 'lending'], difficulty: 'hard' }
            );
            expect(status).toBe(200);
        });

        it('PATCH contest returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'PATCH',
                `${testnet.clientUrl}/api/benchmarks/contests/nonexistent`,
                { tags: ['test'] }
            );
            expect(status).toBe(404);
        });

        it('category leaderboard endpoint', async () => {
            testnet = await createTestnet();

            // Create category
            await httpRequest('POST', `${testnet.clientUrl}/api/benchmarks/categories`, {
                id: 'lb-cat',
                name: 'Leaderboard Cat',
                description: 'For leaderboard test',
                fetcherId: 'valid-findings',
                metrics: [{ name: 'score', type: 'number', weight: 1.0, description: 'Score' }],
            });

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/categories/lb-cat/leaderboard`
            );
            expect(status).toBe(200);
            const result = data as { categoryId: string; leaderboard: unknown[] };
            expect(result.categoryId).toBe('lb-cat');
            expect(result.leaderboard).toBeDefined();
        });

        it('category leaderboard returns 404 for unknown category', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/categories/nonexistent/leaderboard`
            );
            expect(status).toBe(404);
        });

        it('category results listing', async () => {
            testnet = await createTestnet();

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/categories/some-cat/results`
            );
            expect(status).toBe(200);
            expect((data as { results: unknown[] }).results).toBeDefined();
        });

        it('POST + GET category result', async () => {
            testnet = await createTestnet();

            const { status: createStatus } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/category-results`,
                {
                    id: 'cr-1',
                    runId: 'run-1',
                    categoryId: 'test-cat',
                    datasetId: 'test-ds',
                    executionAgentId: 'agent-1',
                    evaluationAgentId: 'eval-1',
                    metrics: { score: 0.85 },
                    startedAt: new Date().toISOString(),
                    completedAt: new Date().toISOString(),
                    metadata: null,
                }
            );
            expect(createStatus).toBe(201);

            const { status: getStatus, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/category-results/cr-1`
            );
            expect(getStatus).toBe(200);
            expect((data as { result: { id: string } }).result.id).toBe('cr-1');
        });

        it('GET category-result returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/category-results/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('POST category-result returns 400 with missing fields', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/category-results`,
                { id: 'cr-bad' }
            );
            expect(status).toBe(400);
        });

        it('dataset fetchers endpoint', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/datasets/fetchers`
            );
            expect(status).toBe(200);
            expect((data as { fetchers: unknown[] }).fetchers).toBeDefined();
        });

        it('datasets listing', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/datasets`
            );
            expect(status).toBe(200);
            expect((data as { datasets: unknown[] }).datasets).toBeDefined();
        });

        it('GET dataset returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/datasets/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('DELETE dataset returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'DELETE',
                `${testnet.clientUrl}/api/datasets/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('POST dataset import returns 400 with missing fields', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/datasets/import`,
                { categoryId: 'test' }
            );
            expect(status).toBe(400);
        });

        it('PATCH category returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'PATCH',
                `${testnet.clientUrl}/api/benchmarks/categories/nonexistent`,
                { name: 'updated' }
            );
            expect(status).toBe(404);
        });

        it('DELETE category returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'DELETE',
                `${testnet.clientUrl}/api/benchmarks/categories/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('DELETE subset returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'DELETE',
                `${testnet.clientUrl}/api/benchmarks/subsets/nonexistent`
            );
            expect(status).toBe(404);
        });
    });

    // ========================================================================
    // Agent execution endpoints
    // ========================================================================

    describe('agent execution API', () => {
        it('lists running executions', async () => {
            testnet = await createTestnet();

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/executions`
            );
            expect(status).toBe(200);
            // listAll() returns AgentHandle[] directly
            expect(Array.isArray(data)).toBe(true);
        });

        it('POST execution returns 400 with missing fields', async () => {
            testnet = await createTestnet();

            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/agents/executions`,
                { registrationId: 'test' }
            );
            expect(status).toBe(400);
        });

        it('POST execution returns 404 for unknown registration', async () => {
            testnet = await createTestnet();

            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/agents/executions`,
                { registrationId: 'nonexistent', workspacePath: '/tmp' }
            );
            expect(status).toBe(404);
        });

        it('DELETE execution returns 404 for unknown instance', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'DELETE',
                `${testnet.clientUrl}/api/agents/executions/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('GET execution returns 404 for unknown instance', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/executions/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('GET execution output returns 404 for unknown instance', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/executions/nonexistent/output`
            );
            expect(status).toBe(404);
        });
    });

    // ========================================================================
    // Agent registration inputs
    // ========================================================================

    describe('agent registration inputs', () => {
        it('GET /api/agents/registrations/:id/inputs returns inputs', async () => {
            testnet = await createTestnet();

            // Register agent with declared inputs
            await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, {
                id: 'input-agent',
                name: 'Input Agent',
                version: '1.0.0',
                description: 'Agent with inputs',
                roles: ['execution'],
                execution: { type: 'script', scriptPath: '/tmp/agent.py' },
                interface: {
                    inputs: [
                        { name: 'target', type: 'string', description: 'Target to audit' },
                    ],
                    outputs: [],
                },
                defaultTimeout: 300,
            });

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/registrations/input-agent/inputs`
            );
            expect(status).toBe(200);
            // Returns raw inputs array
            const inputs = data as Array<{ name: string }>;
            expect(Array.isArray(inputs)).toBe(true);
            expect(inputs.length).toBe(1);
            expect(inputs[0].name).toBe('target');
        });

        it('GET /api/agents/registrations/:id/inputs returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/registrations/nonexistent/inputs`
            );
            expect(status).toBe(404);
        });
    });

    // ========================================================================
    // Audit migration
    // ========================================================================

    describe('audit migration', () => {
        it('POST /api/audits/:slug/migrate returns 400 without sourcePath', async () => {
            testnet = await createTestnet({ auditSlug: 'migrate-test' });
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/audits/migrate-test/migrate`,
                {}
            );
            expect(status).toBe(400);
        });

        it('POST /api/audits/:slug/migrate returns 404 for unknown audit', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/audits/nonexistent/migrate`,
                { sourcePath: '/tmp/src' }
            );
            expect(status).toBe(404);
        });
    });

    // ========================================================================
    // Version lineage
    // ========================================================================

    describe('version lineage API', () => {
        it('GET /api/versions/:id/lineage returns lineage', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/versions/some-version/lineage`
            );
            expect(status).toBe(200);
            expect((data as { lineage: unknown[]; total: number }).lineage).toBeDefined();
        });
    });

    // ========================================================================
    // Experiment endpoints
    // ========================================================================

    describe('experiment API', () => {
        it('GET /api/experiments/summary returns summary with agent_id', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/experiments/summary?agent_id=test-agent`
            );
            expect(status).toBe(200);
            expect(data).toBeDefined();
        });

        it('GET /api/experiments/summary returns 400 without agent_id', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/experiments/summary`
            );
            expect(status).toBe(400);
        });

        it('GET /api/experiments returns experiments list with agent_id', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/experiments?agent_id=test-agent`
            );
            expect(status).toBe(200);
            expect((data as { experiments: unknown[] }).experiments).toBeDefined();
        });

        it('GET /api/experiments returns 400 without agent_id', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/experiments`
            );
            expect(status).toBe(400);
        });

        it('GET /api/experiments/:id returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/experiments/nonexistent`
            );
            expect(status).toBe(404);
        });
    });

    // ========================================================================
    // Findings with status filter
    // ========================================================================

    describe('findings endpoint', () => {
        it('GET /api/audits/:slug/findings returns 404 for unknown audit', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/audits/nonexistent/findings`
            );
            expect(status).toBe(404);
        });
    });

    // ========================================================================
    // Agent registration with persist and script content
    // ========================================================================

    describe('agent registration persist', () => {
        it('POST /api/agents/registrations with persist writes to disk', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/agents/registrations?persist=true`,
                {
                    id: 'persist-agent',
                    name: 'Persist Agent',
                    version: '1.0',
                    description: 'Test persist',
                    roles: ['execution'],
                    execution: { type: 'script', command: 'python', scriptPath: 'main.py' },
                    interface: { inputs: [], outputs: [] },
                    defaultTimeout: 30000,
                    scriptContent: 'print("hello")',
                    files: [{ name: 'config.json', content: '{}' }],
                }
            );
            expect(status).toBe(201);
            expect((data as any).registered).toBe('persist-agent');
        });

        it('GET /api/agents/registrations?role=execution filters by role', async () => {
            testnet = await createTestnet();
            // Register an agent first
            await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, {
                id: 'role-test',
                name: 'Role Test',
                version: '1.0',
                description: 'test',
                roles: ['execution'],
                execution: { type: 'subprocess', command: 'node' },
                interface: { inputs: [], outputs: [] },
                defaultTimeout: 30000,
            });

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/agents/registrations?role=execution`
            );
            expect(status).toBe(200);
            expect((data as any).registrations.length).toBeGreaterThanOrEqual(1);
        });

        it('GET /api/credentials?provider=openai filters by provider', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/credentials?provider=openai`
            );
            expect(status).toBe(200);
            expect((data as any).credentials).toEqual([]);
        });
    });

    // ========================================================================
    // Agent execution with inputs routing
    // ========================================================================

    describe('agent execution inputs', () => {
        it('POST /api/agents/executions routes typed inputs to overrides/env', async () => {
            testnet = await createTestnet();

            // Register agent with typed inputs (all optional so validation passes)
            await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, {
                id: 'input-agent',
                name: 'Input Agent',
                version: '1.0',
                description: 'Agent with typed inputs',
                roles: ['execution'],
                execution: { type: 'script', interpreter: 'echo', scriptPath: 'test.sh' },
                interface: {
                    inputs: [
                        { name: 'workspace', type: 'workspace', required: false },
                        { name: 'API_KEY', type: 'env', required: false },
                        { name: 'target', type: 'string', required: false },
                    ],
                    outputs: [],
                },
                defaultTimeout: 5,
            });

            const { status, data } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/agents/executions`,
                {
                    registrationId: 'input-agent',
                    workspacePath: '/tmp/test-workspace',
                    inputs: {
                        workspace: '/tmp/ws',
                        API_KEY: 'secret',
                        target: 'Contract.sol',
                    },
                }
            );
            expect(status).toBe(201);
            expect((data as any).instanceId).toContain('input-agent');
        });

        it('POST /api/agents/executions handles undeclared inputs as overrides', async () => {
            testnet = await createTestnet();

            await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, {
                id: 'simple-agent',
                name: 'Simple Agent',
                version: '1.0',
                description: 'No declared inputs',
                roles: ['execution'],
                execution: { type: 'script', interpreter: 'echo', scriptPath: 'test.sh' },
                interface: { inputs: [], outputs: [] },
                defaultTimeout: 5,
            });

            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/agents/executions`,
                {
                    registrationId: 'simple-agent',
                    workspacePath: '/tmp/ws',
                    inputs: { customField: 'value' },
                }
            );
            expect(status).toBe(201);
        });
    });

    // ========================================================================
    // Benchmark findings
    // ========================================================================

    describe('benchmark findings', () => {
        it('GET /api/benchmarks/contests/:id/findings returns empty for new contest', async () => {
            testnet = await createTestnet();
            // Create contest first
            await httpRequest('POST', `${testnet.clientUrl}/api/benchmarks/contests`, {
                id: 'find-contest',
                name: 'Findings Contest',
                source: 'sherlock',
                platform: 'sherlock',
                status: 'active',
                language: 'solidity',
                difficulty: 'medium',
                startDate: '2025-01-01',
                endDate: '2025-01-31',
                totalFindings: 0,
                url: '',
                repoUrl: '',
                tags: '[]',
                metrics: '{}',
                prizeFund: '',
                metadata: '{}',
                nsloc: 0,
                contestPageHtml: '',
            });

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/contests/find-contest/findings`
            );
            expect(status).toBe(200);
            expect((data as any).findings).toEqual([]);
            expect((data as any).total).toBe(0);
        });

        it('POST /api/benchmarks/contests/:id/findings upserts findings', async () => {
            testnet = await createTestnet();
            await httpRequest('POST', `${testnet.clientUrl}/api/benchmarks/contests`, {
                id: 'find-contest-2',
                name: 'Findings Contest 2',
                source: 'sherlock',
                platform: 'sherlock',
                status: 'active',
                language: 'solidity',
                difficulty: 'medium',
                startDate: '2025-01-01',
                endDate: '2025-01-31',
                totalFindings: 0,
                url: '',
                repoUrl: '',
                tags: '[]',
                metrics: '{}',
                prizeFund: '',
                metadata: '{}',
                nsloc: 0,
                contestPageHtml: '',
            });

            const { status, data } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/contests/find-contest-2/findings`,
                {
                    findings: [
                        { id: 'f1', externalId: 'ext-1', title: 'Reentrancy', severity: 'high', description: 'desc', impact: 'funds lost', affectedFiles: [], labels: [] },
                        { id: 'f2', externalId: 'ext-2', title: 'Overflow', severity: 'medium', description: 'desc2', impact: 'minor', affectedFiles: [], labels: [] },
                    ],
                }
            );
            expect(status).toBe(201);
            expect((data as any).upserted).toBe(2);
        });

        it('POST /api/benchmarks/contests/:id/findings validates array', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/contests/any/findings`,
                { findings: 'not-array' }
            );
            expect(status).toBe(400);
        });
    });

    // ========================================================================
    // Benchmark runs
    // ========================================================================

    describe('benchmark runs', () => {
        it('POST /api/benchmarks/runs creates a run', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/runs`,
                {
                    id: 'run-1',
                    agentId: 'agent-1',
                    agentVersion: '1.0',
                    contestId: 'contest-1',
                    status: 'pending',
                    startedAt: new Date().toISOString(),
                }
            );
            expect(status).toBe(201);
            expect((data as any).created).toBe('run-1');
        });

        it('POST /api/benchmarks/runs validates required fields', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/runs`,
                { id: 'run-x' }
            );
            expect(status).toBe(400);
        });

        it('GET /api/benchmarks/runs/:id returns a run', async () => {
            testnet = await createTestnet();
            await httpRequest('POST', `${testnet.clientUrl}/api/benchmarks/runs`, {
                id: 'run-get',
                agentId: 'agent-1',
                agentVersion: '1.0',
                contestId: 'contest-1',
                status: 'running',
                startedAt: new Date().toISOString(),
            });

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/runs/run-get`
            );
            expect(status).toBe(200);
            expect((data as any).id).toBe('run-get');
        });

        it('GET /api/benchmarks/runs/:id returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/runs/nonexistent`
            );
            expect(status).toBe(404);
        });

        it('PATCH /api/benchmarks/runs/:id updates a run', async () => {
            testnet = await createTestnet();
            await httpRequest('POST', `${testnet.clientUrl}/api/benchmarks/runs`, {
                id: 'run-patch',
                agentId: 'agent-1',
                agentVersion: '1.0',
                contestId: 'contest-1',
                status: 'running',
                startedAt: new Date().toISOString(),
            });

            const { status, data } = await httpRequest(
                'PATCH',
                `${testnet.clientUrl}/api/benchmarks/runs/run-patch`,
                { status: 'completed', completedAt: new Date().toISOString() }
            );
            expect(status).toBe(200);
            expect((data as any).updated).toBe('run-patch');
        });

        it('PATCH /api/benchmarks/runs/:id returns 404 for unknown', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'PATCH',
                `${testnet.clientUrl}/api/benchmarks/runs/nonexistent`,
                { status: 'completed' }
            );
            expect(status).toBe(404);
        });

        it('GET /api/benchmarks/runs lists runs with filters', async () => {
            testnet = await createTestnet();
            await httpRequest('POST', `${testnet.clientUrl}/api/benchmarks/runs`, {
                id: 'run-list-1',
                agentId: 'agent-filter',
                agentVersion: '1.0',
                contestId: 'contest-1',
                status: 'running',
                startedAt: new Date().toISOString(),
            });

            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/runs?agentId=agent-filter`
            );
            expect(status).toBe(200);
            expect((data as any).runs).toBeDefined();
        });
    });

    // ========================================================================
    // Benchmark results
    // ========================================================================

    describe('benchmark results', () => {
        it('POST /api/benchmarks/results saves a result', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/results`,
                {
                    id: 'result-1',
                    runId: 'run-1',
                    agentId: 'agent-1',
                    agentVersion: '1.0',
                    contestId: 'contest-1',
                    evaluatedAt: new Date().toISOString(),
                    score: { total: 85, precision: 0.9, recall: 0.8 },
                    metrics: {},
                    bySeverity: {},
                }
            );
            expect(status).toBe(201);
            expect((data as any).saved).toBe('result-1');
        });

        it('POST /api/benchmarks/results validates required fields', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/results`,
                { id: 'result-x' }
            );
            expect(status).toBe(400);
        });

        it('GET /api/benchmarks/results lists results', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/results`
            );
            expect(status).toBe(200);
            expect((data as any).results).toBeDefined();
            expect((data as any).total).toBeDefined();
        });

        it('GET /api/benchmarks/results filters by agentId', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/results?agentId=test-agent`
            );
            expect(status).toBe(200);
            expect((data as any).results).toBeDefined();
        });
    });

    // ========================================================================
    // Agent score history
    // ========================================================================

    describe('agent history', () => {
        it('GET /api/benchmarks/agents/:id/history returns history', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest(
                'GET',
                `${testnet.clientUrl}/api/benchmarks/agents/some-agent/history`
            );
            expect(status).toBe(200);
            expect((data as any).history).toBeDefined();
            expect((data as any).total).toBeDefined();
        });
    });

    // ========================================================================
    // Import endpoints
    // ========================================================================

    describe('import endpoints', () => {
        it('POST /api/benchmarks/import/sherlock validates indexPath', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/import/sherlock`,
                {}
            );
            expect(status).toBe(400);
        });

        it('POST /api/benchmarks/import/sherlock returns 500 for invalid path', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/import/sherlock`,
                { indexPath: '/nonexistent/path/index.json' }
            );
            expect(status).toBe(500);
        });

        it('POST /api/benchmarks/import/solana validates indexPath', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/import/solana`,
                {}
            );
            expect(status).toBe(400);
        });

        it('POST /api/benchmarks/import/solana returns 500 for invalid path', async () => {
            testnet = await createTestnet();
            const { status } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/benchmarks/import/solana`,
                { indexPath: '/nonexistent/path/index.json' }
            );
            expect(status).toBe(500);
        });
    });
});
