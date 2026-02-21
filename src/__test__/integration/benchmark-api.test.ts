/**
 * @fileoverview Integration tests for benchmark REST endpoints
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { createTestnet, TestnetInstance } from '../TestHarness';

let testnet: TestnetInstance;

afterEach(async () => {
    if (testnet) await testnet.teardown();
});

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

function httpPatch(url: string, body: any): Promise<{ status: number; body: any }> {
    return httpJson('PATCH', url, body);
}

function url(path: string): string {
    return `${testnet.clientUrl}${path}`;
}

describe('Benchmark REST API - Contests', () => {
    it('POST + GET contest round-trip', async () => {
        testnet = await createTestnet();

        const contest = {
            id: 'test-contest',
            source: 'sherlock',
            externalId: 'ext-1',
            name: 'Test Contest',
            sponsor: 'TestSponsor',
            temporalBucket: '2025-Q1',
            codeRepoUrl: 'https://github.com/test',
            codeRepoPath: '/path/to/code',
            scopeFiles: ['src/Contract.sol'],
            totalFindings: 5,
            findingsBySeverity: { high: 2, medium: 3 },
        };

        const postRes = await httpJson('POST', url('/api/benchmarks/contests'), contest);
        expect(postRes.status).toBe(201);
        expect(postRes.body.upserted).toBe('test-contest');

        const getRes = await httpJson('GET', url('/api/benchmarks/contests/test-contest'));
        expect(getRes.status).toBe(200);
        expect(getRes.body.name).toBe('Test Contest');
        expect(getRes.body.scopeFiles).toEqual(['src/Contract.sol']);
    });

    it('GET returns 404 for missing contest', async () => {
        testnet = await createTestnet();
        const res = await httpJson('GET', url('/api/benchmarks/contests/nonexistent'));
        expect(res.status).toBe(404);
    });

    it('lists contests with filters', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/benchmarks/contests'), {
            id: 'c-1', source: 'sherlock', externalId: 'e1', name: 'A',
            sponsor: 'S', temporalBucket: '2025-Q1',
            codeRepoUrl: '', codeRepoPath: '', scopeFiles: [],
            totalFindings: 0, findingsBySeverity: {},
        });
        await httpJson('POST', url('/api/benchmarks/contests'), {
            id: 'c-2', source: 'code4rena', externalId: 'e2', name: 'B',
            sponsor: 'S', temporalBucket: '2025-Q2',
            codeRepoUrl: '', codeRepoPath: '', scopeFiles: [],
            totalFindings: 0, findingsBySeverity: {},
        });

        const allRes = await httpJson('GET', url('/api/benchmarks/contests'));
        expect(allRes.body.total).toBe(2);

        const filteredRes = await httpJson('GET', url('/api/benchmarks/contests?source=sherlock'));
        expect(filteredRes.body.total).toBe(1);
        expect(filteredRes.body.contests[0].id).toBe('c-1');
    });

    it('POST + GET findings for contest', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/benchmarks/contests'), {
            id: 'c-1', source: 'sherlock', externalId: 'e1', name: 'Contest',
            sponsor: 'S', temporalBucket: '2025-Q1',
            codeRepoUrl: '', codeRepoPath: '', scopeFiles: [],
            totalFindings: 1, findingsBySeverity: { high: 1 },
        });

        const postRes = await httpJson('POST', url('/api/benchmarks/contests/c-1/findings'), {
            findings: [{
                id: 'f-1',
                contestId: 'c-1',
                externalId: 'ext-f1',
                severity: 'high',
                title: 'Reentrancy',
                description: 'Description',
                impact: 'Loss of funds',
                affectedFiles: [],
                labels: ['reentrancy'],
            }],
        });
        expect(postRes.status).toBe(201);
        expect(postRes.body.upserted).toBe(1);

        const getRes = await httpJson('GET', url('/api/benchmarks/contests/c-1/findings'));
        expect(getRes.body.total).toBe(1);
        expect(getRes.body.findings[0].title).toBe('Reentrancy');
    });
});

describe('Benchmark REST API - Runs', () => {
    it('POST + GET run round-trip', async () => {
        testnet = await createTestnet();

        const run = {
            id: 'run-1',
            agentId: 'hunter',
            agentVersion: '1.0',
            contestId: 'c-1',
            startedAt: '2025-01-15T10:00:00Z',
            status: 'pending',
        };

        const postRes = await httpJson('POST', url('/api/benchmarks/runs'), run);
        expect(postRes.status).toBe(201);

        const getRes = await httpJson('GET', url('/api/benchmarks/runs/run-1'));
        expect(getRes.status).toBe(200);
        expect(getRes.body.agentId).toBe('hunter');
        expect(getRes.body.status).toBe('pending');
    });

    it('PATCH updates run status', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/benchmarks/runs'), {
            id: 'run-1', agentId: 'hunter', agentVersion: '1.0',
            contestId: 'c-1', startedAt: '2025-01-15T10:00:00Z', status: 'pending',
        });

        const patchRes = await httpPatch(url('/api/benchmarks/runs/run-1'), {
            status: 'running',
        });
        expect(patchRes.status).toBe(200);

        const getRes = await httpJson('GET', url('/api/benchmarks/runs/run-1'));
        expect(getRes.body.status).toBe('running');
    });

    it('lists runs filtered by agentId', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/benchmarks/runs'), {
            id: 'r-1', agentId: 'hunter', agentVersion: '1.0',
            contestId: 'c-1', startedAt: '2025-01-15T10:00:00Z', status: 'pending',
        });
        await httpJson('POST', url('/api/benchmarks/runs'), {
            id: 'r-2', agentId: 'cartographer', agentVersion: '1.0',
            contestId: 'c-1', startedAt: '2025-01-15T11:00:00Z', status: 'pending',
        });

        const res = await httpJson('GET', url('/api/benchmarks/runs?agentId=hunter'));
        expect(res.body.total).toBe(1);
        expect(res.body.runs[0].id).toBe('r-1');
    });

    it('returns 404 for missing run', async () => {
        testnet = await createTestnet();
        const res = await httpJson('GET', url('/api/benchmarks/runs/nonexistent'));
        expect(res.status).toBe(404);
    });
});

describe('Benchmark REST API - Results', () => {
    it('POST + GET result round-trip', async () => {
        testnet = await createTestnet();

        const result = {
            id: 'result-1',
            runId: 'run-1',
            agentId: 'hunter',
            agentVersion: '1.0',
            contestId: 'c-1',
            evaluatedAt: '2025-01-15T10:30:00Z',
            score: { pointsEarned: 50, pointsPossible: 100, percentage: 50 },
            metrics: {
                recall: 0.6, precision: 0.8, f1Score: 0.69,
                totalSubmissions: 10, validMatches: 6,
                duplicateSubmissions: 1, novelSubmissions: 3,
            },
            bySeverity: {
                high: { earned: 30, possible: 50, found: 2, total: 3 },
            },
        };

        const postRes = await httpJson('POST', url('/api/benchmarks/results'), result);
        expect(postRes.status).toBe(201);

        const listRes = await httpJson('GET', url('/api/benchmarks/results?agentId=hunter'));
        expect(listRes.body.total).toBe(1);
        expect(listRes.body.results[0].score.percentage).toBe(50);
    });

    it('lists results filtered by contestId', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/benchmarks/results'), {
            id: 'r-1', runId: 'run-1', agentId: 'hunter', agentVersion: '1.0',
            contestId: 'c-1', evaluatedAt: '2025-01-15T10:30:00Z',
            score: { pointsEarned: 50, pointsPossible: 100, percentage: 50 },
            metrics: { recall: 0.6, precision: 0.8, f1Score: 0.69, totalSubmissions: 10, validMatches: 6, duplicateSubmissions: 1, novelSubmissions: 3 },
            bySeverity: {},
        });
        await httpJson('POST', url('/api/benchmarks/results'), {
            id: 'r-2', runId: 'run-2', agentId: 'hunter', agentVersion: '1.0',
            contestId: 'c-2', evaluatedAt: '2025-01-16T10:30:00Z',
            score: { pointsEarned: 80, pointsPossible: 100, percentage: 80 },
            metrics: { recall: 0.9, precision: 0.85, f1Score: 0.87, totalSubmissions: 12, validMatches: 9, duplicateSubmissions: 0, novelSubmissions: 3 },
            bySeverity: {},
        });

        const res = await httpJson('GET', url('/api/benchmarks/results?contestId=c-2'));
        expect(res.body.total).toBe(1);
        expect(res.body.results[0].id).toBe('r-2');
    });
});

describe('Benchmark REST API - Agent History', () => {
    it('returns score history for an agent', async () => {
        testnet = await createTestnet();

        // Create contests first
        await httpJson('POST', url('/api/benchmarks/contests'), {
            id: 'c-1', source: 'sherlock', externalId: 'e1', name: 'Alpha Audit',
            sponsor: 'S', temporalBucket: '2025-Q1',
            codeRepoUrl: '', codeRepoPath: '', scopeFiles: [],
            totalFindings: 0, findingsBySeverity: {},
        });

        // Create results
        await httpJson('POST', url('/api/benchmarks/results'), {
            id: 'r-1', runId: 'run-1', agentId: 'hunter', agentVersion: '1.0',
            contestId: 'c-1', evaluatedAt: '2025-01-15T10:30:00Z',
            score: { pointsEarned: 50, pointsPossible: 100, percentage: 50 },
            metrics: { recall: 0.6, precision: 0.8, f1Score: 0.69, totalSubmissions: 10, validMatches: 6, duplicateSubmissions: 1, novelSubmissions: 3 },
            bySeverity: {},
        });

        const res = await httpJson('GET', url('/api/benchmarks/agents/hunter/history'));
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.history[0].contestName).toBe('Alpha Audit');
        expect(res.body.history[0].percentage).toBe(50);
        expect(res.body.history[0].recall).toBe(0.6);
    });

    it('returns empty history for unknown agent', async () => {
        testnet = await createTestnet();
        const res = await httpJson('GET', url('/api/benchmarks/agents/unknown/history'));
        expect(res.body.total).toBe(0);
    });
});

describe('Benchmark REST API - Validation', () => {
    it('returns 400 when contest missing required fields', async () => {
        testnet = await createTestnet();
        const res = await httpJson('POST', url('/api/benchmarks/contests'), { id: 'c-1' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when run missing required fields', async () => {
        testnet = await createTestnet();
        const res = await httpJson('POST', url('/api/benchmarks/runs'), { id: 'run-1' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when result missing required fields', async () => {
        testnet = await createTestnet();
        const res = await httpJson('POST', url('/api/benchmarks/results'), { id: 'result-1' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when findings body is invalid', async () => {
        testnet = await createTestnet();
        const res = await httpJson('POST', url('/api/benchmarks/contests/c-1/findings'), {});
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('findings array');
    });
});
