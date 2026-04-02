/**
 * @fileoverview Integration tests for VersionHandler MCP tools and Version/Experiment REST endpoints
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

// ============================================================================
// HELPERS
// ============================================================================

function httpJson(method: string, url: string, body?: any): Promise<{ status: number; body: any }> {
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
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode!, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode!, body: data });
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function parseResult(result: any): any {
    const text = result.content[0].text;
    try { return JSON.parse(text); }
    catch { return text; }
}

// ============================================================================
// MCP TOOL TESTS
// ============================================================================

describe('VersionHandler MCP Tools', () => {
    let testnet: TestnetInstance;
    let client: McpTestClient;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'version-test' });
        client = new McpTestClient(`${testnet.mcpUrl}/version-test`);
        await client.initialize();
    }

    it('version_create_snapshot creates a version', async () => {
        await setup();

        const result = await client.callTool('version_create_snapshot', {
            agent_id: 'hunter-v1',
            version: '0.1.0',
            created_by: 'human',
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.version_id).toBeDefined();
        expect(data.agent_id).toBe('hunter-v1');
        expect(data.version).toBe('0.1.0');
    });

    it('version_create_snapshot works without registration (null snapshot)', async () => {
        await setup();

        const result = await client.callTool('version_create_snapshot', {
            agent_id: 'nonexistent-agent',
            version: '0.1.0',
            created_by: 'human',
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.has_registration_snapshot).toBe(false);
    });

    it('version_get_lineage returns version chain', async () => {
        await setup();

        const v1 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));

        const v2 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.2.0', created_by: 'autonomous-loop',
            parent_version_id: v1.version_id,
        }));

        parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.3.0', created_by: 'autonomous-loop',
            parent_version_id: v2.version_id,
        }));

        const result = await client.callTool('version_get_lineage', {
            agent_id: 'hunter',
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.versions).toHaveLength(3);
        expect(data.versions[0].version).toBe('0.3.0');
        expect(data.versions[2].version).toBe('0.1.0');
    });

    it('version_get_lineage returns empty for unknown agent', async () => {
        await setup();

        const result = await client.callTool('version_get_lineage', {
            agent_id: 'nonexistent',
        });
        const data = parseResult(result);
        expect(data.versions).toEqual([]);
        expect(data.total).toBe(0);
    });

    it('experiment_create creates pending experiment', async () => {
        await setup();

        const v1 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));

        const result = await client.callTool('experiment_create', {
            agent_id: 'hunter',
            base_version_id: v1.version_id,
            hypothesis: 'Adding reentrancy primer improves recall',
            modification_type: 'primer-attachment',
            modification_detail: { primerId: 'primer-reentrancy', action: 'add' },
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.experiment_id).toBeDefined();
        expect(data.status).toBe('pending');
    });

    it('experiment_complete records results and calculates delta', async () => {
        await setup();

        const v1 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));

        const exp = parseResult(await client.callTool('experiment_create', {
            agent_id: 'hunter',
            base_version_id: v1.version_id,
            hypothesis: 'Test hypothesis',
            modification_type: 'role-refinement',
            modification_detail: { field: 'content' },
        }));

        const result = await client.callTool('experiment_complete', {
            experiment_id: exp.experiment_id,
            benchmark_run_ids: ['run-1', 'run-2'],
            before_metrics: { score: 60, recall: 0.5 },
            after_metrics: { score: 72, recall: 0.65 },
            verdict: 'keep',
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.status).toBe('improved');
        expect(data.delta.score).toBe(12);
        expect(data.delta.recall).toBe(0.15);
    });

    it('experiment_complete derives status from verdict', async () => {
        await setup();

        const v1 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));

        const exp = parseResult(await client.callTool('experiment_create', {
            agent_id: 'hunter',
            base_version_id: v1.version_id,
            hypothesis: 'Test',
            modification_type: 'custom',
            modification_detail: {},
        }));

        const result = await client.callTool('experiment_complete', {
            experiment_id: exp.experiment_id,
            benchmark_run_ids: ['run-1'],
            before_metrics: { score: 60 },
            after_metrics: { score: 55 },
            verdict: 'revert',
        });

        const data = parseResult(result);
        expect(data.status).toBe('reverted');
    });

    it('experiment_complete returns error for nonexistent experiment', async () => {
        await setup();

        const result = await client.callTool('experiment_complete', {
            experiment_id: 'nonexistent',
            benchmark_run_ids: ['run-1'],
            before_metrics: { score: 60 },
            after_metrics: { score: 72 },
            verdict: 'keep',
        });
        expect(result.isError).toBe(true);
    });

    it('experiment_list filters by status', async () => {
        await setup();

        const v1 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));

        const exp1 = parseResult(await client.callTool('experiment_create', {
            agent_id: 'hunter', base_version_id: v1.version_id,
            hypothesis: 'h1', modification_type: 'custom', modification_detail: {},
        }));

        parseResult(await client.callTool('experiment_create', {
            agent_id: 'hunter', base_version_id: v1.version_id,
            hypothesis: 'h2', modification_type: 'custom', modification_detail: {},
        }));

        // Complete first experiment
        await client.callTool('experiment_complete', {
            experiment_id: exp1.experiment_id,
            benchmark_run_ids: ['run-1'],
            before_metrics: { score: 60 },
            after_metrics: { score: 72 },
            verdict: 'keep',
        });

        const result = await client.callTool('experiment_list', {
            agent_id: 'hunter', status: 'pending',
        });
        const data = parseResult(result);
        expect(data.total).toBe(1);
        expect(data.experiments[0].hypothesis).toBe('h2');
    });

    it('experiment_summary returns aggregated stats', async () => {
        await setup();

        const v1 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));

        // Create and complete two experiments
        const exp1 = parseResult(await client.callTool('experiment_create', {
            agent_id: 'hunter', base_version_id: v1.version_id,
            hypothesis: 'improve recall', modification_type: 'primer-attachment',
            modification_detail: { primerId: 'p1' },
        }));
        await client.callTool('experiment_complete', {
            experiment_id: exp1.experiment_id,
            benchmark_run_ids: ['r1'],
            before_metrics: { score: 60, recall: 0.5 },
            after_metrics: { score: 68, recall: 0.6 },
            verdict: 'keep',
        });

        const exp2 = parseResult(await client.callTool('experiment_create', {
            agent_id: 'hunter', base_version_id: v1.version_id,
            hypothesis: 'try model change', modification_type: 'model-change',
            modification_detail: { from: 'sonnet', to: 'haiku' },
        }));
        await client.callTool('experiment_complete', {
            experiment_id: exp2.experiment_id,
            benchmark_run_ids: ['r2'],
            before_metrics: { score: 68 },
            after_metrics: { score: 55 },
            verdict: 'revert',
        });

        const result = await client.callTool('experiment_summary', {
            agent_id: 'hunter',
        });
        const data = parseResult(result);

        expect(data.totalExperiments).toBe(2);
        expect(data.improved).toBe(1);
        expect(data.reverted).toBe(1);
        expect(data.topImprovements).toHaveLength(1);
        expect(data.topRegressions).toHaveLength(1);
    });

    it('full workflow: version -> experiment -> complete -> verify', async () => {
        await setup();

        // Create base version
        const v1 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));

        // Start experiment
        const exp = parseResult(await client.callTool('experiment_create', {
            agent_id: 'hunter',
            base_version_id: v1.version_id,
            hypothesis: 'Adding trace tool improves detection',
            modification_type: 'tool-addition',
            modification_detail: { toolName: 'trace_read_slot' },
        }));

        // Create result version
        const v2 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.2.0',
            parent_version_id: v1.version_id, created_by: 'autonomous-loop',
        }));

        // Complete experiment
        const completed = parseResult(await client.callTool('experiment_complete', {
            experiment_id: exp.experiment_id,
            result_version_id: v2.version_id,
            benchmark_run_ids: ['bench-1', 'bench-2'],
            before_metrics: { score: 55, recall: 0.45, precision: 0.8 },
            after_metrics: { score: 63, recall: 0.55, precision: 0.78 },
            verdict: 'keep',
            notes: 'Significant recall improvement, minor precision trade-off',
        }));

        expect(completed.status).toBe('improved');
        expect(completed.delta.score).toBe(8);

        // Verify lineage
        const lineage = parseResult(await client.callTool('version_get_lineage', {
            agent_id: 'hunter',
        }));
        expect(lineage.versions).toHaveLength(2);
        expect(lineage.versions[0].version).toBe('0.2.0');
    });
});

// ============================================================================
// REST API TESTS
// ============================================================================

describe('Version REST API', () => {
    let testnet: TestnetInstance;
    let client: McpTestClient;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    function url(path: string): string {
        return `${testnet.clientUrl}${path}`;
    }

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'version-rest-test' });
        client = new McpTestClient(`${testnet.mcpUrl}/version-rest-test`);
        await client.initialize();
    }

    it('GET /api/versions returns empty for unknown agent', async () => {
        await setup();
        const res = await httpJson('GET', url('/api/versions?agent_id=nonexistent'));
        expect(res.status).toBe(200);
        expect(res.body.versions).toEqual([]);
        expect(res.body.total).toBe(0);
    });

    it('GET /api/versions requires agent_id', async () => {
        await setup();
        const res = await httpJson('GET', url('/api/versions'));
        expect(res.status).toBe(400);
    });

    it('GET /api/versions/:id returns 404 for nonexistent', async () => {
        await setup();
        const res = await httpJson('GET', url('/api/versions/nonexistent'));
        expect(res.status).toBe(404);
    });

    it('GET /api/versions/:id returns version created via MCP', async () => {
        await setup();

        const created = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));

        const res = await httpJson('GET', url(`/api/versions/${created.version_id}`));
        expect(res.status).toBe(200);
        expect(res.body.version.agentId).toBe('hunter');
        expect(res.body.version.version).toBe('0.1.0');
    });

    it('GET /api/versions/:id/lineage returns chain', async () => {
        await setup();

        const v1 = parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.1.0', created_by: 'human',
        }));
        parseResult(await client.callTool('version_create_snapshot', {
            agent_id: 'hunter', version: '0.2.0', created_by: 'human',
            parent_version_id: v1.version_id,
        }));

        const res = await httpJson('GET', url(`/api/versions/${v1.version_id}/lineage`));
        expect(res.status).toBe(200);
        expect(res.body.lineage).toHaveLength(1); // v1 is root, only itself
    });

    it('GET /api/experiments returns empty for unknown agent', async () => {
        await setup();
        const res = await httpJson('GET', url('/api/experiments?agent_id=nonexistent'));
        expect(res.status).toBe(200);
        expect(res.body.experiments).toEqual([]);
    });

    it('GET /api/experiments/:id returns 404 for nonexistent', async () => {
        await setup();
        const res = await httpJson('GET', url('/api/experiments/nonexistent'));
        expect(res.status).toBe(404);
    });

    it('GET /api/experiments/summary returns empty summary', async () => {
        await setup();
        const res = await httpJson('GET', url('/api/experiments/summary?agent_id=nonexistent'));
        expect(res.status).toBe(200);
        expect(res.body.totalExperiments).toBe(0);
        expect(res.body.successRate).toBe(0);
    });
});
