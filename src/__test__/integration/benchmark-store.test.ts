/**
 * @fileoverview Unit tests for BenchmarkStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BenchmarkStore } from '../../benchmark/BenchmarkStore';
import type { BenchmarkContest, KnownFinding, BenchmarkRun, BenchmarkResult } from '@sera/types';

let store: BenchmarkStore;
let tmpDir: string;

function makeContest(overrides?: Partial<BenchmarkContest>): BenchmarkContest {
    return {
        id: 'contest-1',
        source: 'sherlock',
        externalId: 'ext-1',
        name: 'Test Contest',
        sponsor: 'TestSponsor',
        temporalBucket: '2025-Q1',
        codeRepoUrl: 'https://github.com/test/repo',
        codeRepoPath: '/path/to/code',
        scopeFiles: ['src/Contract.sol'],
        totalFindings: 5,
        findingsBySeverity: { high: 2, medium: 3 },
        ...overrides,
    };
}

function makeFinding(overrides?: Partial<KnownFinding>): KnownFinding {
    return {
        id: 'finding-1',
        contestId: 'contest-1',
        externalId: 'ext-f1',
        severity: 'high',
        title: 'Reentrancy in withdraw()',
        description: 'The withdraw function is vulnerable.',
        impact: 'Loss of funds.',
        affectedFiles: [{ path: 'src/Vault.sol', lines: { start: 42, end: 58 } }],
        labels: ['reentrancy'],
        ...overrides,
    };
}

function makeRun(overrides?: Partial<BenchmarkRun>): BenchmarkRun {
    return {
        id: 'run-1',
        agentId: 'agent-1',
        agentVersion: '1.0.0',
        contestId: 'contest-1',
        startedAt: '2025-01-15T10:00:00Z',
        status: 'pending',
        ...overrides,
    };
}

function makeResult(overrides?: Partial<BenchmarkResult>): BenchmarkResult {
    return {
        id: 'result-1',
        runId: 'run-1',
        agentId: 'agent-1',
        agentVersion: '1.0.0',
        contestId: 'contest-1',
        evaluatedAt: '2025-01-15T10:30:00Z',
        score: { pointsEarned: 50, pointsPossible: 100, percentage: 50 },
        metrics: {
            recall: 0.6,
            precision: 0.8,
            f1Score: 0.69,
            totalSubmissions: 10,
            validMatches: 6,
            duplicateSubmissions: 1,
            novelSubmissions: 3,
        },
        bySeverity: {
            high: { earned: 30, possible: 50, found: 2, total: 3 },
            medium: { earned: 20, possible: 50, found: 3, total: 5 },
        },
        ...overrides,
    };
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
    store = new BenchmarkStore(tmpDir);
    await store.initialize();
});

afterEach(async () => {
    await store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BenchmarkStore - Contests', () => {
    it('upserts and retrieves a contest', () => {
        const contest = makeContest();
        store.upsertContest(contest);

        const got = store.getContest('contest-1');
        expect(got).not.toBeNull();
        expect(got!.id).toBe('contest-1');
        expect(got!.name).toBe('Test Contest');
        expect(got!.scopeFiles).toEqual(['src/Contract.sol']);
        expect(got!.findingsBySeverity).toEqual({ high: 2, medium: 3 });
    });

    it('returns null for missing contest', () => {
        expect(store.getContest('nonexistent')).toBeNull();
    });

    it('updates existing contest on upsert', () => {
        store.upsertContest(makeContest());
        store.upsertContest(makeContest({ name: 'Updated Contest', totalFindings: 10 }));

        const got = store.getContest('contest-1');
        expect(got!.name).toBe('Updated Contest');
        expect(got!.totalFindings).toBe(10);
    });

    it('lists contests ordered by name', () => {
        store.upsertContest(makeContest({ id: 'c-2', name: 'Zebra Audit' }));
        store.upsertContest(makeContest({ id: 'c-1', name: 'Alpha Audit' }));

        const list = store.listContests();
        expect(list).toHaveLength(2);
        expect(list[0].name).toBe('Alpha Audit');
        expect(list[1].name).toBe('Zebra Audit');
    });

    it('filters contests by source', () => {
        store.upsertContest(makeContest({ id: 'c-1', source: 'sherlock' }));
        store.upsertContest(makeContest({ id: 'c-2', source: 'code4rena' }));

        const sherlock = store.listContests({ source: 'sherlock' });
        expect(sherlock).toHaveLength(1);
        expect(sherlock[0].id).toBe('c-1');
    });

    it('filters contests by temporal bucket', () => {
        store.upsertContest(makeContest({ id: 'c-1', temporalBucket: '2025-Q1' }));
        store.upsertContest(makeContest({ id: 'c-2', temporalBucket: '2025-Q2' }));

        const q2 = store.listContests({ temporalBucket: '2025-Q2' });
        expect(q2).toHaveLength(1);
        expect(q2[0].id).toBe('c-2');
    });

    it('preserves optional fields', () => {
        store.upsertContest(makeContest({
            startDate: '2025-01-01',
            endDate: '2025-01-15',
            codeCommitHash: 'abc123',
            scopeDescription: 'All contracts in src/',
        }));

        const got = store.getContest('contest-1')!;
        expect(got.startDate).toBe('2025-01-01');
        expect(got.endDate).toBe('2025-01-15');
        expect(got.codeCommitHash).toBe('abc123');
        expect(got.scopeDescription).toBe('All contracts in src/');
    });
});

describe('BenchmarkStore - Known Findings', () => {
    it('upserts and retrieves findings for a contest', () => {
        store.upsertContest(makeContest());
        store.upsertFinding(makeFinding());
        store.upsertFinding(makeFinding({ id: 'finding-2', severity: 'medium', title: 'Missing check' }));

        const findings = store.getFindingsForContest('contest-1');
        expect(findings).toHaveLength(2);
    });

    it('returns empty array for contest with no findings', () => {
        store.upsertContest(makeContest());
        const findings = store.getFindingsForContest('contest-1');
        expect(findings).toHaveLength(0);
    });

    it('preserves affected files structure', () => {
        store.upsertContest(makeContest());
        store.upsertFinding(makeFinding());

        const findings = store.getFindingsForContest('contest-1');
        expect(findings[0].affectedFiles).toEqual([
            { path: 'src/Vault.sol', lines: { start: 42, end: 58 } },
        ]);
    });

    it('updates existing finding on upsert', () => {
        store.upsertContest(makeContest());
        store.upsertFinding(makeFinding());
        store.upsertFinding(makeFinding({ title: 'Updated title' }));

        const findings = store.getFindingsForContest('contest-1');
        expect(findings).toHaveLength(1);
        expect(findings[0].title).toBe('Updated title');
    });
});

describe('BenchmarkStore - Runs', () => {
    it('creates and retrieves a run', () => {
        store.createRun(makeRun());

        const got = store.getRun('run-1');
        expect(got).not.toBeNull();
        expect(got!.agentId).toBe('agent-1');
        expect(got!.status).toBe('pending');
    });

    it('returns null for missing run', () => {
        expect(store.getRun('nonexistent')).toBeNull();
    });

    it('updates run status', () => {
        store.createRun(makeRun());
        store.updateRun('run-1', { status: 'running' });

        const got = store.getRun('run-1');
        expect(got!.status).toBe('running');
    });

    it('updates run with completion and error', () => {
        store.createRun(makeRun());
        store.updateRun('run-1', {
            status: 'failed',
            completedAt: '2025-01-15T10:05:00Z',
            error: 'Timeout',
        });

        const got = store.getRun('run-1');
        expect(got!.status).toBe('failed');
        expect(got!.completedAt).toBe('2025-01-15T10:05:00Z');
        expect(got!.error).toBe('Timeout');
    });

    it('lists runs filtered by agentId', () => {
        store.createRun(makeRun({ id: 'r-1', agentId: 'agent-a' }));
        store.createRun(makeRun({ id: 'r-2', agentId: 'agent-b' }));

        const runs = store.listRuns({ agentId: 'agent-a' });
        expect(runs).toHaveLength(1);
        expect(runs[0].id).toBe('r-1');
    });

    it('lists runs filtered by contestId', () => {
        store.createRun(makeRun({ id: 'r-1', contestId: 'c-1' }));
        store.createRun(makeRun({ id: 'r-2', contestId: 'c-2' }));

        const runs = store.listRuns({ contestId: 'c-2' });
        expect(runs).toHaveLength(1);
        expect(runs[0].id).toBe('r-2');
    });

    it('orders runs by startedAt descending', () => {
        store.createRun(makeRun({ id: 'r-1', startedAt: '2025-01-15T09:00:00Z' }));
        store.createRun(makeRun({ id: 'r-2', startedAt: '2025-01-15T11:00:00Z' }));

        const runs = store.listRuns();
        expect(runs[0].id).toBe('r-2');
        expect(runs[1].id).toBe('r-1');
    });
});

describe('BenchmarkStore - Results', () => {
    it('saves and retrieves a result', () => {
        store.saveResult(makeResult());

        const got = store.getResult('result-1');
        expect(got).not.toBeNull();
        expect(got!.score.percentage).toBe(50);
        expect(got!.metrics.recall).toBe(0.6);
    });

    it('returns null for missing result', () => {
        expect(store.getResult('nonexistent')).toBeNull();
    });

    it('lists results filtered by agentId', () => {
        store.saveResult(makeResult({ id: 'r-1', agentId: 'agent-a' }));
        store.saveResult(makeResult({ id: 'r-2', agentId: 'agent-b' }));

        const results = store.listResults({ agentId: 'agent-a' });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('r-1');
    });

    it('lists results filtered by contestId', () => {
        store.saveResult(makeResult({ id: 'r-1', contestId: 'c-1' }));
        store.saveResult(makeResult({ id: 'r-2', contestId: 'c-2' }));

        const results = store.listResults({ contestId: 'c-2' });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('r-2');
    });

    it('preserves severity breakdown', () => {
        store.saveResult(makeResult());

        const got = store.getResult('result-1')!;
        expect(got.bySeverity.high).toEqual({ earned: 30, possible: 50, found: 2, total: 3 });
        expect(got.bySeverity.medium).toEqual({ earned: 20, possible: 50, found: 3, total: 5 });
    });

    it('updates existing result on save (upsert)', () => {
        store.saveResult(makeResult());
        store.saveResult(makeResult({ score: { pointsEarned: 75, pointsPossible: 100, percentage: 75 } }));

        const got = store.getResult('result-1')!;
        expect(got.score.percentage).toBe(75);
    });
});

describe('BenchmarkStore - Agent History', () => {
    it('returns empty history for unknown agent', () => {
        const history = store.getAgentHistory('unknown');
        expect(history).toHaveLength(0);
    });

    it('returns score history ordered by date', () => {
        store.upsertContest(makeContest({ id: 'c-1', name: 'Alpha' }));
        store.upsertContest(makeContest({ id: 'c-2', name: 'Beta' }));

        store.saveResult(makeResult({
            id: 'r-1', agentId: 'hunter', contestId: 'c-1',
            evaluatedAt: '2025-01-15T10:00:00Z',
            score: { pointsEarned: 50, pointsPossible: 100, percentage: 50 },
            metrics: { recall: 0.6, precision: 0.8, f1Score: 0.69, totalSubmissions: 10, validMatches: 6, duplicateSubmissions: 1, novelSubmissions: 3 },
        }));
        store.saveResult(makeResult({
            id: 'r-2', agentId: 'hunter', contestId: 'c-2',
            evaluatedAt: '2025-01-16T10:00:00Z',
            score: { pointsEarned: 80, pointsPossible: 100, percentage: 80 },
            metrics: { recall: 0.9, precision: 0.85, f1Score: 0.87, totalSubmissions: 12, validMatches: 9, duplicateSubmissions: 0, novelSubmissions: 3 },
        }));

        const history = store.getAgentHistory('hunter');
        expect(history).toHaveLength(2);
        expect(history[0].contestName).toBe('Alpha');
        expect(history[0].percentage).toBe(50);
        expect(history[1].contestName).toBe('Beta');
        expect(history[1].percentage).toBe(80);
    });
});

describe('BenchmarkStore - Persistence', () => {
    it('data survives shutdown and reinitialization', async () => {
        store.upsertContest(makeContest());
        store.upsertFinding(makeFinding());
        store.createRun(makeRun());
        store.saveResult(makeResult());
        await store.shutdown();

        // Reopen at the same path
        const store2 = new BenchmarkStore(tmpDir);
        await store2.initialize();

        expect(store2.getContest('contest-1')).not.toBeNull();
        expect(store2.getFindingsForContest('contest-1')).toHaveLength(1);
        expect(store2.getRun('run-1')).not.toBeNull();
        expect(store2.getResult('result-1')).not.toBeNull();

        // Replace the module-level store so afterEach cleans up store2
        store = store2;
    });
});
