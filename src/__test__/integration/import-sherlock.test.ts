/**
 * @fileoverview Tests for the Sherlock data import utility
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BenchmarkStore } from '../../benchmark/BenchmarkStore';
import { importSherlockIndex } from '../../benchmark/importSherlock';

describe('importSherlockIndex', () => {
    let tmpDir: string;
    let store: BenchmarkStore;
    let indexDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-import-'));
        indexDir = path.join(tmpDir, 'index');
        fs.mkdirSync(indexDir, { recursive: true });
        store = new BenchmarkStore(tmpDir);
        await store.initialize();
    });

    afterEach(async () => {
        await store.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeContests(contests: any[]): void {
        fs.writeFileSync(path.join(indexDir, 'contests.json'), JSON.stringify(contests));
    }

    function writeFindings(findings: any[]): void {
        fs.writeFileSync(path.join(indexDir, 'findings.json'), JSON.stringify(findings));
    }

    it('imports contests from contests.json', () => {
        writeContests([
            {
                id: 'contest-1',
                source: 'sherlock',
                name: 'Uniswap V3',
                sponsor: 'Uniswap Labs',
                temporal_bucket: '2024-Q1',
                code_repo_path: '/repos/uniswap-v3',
                total_findings: 12,
                findings_by_severity: { high: 3, medium: 5, low: 4 },
                scope_files: ['src/Pool.sol', 'src/Factory.sol'],
            },
            {
                id: 'contest-2',
                source: 'sherlock',
                name: 'Aave V3',
                temporal_bucket: '2024-Q2',
                code_repo_path: '/repos/aave-v3',
                total_findings: 8,
                findings_by_severity: { critical: 1, high: 2, medium: 5 },
                scope_files: ['src/Pool.sol'],
            },
        ]);

        const result = importSherlockIndex(store, indexDir);

        expect(result.contests).toBe(2);
        expect(result.findings).toBe(0);

        const contests = store.listContests();
        expect(contests).toHaveLength(2);

        const c1 = store.getContest('contest-1');
        expect(c1).toBeDefined();
        expect(c1!.name).toBe('Uniswap V3');
        expect(c1!.sponsor).toBe('Uniswap Labs');
        expect(c1!.totalFindings).toBe(12);
        expect(c1!.scopeFiles).toEqual(['src/Pool.sol', 'src/Factory.sol']);
    });

    it('imports findings from findings.json', () => {
        writeContests([{
            id: 'c1',
            source: 'sherlock',
            name: 'Test Contest',
            temporal_bucket: '2024-Q1',
            code_repo_path: '/repos/test',
            total_findings: 2,
            findings_by_severity: { high: 1, medium: 1 },
            scope_files: [],
        }]);

        writeFindings([
            {
                id: 'f1',
                contest_id: 'c1',
                external_id: 'H-01',
                severity: 'high',
                title: 'Reentrancy in withdraw',
                description: 'The withdraw function lacks reentrancy protection',
                impact: 'Funds can be drained',
                affected_files: [{ path: 'src/Vault.sol', lines: { start: 42, end: 58 } }],
                labels: ['reentrancy'],
            },
            {
                id: 'f2',
                contest_id: 'c1',
                external_id: 'M-01',
                severity: 'medium',
                title: 'Missing input validation',
                description: 'No validation on amount parameter',
            },
        ]);

        const result = importSherlockIndex(store, indexDir);

        expect(result.contests).toBe(1);
        expect(result.findings).toBe(2);

        const findings = store.getFindingsForContest('c1');
        expect(findings).toHaveLength(2);

        const f1 = findings.find(f => f.id === 'f1');
        expect(f1).toBeDefined();
        expect(f1!.severity).toBe('high');
        expect(f1!.title).toBe('Reentrancy in withdraw');
        expect(f1!.affectedFiles).toHaveLength(1);
        expect(f1!.labels).toEqual(['reentrancy']);

        const f2 = findings.find(f => f.id === 'f2');
        expect(f2).toBeDefined();
        expect(f2!.severity).toBe('medium');
        expect(f2!.affectedFiles).toEqual([]);
        expect(f2!.labels).toEqual([]);
    });

    it('handles missing findings.json gracefully', () => {
        writeContests([{
            id: 'c1',
            source: 'sherlock',
            name: 'Contest',
            temporal_bucket: '2024-Q1',
            code_repo_path: '/repos/test',
            total_findings: 0,
            findings_by_severity: {},
            scope_files: [],
        }]);
        // No findings.json written

        const result = importSherlockIndex(store, indexDir);
        expect(result.contests).toBe(1);
        expect(result.findings).toBe(0);
    });

    it('throws when contests.json is missing', () => {
        expect(() => importSherlockIndex(store, indexDir)).toThrow('contests.json not found');
    });

    it('throws when index path does not exist', () => {
        expect(() => importSherlockIndex(store, '/nonexistent/path')).toThrow('contests.json not found');
    });

    it('fills in defaults for optional fields', () => {
        writeContests([{
            id: 'c1',
            name: 'Minimal Contest',
            temporal_bucket: '2024-Q3',
            code_repo_path: '/repos/minimal',
            total_findings: 0,
            findings_by_severity: {},
            scope_files: [],
            // Missing: source, sponsor, start_date, end_date, scope_repo_url, etc.
        }]);

        importSherlockIndex(store, indexDir);

        const contest = store.getContest('c1');
        expect(contest).toBeDefined();
        expect(contest!.source).toBe('sherlock');
        expect(contest!.sponsor).toBe('Minimal Contest'); // defaults to name
        expect(contest!.codeRepoUrl).toBe('');
    });

    it('is idempotent - re-importing updates data', () => {
        writeContests([{
            id: 'c1',
            source: 'sherlock',
            name: 'Original Name',
            temporal_bucket: '2024-Q1',
            code_repo_path: '/repos/test',
            total_findings: 5,
            findings_by_severity: { high: 5 },
            scope_files: [],
        }]);

        importSherlockIndex(store, indexDir);
        expect(store.getContest('c1')!.name).toBe('Original Name');

        // Re-import with updated data
        writeContests([{
            id: 'c1',
            source: 'sherlock',
            name: 'Updated Name',
            temporal_bucket: '2024-Q1',
            code_repo_path: '/repos/test',
            total_findings: 10,
            findings_by_severity: { high: 5, medium: 5 },
            scope_files: ['new-file.sol'],
        }]);

        const result = importSherlockIndex(store, indexDir);
        expect(result.contests).toBe(1);
        expect(store.getContest('c1')!.name).toBe('Updated Name');
        expect(store.getContest('c1')!.totalFindings).toBe(10);
    });
});
