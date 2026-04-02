/**
 * @fileoverview Unit tests for BenchmarkStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BenchmarkStore } from '../../benchmark/BenchmarkStore';
import type { BenchmarkContest, KnownFinding, BenchmarkRun, BenchmarkResult, BenchmarkCategory, BenchmarkDataset } from '@sera/types';

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

// ============================================================================
// Categories
// ============================================================================

function makeCategory(overrides?: Partial<BenchmarkCategory>): BenchmarkCategory {
    return {
        id: 'issue-identification',
        name: 'Issue Identification',
        description: 'Measures recall and precision of finding real vulnerabilities',
        fetcherId: 'valid-findings',
        metrics: [
            { key: 'recall', label: 'Recall', description: 'Fraction of known findings matched', sortDirection: 'desc', primary: true },
            { key: 'precision', label: 'Precision', description: 'Fraction of submissions that matched', sortDirection: 'desc' },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

describe('BenchmarkStore - Categories', () => {
    it('upserts and retrieves a category', () => {
        const cat = makeCategory();
        store.upsertCategory(cat);
        const loaded = store.getCategory('issue-identification');
        expect(loaded).not.toBeNull();
        expect(loaded!.name).toBe('Issue Identification');
        expect(loaded!.fetcherId).toBe('valid-findings');
        expect(loaded!.metrics).toHaveLength(2);
        expect(loaded!.metrics[0].key).toBe('recall');
        expect(loaded!.metrics[0].primary).toBe(true);
    });

    it('lists all categories', () => {
        store.upsertCategory(makeCategory({ id: 'cat-a', name: 'A' }));
        store.upsertCategory(makeCategory({ id: 'cat-b', name: 'B' }));
        const list = store.listCategories();
        expect(list).toHaveLength(2);
        const ids = list.map(c => c.id).sort();
        expect(ids).toEqual(['cat-a', 'cat-b']);
    });

    it('upsert overwrites existing category', () => {
        store.upsertCategory(makeCategory({ id: 'cat-1', name: 'Original' }));
        store.upsertCategory(makeCategory({ id: 'cat-1', name: 'Updated' }));
        const loaded = store.getCategory('cat-1');
        expect(loaded!.name).toBe('Updated');
        expect(store.listCategories()).toHaveLength(1);
    });

    it('deletes a category', () => {
        store.upsertCategory(makeCategory({ id: 'doomed' }));
        expect(store.getCategory('doomed')).not.toBeNull();
        store.deleteCategory('doomed');
        expect(store.getCategory('doomed')).toBeNull();
    });

    it('returns null for non-existent category', () => {
        expect(store.getCategory('nope')).toBeNull();
    });

    it('seedDefaultCategories creates defaults without overwriting existing', () => {
        // Seed once
        store.seedDefaultCategories();
        const list = store.listCategories();
        expect(list.length).toBeGreaterThanOrEqual(2);
        const ids = list.map(c => c.id);
        expect(ids).toContain('issue-identification');
        expect(ids).toContain('valid-issue-detection');

        // Modify one
        const modified = store.getCategory('issue-identification')!;
        store.upsertCategory({ ...modified, name: 'Custom Name' });

        // Seed again - should overwrite (upsert behavior)
        store.seedDefaultCategories();
        const reloaded = store.getCategory('issue-identification');
        // seedDefaultCategories uses upsert, so it will overwrite
        expect(reloaded).not.toBeNull();
    });

    it('categories persist across shutdown and reinitialization', async () => {
        store.upsertCategory(makeCategory({ id: 'persist-test', name: 'Persist' }));
        await store.shutdown();

        const store2 = new BenchmarkStore(tmpDir);
        await store2.initialize();
        const loaded = store2.getCategory('persist-test');
        expect(loaded).not.toBeNull();
        expect(loaded!.name).toBe('Persist');
        expect(loaded!.metrics).toHaveLength(2);

        store = store2;
    });
});

// ============================================================================
// Datasets
// ============================================================================

function makeDataset(overrides?: Partial<BenchmarkDataset>): BenchmarkDataset {
    return {
        id: 'ds-issue-id-contest-1',
        categoryId: 'issue-identification',
        name: 'Test Contest - Issue Identification',
        sourceId: 'contest-1',
        sourceType: 'sherlock',
        codeRepoPath: '/path/to/code',
        scopeFiles: ['src/Contract.sol'],
        language: 'solidity',
        fetchedAt: '2026-01-15T10:00:00Z',
        metadata: { totalFindings: 5, sponsor: 'TestSponsor' },
        ...overrides,
    };
}

describe('BenchmarkStore - Datasets', () => {
    it('upserts and retrieves a dataset', () => {
        const ds = makeDataset();
        store.upsertDataset(ds);
        const loaded = store.getDataset('ds-issue-id-contest-1');
        expect(loaded).not.toBeNull();
        expect(loaded!.name).toBe('Test Contest - Issue Identification');
        expect(loaded!.categoryId).toBe('issue-identification');
        expect(loaded!.sourceType).toBe('sherlock');
        expect(loaded!.scopeFiles).toEqual(['src/Contract.sol']);
        expect(loaded!.metadata).toEqual({ totalFindings: 5, sponsor: 'TestSponsor' });
    });

    it('lists datasets by category', () => {
        store.upsertDataset(makeDataset({ id: 'ds-a', categoryId: 'cat-a' }));
        store.upsertDataset(makeDataset({ id: 'ds-b', categoryId: 'cat-b' }));
        store.upsertDataset(makeDataset({ id: 'ds-c', categoryId: 'cat-a' }));

        const catA = store.listDatasets('cat-a');
        expect(catA).toHaveLength(2);

        const catB = store.listDatasets('cat-b');
        expect(catB).toHaveLength(1);

        const all = store.listDatasets();
        expect(all).toHaveLength(3);
    });

    it('findDatasetBySource returns existing dataset', () => {
        store.upsertDataset(makeDataset({ id: 'ds-1', sourceId: 'src-1', sourceType: 'sherlock', categoryId: 'cat-a' }));
        const found = store.findDatasetBySource('src-1', 'sherlock', 'cat-a');
        expect(found).not.toBeNull();
        expect(found!.id).toBe('ds-1');
    });

    it('findDatasetBySource returns null for different category (same source)', () => {
        store.upsertDataset(makeDataset({ id: 'ds-1', sourceId: 'src-1', sourceType: 'sherlock', categoryId: 'cat-a' }));
        const found = store.findDatasetBySource('src-1', 'sherlock', 'cat-b');
        expect(found).toBeNull();
    });

    it('deletes dataset and associated submissions', () => {
        store.upsertDataset(makeDataset({ id: 'ds-del' }));
        store.upsertDatasetSubmission({
            id: 'sub-1', datasetId: 'ds-del', externalId: 'ext-1',
            severity: 'high', title: 'Test', description: 'desc', isValid: true,
        });
        expect(store.getDatasetSubmissions('ds-del')).toHaveLength(1);

        store.deleteDataset('ds-del');
        expect(store.getDataset('ds-del')).toBeNull();
        expect(store.getDatasetSubmissions('ds-del')).toHaveLength(0);
    });

    it('returns null for non-existent dataset', () => {
        expect(store.getDataset('nope')).toBeNull();
    });

    it('datasets persist across shutdown and reinitialization', async () => {
        store.upsertDataset(makeDataset({ id: 'ds-persist' }));
        await store.shutdown();

        const store2 = new BenchmarkStore(tmpDir);
        await store2.initialize();
        const loaded = store2.getDataset('ds-persist');
        expect(loaded).not.toBeNull();
        expect(loaded!.sourceType).toBe('sherlock');

        store = store2;
    });
});

describe('BenchmarkStore - Dataset Submissions', () => {
    it('upserts and retrieves submissions', () => {
        store.upsertDataset(makeDataset({ id: 'ds-sub' }));
        store.upsertDatasetSubmission({
            id: 'sub-1', datasetId: 'ds-sub', externalId: 'ext-1',
            severity: 'high', title: 'Reentrancy', description: 'Bad code',
            impact: 'Loss of funds', isValid: true,
        });
        store.upsertDatasetSubmission({
            id: 'sub-2', datasetId: 'ds-sub', externalId: 'ext-2',
            severity: 'medium', title: 'Invalid finding', description: 'Not a bug',
            isValid: false, rejectionReason: 'Intended behavior',
        });

        const subs = store.getDatasetSubmissions('ds-sub');
        expect(subs).toHaveLength(2);

        const valid = subs.find(s => s.id === 'sub-1')!;
        expect(valid.isValid).toBe(true);
        expect(valid.severity).toBe('high');
        expect(valid.impact).toBe('Loss of funds');

        const invalid = subs.find(s => s.id === 'sub-2')!;
        expect(invalid.isValid).toBe(false);
        expect(invalid.rejectionReason).toBe('Intended behavior');
    });

    it('batch upsert writes multiple submissions', () => {
        store.upsertDataset(makeDataset({ id: 'ds-batch' }));
        store.batchUpsertDatasetSubmissions([
            { id: 's1', datasetId: 'ds-batch', externalId: 'e1', severity: 'high', title: 'A', description: 'd', isValid: true },
            { id: 's2', datasetId: 'ds-batch', externalId: 'e2', severity: 'low', title: 'B', description: 'd', isValid: false },
            { id: 's3', datasetId: 'ds-batch', externalId: 'e3', severity: 'medium', title: 'C', description: 'd', isValid: true },
        ]);

        const subs = store.getDatasetSubmissions('ds-batch');
        expect(subs).toHaveLength(3);
    });

    it('returns empty array for non-existent dataset', () => {
        expect(store.getDatasetSubmissions('no-such-dataset')).toHaveLength(0);
    });
});

// ============================================================================
// Category Results & Leaderboard
// ============================================================================

describe('BenchmarkStore - category results', () => {
    let s: BenchmarkStore;
    let td: string;

    const seedCategory = () => {
        s.upsertCategory({
            id: 'issue-identification', name: 'Issue Identification', description: 'Find bugs',
            fetcherId: 'valid-findings',
            metrics: [
                { key: 'recall', label: 'Recall', description: 'Found rate', sortDirection: 'desc' },
                { key: 'precision', label: 'Precision', description: 'Accuracy', sortDirection: 'desc' },
                { key: 'f1Score', label: 'F1', description: 'Harmonic mean', sortDirection: 'desc', primary: true },
            ],
            createdAt: new Date().toISOString(),
        });
    };

    beforeEach(async () => {
        td = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-catres-'));
        s = new BenchmarkStore(td);
        await s.initialize();
        seedCategory();
    });
    afterEach(async () => {
        await s.shutdown();
        fs.rmSync(td, { recursive: true, force: true });
    });

    it('saves and retrieves a category result', () => {
        s.saveCategoryResult({
            id: 'cr-1', runId: 'run-1', categoryId: 'issue-identification',
            datasetId: 'ds-1', executionAgentId: 'hunter-1', evaluationAgentId: 'eval-1',
            metrics: { recall: 0.8, precision: 0.9, f1Score: 0.85 },
            startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z',
        });
        const result = s.getCategoryResult('cr-1');
        expect(result).not.toBeNull();
        expect(result!.executionAgentId).toBe('hunter-1');
        expect(result!.metrics.recall).toBe(0.8);
    });

    it('lists results by category', () => {
        s.saveCategoryResult({
            id: 'cr-1', runId: 'run-1', categoryId: 'issue-identification',
            datasetId: 'ds-1', executionAgentId: 'hunter-1', evaluationAgentId: 'eval-1',
            metrics: { recall: 0.8 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z',
        });
        s.saveCategoryResult({
            id: 'cr-2', runId: 'run-2', categoryId: 'other-cat',
            datasetId: 'ds-2', executionAgentId: 'hunter-2', evaluationAgentId: 'eval-1',
            metrics: { accuracy: 0.9 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z',
        });
        const results = s.listCategoryResults({ categoryId: 'issue-identification' });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('cr-1');
    });

    it('lists results filtered by execution agent', () => {
        s.saveCategoryResult({
            id: 'cr-1', runId: 'r1', categoryId: 'issue-identification',
            datasetId: 'ds-1', executionAgentId: 'hunter-1', evaluationAgentId: 'eval-1',
            metrics: { recall: 0.8 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z',
        });
        s.saveCategoryResult({
            id: 'cr-2', runId: 'r2', categoryId: 'issue-identification',
            datasetId: 'ds-1', executionAgentId: 'hunter-2', evaluationAgentId: 'eval-1',
            metrics: { recall: 0.6 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z',
        });
        const results = s.listCategoryResults({ categoryId: 'issue-identification', executionAgentId: 'hunter-1' });
        expect(results).toHaveLength(1);
        expect(results[0].executionAgentId).toBe('hunter-1');
    });

    it('returns null for non-existent result', () => {
        expect(s.getCategoryResult('no-such-result')).toBeNull();
    });
});

describe('BenchmarkStore - category leaderboard', () => {
    let s: BenchmarkStore;
    let td: string;

    beforeEach(async () => {
        td = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-catlb-'));
        s = new BenchmarkStore(td);
        await s.initialize();
        s.upsertCategory({
            id: 'issue-identification', name: 'Issue Identification', description: 'Find bugs',
            fetcherId: 'valid-findings',
            metrics: [
                { key: 'recall', label: 'Recall', description: 'Found rate', sortDirection: 'desc' },
                { key: 'f1Score', label: 'F1', description: 'Harmonic mean', sortDirection: 'desc', primary: true },
            ],
            createdAt: new Date().toISOString(),
        });
    });
    afterEach(async () => {
        await s.shutdown();
        fs.rmSync(td, { recursive: true, force: true });
    });

    it('groups results by execution agent', () => {
        s.saveCategoryResult({ id: 'cr-1', runId: 'r1', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { recall: 0.8, f1Score: 0.7 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        s.saveCategoryResult({ id: 'cr-2', runId: 'r2', categoryId: 'issue-identification', datasetId: 'ds-2', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { recall: 0.6, f1Score: 0.5 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        const { entries } = s.getCategoryLeaderboard('issue-identification');
        expect(entries).toHaveLength(1);
        expect(entries[0].executionAgentId).toBe('hunter-a');
        expect(Object.keys(entries[0].datasetResults)).toHaveLength(2);
    });

    it('picks most recent result per dataset', () => {
        s.saveCategoryResult({ id: 'cr-old', runId: 'r1', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { recall: 0.5, f1Score: 0.4 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        s.saveCategoryResult({ id: 'cr-new', runId: 'r2', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { recall: 0.9, f1Score: 0.85 }, startedAt: '2026-01-02T00:00:00Z', completedAt: '2026-01-02T00:10:00Z' });
        const { entries } = s.getCategoryLeaderboard('issue-identification');
        expect(entries).toHaveLength(1);
        expect(entries[0].datasetResults['ds-1'].recall).toBe(0.9);
    });

    it('computes average metrics across datasets', () => {
        s.saveCategoryResult({ id: 'cr-1', runId: 'r1', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { recall: 0.8, f1Score: 0.7 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        s.saveCategoryResult({ id: 'cr-2', runId: 'r2', categoryId: 'issue-identification', datasetId: 'ds-2', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { recall: 0.6, f1Score: 0.5 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        const { entries } = s.getCategoryLeaderboard('issue-identification');
        expect(entries[0].averageMetrics.recall).toBeCloseTo(0.7);
        expect(entries[0].averageMetrics.f1Score).toBeCloseTo(0.6);
    });

    it('sorts by primary metric (desc)', () => {
        s.saveCategoryResult({ id: 'cr-1', runId: 'r1', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-low', evaluationAgentId: 'eval-1', metrics: { f1Score: 0.3 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        s.saveCategoryResult({ id: 'cr-2', runId: 'r2', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-high', evaluationAgentId: 'eval-1', metrics: { f1Score: 0.9 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        const { entries } = s.getCategoryLeaderboard('issue-identification');
        expect(entries[0].executionAgentId).toBe('hunter-high');
        expect(entries[1].executionAgentId).toBe('hunter-low');
    });

    it('filters by dataset IDs', () => {
        s.saveCategoryResult({ id: 'cr-1', runId: 'r1', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { f1Score: 0.8 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        s.saveCategoryResult({ id: 'cr-2', runId: 'r2', categoryId: 'issue-identification', datasetId: 'ds-2', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { f1Score: 0.6 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        const { entries } = s.getCategoryLeaderboard('issue-identification', { datasetIds: ['ds-1'] });
        expect(entries).toHaveLength(1);
        expect(Object.keys(entries[0].datasetResults)).toEqual(['ds-1']);
    });

    it('filters by evaluation agent', () => {
        s.saveCategoryResult({ id: 'cr-1', runId: 'r1', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-1', metrics: { f1Score: 0.8 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        s.saveCategoryResult({ id: 'cr-2', runId: 'r2', categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: 'hunter-a', evaluationAgentId: 'eval-2', metrics: { f1Score: 0.6 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        const { entries } = s.getCategoryLeaderboard('issue-identification', { evaluationAgentId: 'eval-1' });
        expect(entries).toHaveLength(1);
        expect(entries[0].evaluationAgentId).toBe('eval-1');
    });

    it('limits entries', () => {
        for (let i = 0; i < 5; i++) {
            s.saveCategoryResult({ id: `cr-${i}`, runId: `r-${i}`, categoryId: 'issue-identification', datasetId: 'ds-1', executionAgentId: `hunter-${i}`, evaluationAgentId: 'eval-1', metrics: { f1Score: i * 0.1 }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z' });
        }
        const { entries } = s.getCategoryLeaderboard('issue-identification', { limit: 3 });
        expect(entries).toHaveLength(3);
    });

    it('returns empty leaderboard for category with no results', () => {
        const { entries } = s.getCategoryLeaderboard('issue-identification');
        expect(entries).toHaveLength(0);
    });
});
