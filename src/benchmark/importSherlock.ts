/**
 * @fileoverview Import Sherlock contest data into BenchmarkStore
 * @module sera-core/benchmark/importSherlock
 *
 * Reads contests.json and findings.json from the benchmarker's Sherlock index
 * and upserts them into the BenchmarkStore.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BenchmarkContest, KnownFinding } from '@sera/types';
import { BenchmarkStore } from './BenchmarkStore';

interface RawContest {
    id: string;
    source: string;
    name: string;
    sponsor?: string;
    temporal_bucket: string;
    code_repo_path: string;
    findings_repo_path?: string;
    total_findings: number;
    findings_by_severity: Record<string, number>;
    scope_files: string[];
    scope_commit?: string;
    scope_repo_url?: string;
    scope_description?: string;
    start_date?: string;
    end_date?: string;
}

interface RawFinding {
    id: string;
    contest_id: string;
    external_id: string;
    severity: string;
    title: string;
    description: string;
    impact?: string;
    affected_files?: Array<{
        path: string;
        lines?: { start: number; end: number };
    }>;
    labels?: string[];
}

/**
 * Import Sherlock index data into the benchmark store.
 * @param store - BenchmarkStore instance
 * @param indexPath - Path to the directory containing contests.json and findings.json
 * @returns Count of imported contests and findings
 */
export function importSherlockIndex(
    store: BenchmarkStore,
    indexPath: string
): { contests: number; findings: number } {
    const contestsFile = path.join(indexPath, 'contests.json');
    const findingsFile = path.join(indexPath, 'findings.json');

    if (!fs.existsSync(contestsFile)) {
        throw new Error(`contests.json not found at ${contestsFile}`);
    }

    let contestCount = 0;
    let findingCount = 0;

    // Import contests
    const rawContests: RawContest[] = JSON.parse(fs.readFileSync(contestsFile, 'utf-8'));
    for (const raw of rawContests) {
        const contest: BenchmarkContest = {
            id: raw.id,
            source: (raw.source || 'sherlock') as 'sherlock' | 'code4rena',
            externalId: raw.id,
            name: raw.name,
            sponsor: raw.sponsor || raw.name,
            startDate: raw.start_date,
            endDate: raw.end_date,
            temporalBucket: raw.temporal_bucket,
            codeRepoUrl: raw.scope_repo_url || '',
            codeRepoPath: raw.code_repo_path,
            codeCommitHash: raw.scope_commit,
            scopeFiles: raw.scope_files,
            scopeDescription: raw.scope_description,
            totalFindings: raw.total_findings,
            findingsBySeverity: raw.findings_by_severity,
        };
        store.upsertContest(contest);
        contestCount++;
    }

    // Import findings (if file exists)
    if (fs.existsSync(findingsFile)) {
        const rawFindings: RawFinding[] = JSON.parse(fs.readFileSync(findingsFile, 'utf-8'));
        for (const raw of rawFindings) {
            const finding: KnownFinding = {
                id: raw.id,
                contestId: raw.contest_id,
                externalId: raw.external_id,
                severity: raw.severity as KnownFinding['severity'],
                title: raw.title,
                description: raw.description || '',
                impact: raw.impact || '',
                affectedFiles: raw.affected_files || [],
                labels: raw.labels || [],
            };
            store.upsertFinding(finding);
            findingCount++;
        }
    }

    return { contests: contestCount, findings: findingCount };
}
