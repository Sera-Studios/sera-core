/**
 * @fileoverview Valid findings fetcher for issue-identification category
 * @module sera-core/benchmark/fetchers/ValidFindingsFetcher
 *
 * Reads from Sherlock index (contests.json + findings.json) and produces
 * KnownFinding[] as ground truth - the final report findings a hunter should find.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { KnownFinding } from '@sera/types';
import type { DatasetFetcher, FetcherResult } from '../DatasetFetcher';
import { suggestTags, suggestDifficulty } from '../suggestTags';

interface RawContest {
    id: string;
    source: string;
    name: string;
    sponsor?: string;
    temporal_bucket: string;
    code_repo_path: string;
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

export class ValidFindingsFetcher implements DatasetFetcher {
    readonly id = 'valid-findings';
    readonly name = 'Valid Findings';
    readonly description = 'Extracts validated findings from Sherlock index as ground truth for issue identification benchmarks.';
    readonly supportedSources = ['sherlock'];

    async fetch(
        sourceId: string,
        sourceType: string,
        options: Record<string, string>,
    ): Promise<FetcherResult> {
        if (sourceType !== 'sherlock') {
            throw new Error(`ValidFindingsFetcher does not support source type: ${sourceType}`);
        }

        const indexPath = options.indexPath;
        if (!indexPath) {
            throw new Error('ValidFindingsFetcher requires options.indexPath');
        }

        const contestsFile = path.join(indexPath, 'contests.json');
        const findingsFile = path.join(indexPath, 'findings.json');

        if (!fs.existsSync(contestsFile)) {
            throw new Error(`contests.json not found at ${contestsFile}`);
        }

        // Find the contest matching sourceId
        const rawContests: RawContest[] = JSON.parse(fs.readFileSync(contestsFile, 'utf-8'));
        const contest = rawContests.find(c => c.id === sourceId);
        if (!contest) {
            throw new Error(`Contest not found in index: ${sourceId}`);
        }

        // Extract findings for this contest
        const findings: KnownFinding[] = [];
        if (fs.existsSync(findingsFile)) {
            const rawFindings: RawFinding[] = JSON.parse(fs.readFileSync(findingsFile, 'utf-8'));
            for (const raw of rawFindings) {
                if (raw.contest_id !== sourceId) continue;
                findings.push({
                    id: raw.id,
                    contestId: raw.contest_id,
                    externalId: raw.external_id,
                    severity: raw.severity as KnownFinding['severity'],
                    title: raw.title,
                    description: raw.description || '',
                    impact: raw.impact || '',
                    affectedFiles: raw.affected_files || [],
                    labels: raw.labels || [],
                });
            }
        }

        const source = contest.source || 'sherlock';
        const tags = suggestTags({
            source,
            language: 'solidity',
            name: contest.name,
            totalFindings: contest.total_findings,
        });

        return {
            dataset: {
                categoryId: 'issue-identification',
                name: `${contest.name} - Issue Identification`,
                sourceId,
                sourceType,
                codeRepoPath: contest.code_repo_path,
                scopeFiles: contest.scope_files,
                language: 'solidity',
                metadata: {
                    totalFindings: findings.length,
                    findingsBySeverity: contest.findings_by_severity,
                    sponsor: contest.sponsor || contest.name,
                    temporalBucket: contest.temporal_bucket,
                    tags,
                    difficulty: suggestDifficulty(contest.total_findings),
                },
            },
            groundTruth: findings,
        };
    }
}
