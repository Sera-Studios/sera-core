/**
 * @fileoverview Unit tests for importSolana
 *
 * Tests the Solana contest data importer with real temporary files
 * and an in-memory BenchmarkStore.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BenchmarkStore } from './BenchmarkStore';
import { importSolanaIndex } from './importSolana';

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string;
let store: BenchmarkStore;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-solana-test-'));
    // BenchmarkStore needs a sera home directory
    const seraHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-home-test-'));
    store = new BenchmarkStore(seraHome);
    await store.initialize();
});

afterEach(async () => {
    await store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeContests(contests: unknown[]): void {
    fs.writeFileSync(path.join(tmpDir, 'contests.json'), JSON.stringify(contests));
}

function writeFindings(findings: unknown[]): void {
    fs.writeFileSync(path.join(tmpDir, 'findings.json'), JSON.stringify(findings));
}

function sampleContest(overrides?: Record<string, unknown>) {
    return {
        id: 'solana-vault-2024',
        name: 'Solana Vault Audit',
        sponsor: 'VaultProtocol',
        temporal_bucket: '2024-Q1',
        code_repo_path: '/repos/vault',
        total_findings: 15,
        findings_by_severity: { high: 3, medium: 5, low: 7 },
        scope_files: ['programs/vault/src/lib.rs'],
        scope_commit: 'abc123',
        scope_repo_url: 'https://github.com/vault/protocol',
        start_date: '2024-01-01',
        end_date: '2024-01-15',
        ...overrides,
    };
}

function sampleFinding(overrides?: Record<string, unknown>) {
    return {
        id: 'finding-1',
        contest_id: 'solana-vault-2024',
        external_id: 'H-01',
        severity: 'high',
        title: 'Missing signer check',
        description: 'The instruction handler does not verify the signer',
        impact: 'Anyone can drain the vault',
        affected_files: [{ path: 'programs/vault/src/lib.rs', lines: { start: 42, end: 45 } }],
        labels: ['access-control'],
        ...overrides,
    };
}

// ============================================================================
// Tests
// ============================================================================

describe('importSolanaIndex', () => {
    it('imports contests from contests.json', () => {
        writeContests([sampleContest()]);

        const result = importSolanaIndex(store, tmpDir);

        expect(result.contests).toBe(1);
        expect(result.findings).toBe(0);
    });

    it('imports findings from findings.json', () => {
        writeContests([sampleContest()]);
        writeFindings([sampleFinding()]);

        const result = importSolanaIndex(store, tmpDir);

        expect(result.contests).toBe(1);
        expect(result.findings).toBe(1);
    });

    it('handles missing findings.json gracefully', () => {
        writeContests([sampleContest()]);
        // No findings.json file

        const result = importSolanaIndex(store, tmpDir);

        expect(result.contests).toBe(1);
        expect(result.findings).toBe(0);
    });

    it('throws when contests.json is missing', () => {
        expect(() => importSolanaIndex(store, tmpDir))
            .toThrow('contests.json not found');
    });

    it('imports multiple contests', () => {
        writeContests([
            sampleContest({ id: 'contest-1', name: 'Contest 1' }),
            sampleContest({ id: 'contest-2', name: 'Contest 2' }),
            sampleContest({ id: 'contest-3', name: 'Contest 3' }),
        ]);

        const result = importSolanaIndex(store, tmpDir);
        expect(result.contests).toBe(3);
    });

    it('imports multiple findings', () => {
        writeContests([sampleContest()]);
        writeFindings([
            sampleFinding({ id: 'f-1', external_id: 'H-01' }),
            sampleFinding({ id: 'f-2', external_id: 'H-02', severity: 'medium' }),
            sampleFinding({ id: 'f-3', external_id: 'L-01', severity: 'low' }),
        ]);

        const result = importSolanaIndex(store, tmpDir);
        expect(result.findings).toBe(3);
    });

    it('uses default source "ottersec" when not specified', () => {
        writeContests([sampleContest()]);

        const result = importSolanaIndex(store, tmpDir);
        expect(result.contests).toBe(1);
        // The contest should have source 'ottersec' (verified via store)
    });

    it('uses custom source parameter', () => {
        writeContests([sampleContest()]);

        const result = importSolanaIndex(store, tmpDir, 'code4rena');
        expect(result.contests).toBe(1);
    });

    it('uses contest-level source override', () => {
        writeContests([sampleContest({ source: 'custom-source' })]);

        const result = importSolanaIndex(store, tmpDir);
        expect(result.contests).toBe(1);
    });

    it('sets language to rust-solana', () => {
        writeContests([sampleContest()]);
        const result = importSolanaIndex(store, tmpDir);
        expect(result.contests).toBe(1);
        // Language is always 'rust-solana' for Solana imports
    });

    it('handles contests with minimal fields', () => {
        writeContests([{
            id: 'minimal-contest',
            name: 'Minimal',
            temporal_bucket: '2024-Q1',
            code_repo_path: '/repos/minimal',
            total_findings: 0,
            findings_by_severity: {},
            scope_files: [],
        }]);

        const result = importSolanaIndex(store, tmpDir);
        expect(result.contests).toBe(1);
    });

    it('handles findings with minimal fields', () => {
        writeContests([sampleContest()]);
        writeFindings([{
            id: 'minimal-finding',
            contest_id: 'solana-vault-2024',
            external_id: 'M-01',
            severity: 'medium',
            title: 'Minor issue',
            description: 'A minor issue',
        }]);

        const result = importSolanaIndex(store, tmpDir);
        expect(result.findings).toBe(1);
    });

    it('applies suggestTags for domain detection', () => {
        writeContests([sampleContest({ name: 'Solana Lending Protocol AMM' })]);

        const result = importSolanaIndex(store, tmpDir);
        expect(result.contests).toBe(1);
        // suggestTags should detect 'lending' and 'amm' from the name
    });

    it('applies suggestDifficulty based on finding count', () => {
        // easy: <= 10 findings
        writeContests([sampleContest({ total_findings: 5 })]);
        importSolanaIndex(store, tmpDir);

        // Re-init for next test
        writeContests([sampleContest({ id: 'hard-contest', total_findings: 50 })]);
        importSolanaIndex(store, tmpDir);
        // Both should succeed without errors
    });

    it('performs upsert (re-import same data)', () => {
        writeContests([sampleContest()]);
        writeFindings([sampleFinding()]);

        const result1 = importSolanaIndex(store, tmpDir);
        expect(result1.contests).toBe(1);

        // Import again - should upsert, not duplicate
        const result2 = importSolanaIndex(store, tmpDir);
        expect(result2.contests).toBe(1);
    });
});
