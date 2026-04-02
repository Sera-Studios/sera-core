/**
 * @fileoverview Tests for DatasetFetcher interface and ValidFindingsFetcher
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FetcherRegistry } from '../../benchmark/DatasetFetcher';
import { ValidFindingsFetcher } from '../../benchmark/fetchers/ValidFindingsFetcher';
import type { KnownFinding } from '@sera/types';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetcher-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FetcherRegistry', () => {
    it('registers and retrieves fetchers', () => {
        const registry = new FetcherRegistry();
        const fetcher = new ValidFindingsFetcher();
        registry.register(fetcher);

        expect(registry.get('valid-findings')).toBe(fetcher);
        expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('lists all registered fetchers', () => {
        const registry = new FetcherRegistry();
        registry.register(new ValidFindingsFetcher());

        const list = registry.list();
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('valid-findings');
        expect(list[0].sourceTypes).toContain('sherlock');
    });
});

describe('ValidFindingsFetcher', () => {
    it('extracts findings for a specific contest from Sherlock index', async () => {
        // Create mock index files
        const contests = [
            {
                id: 'contest-abc',
                source: 'sherlock',
                name: 'ABC Protocol',
                sponsor: 'ABC',
                temporal_bucket: '2025-Q1',
                code_repo_path: '/repos/abc',
                total_findings: 2,
                findings_by_severity: { high: 1, medium: 1 },
                scope_files: ['src/Vault.sol'],
            },
        ];
        const findings = [
            {
                id: 'f-1',
                contest_id: 'contest-abc',
                external_id: 'abc-H-01',
                severity: 'high',
                title: 'Reentrancy in withdraw',
                description: 'The withdraw function has a reentrancy vulnerability.',
                impact: 'Loss of funds',
                affected_files: [{ path: 'src/Vault.sol', lines: { start: 10, end: 20 } }],
                labels: ['reentrancy'],
            },
            {
                id: 'f-2',
                contest_id: 'contest-abc',
                external_id: 'abc-M-01',
                severity: 'medium',
                title: 'Missing access control',
                description: 'Missing check.',
            },
            {
                id: 'f-3',
                contest_id: 'other-contest',
                external_id: 'other-01',
                severity: 'high',
                title: 'Should not be included',
                description: 'Different contest.',
            },
        ];

        fs.writeFileSync(path.join(tmpDir, 'contests.json'), JSON.stringify(contests));
        fs.writeFileSync(path.join(tmpDir, 'findings.json'), JSON.stringify(findings));

        const fetcher = new ValidFindingsFetcher();
        const result = await fetcher.fetch('contest-abc', 'sherlock', { indexPath: tmpDir });

        expect(result.dataset.categoryId).toBe('issue-identification');
        expect(result.dataset.name).toContain('ABC Protocol');
        expect(result.dataset.sourceId).toBe('contest-abc');
        expect(result.dataset.codeRepoPath).toBe('/repos/abc');
        expect(result.dataset.scopeFiles).toEqual(['src/Vault.sol']);
        expect(result.dataset.language).toBe('solidity');

        const gt = result.groundTruth as KnownFinding[];
        expect(gt).toHaveLength(2);
        expect(gt[0].title).toBe('Reentrancy in withdraw');
        expect(gt[1].severity).toBe('medium');
        // f-3 belongs to a different contest, should not be included
    });

    it('throws for missing contests.json', async () => {
        const fetcher = new ValidFindingsFetcher();
        await expect(fetcher.fetch('x', 'sherlock', { indexPath: tmpDir }))
            .rejects.toThrow('contests.json not found');
    });

    it('throws for contest not found in index', async () => {
        fs.writeFileSync(path.join(tmpDir, 'contests.json'), JSON.stringify([]));
        const fetcher = new ValidFindingsFetcher();
        await expect(fetcher.fetch('nonexistent', 'sherlock', { indexPath: tmpDir }))
            .rejects.toThrow('Contest not found in index');
    });

    it('throws for unsupported source type', async () => {
        const fetcher = new ValidFindingsFetcher();
        await expect(fetcher.fetch('x', 'code4rena', { indexPath: tmpDir }))
            .rejects.toThrow('does not support source type');
    });

    it('throws when indexPath option is missing', async () => {
        const fetcher = new ValidFindingsFetcher();
        await expect(fetcher.fetch('x', 'sherlock', {}))
            .rejects.toThrow('requires options.indexPath');
    });

    it('handles contest with no findings file gracefully', async () => {
        const contests = [{
            id: 'empty-contest',
            source: 'sherlock',
            name: 'Empty',
            temporal_bucket: '2025-Q1',
            code_repo_path: '/repos/empty',
            total_findings: 0,
            findings_by_severity: {},
            scope_files: [],
        }];
        fs.writeFileSync(path.join(tmpDir, 'contests.json'), JSON.stringify(contests));
        // No findings.json

        const fetcher = new ValidFindingsFetcher();
        const result = await fetcher.fetch('empty-contest', 'sherlock', { indexPath: tmpDir });

        const gt = result.groundTruth as KnownFinding[];
        expect(gt).toHaveLength(0);
    });
});
