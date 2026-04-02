/**
 * @fileoverview BenchmarkStore - SQLite store for benchmark data
 * @module sera-core/benchmark/BenchmarkStore
 *
 * Manages contests, known findings, benchmark runs, and evaluation results.
 * Uses sql.js (same as StorageEngine) with its own benchmarks.db file.
 */

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database } from 'sql.js';
import type {
    BenchmarkContest,
    BenchmarkCategory,
    BenchmarkDataset,
    CategoryResult,
    MetricDefinition,
    KnownFinding,
    BenchmarkRun,
    BenchmarkResult,
} from '@sera/types';

export class BenchmarkStore {
    private db!: Database;
    private dbPath: string;

    constructor(seraHome: string | undefined) {
        const home = seraHome || path.join(require('os').homedir(), '.sera');
        this.dbPath = path.join(home, 'benchmarks.db');
    }

    /**
     * Initialize the database, creating tables if needed
     */
    async initialize(): Promise<void> {
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const SQL = await initSqlJs();

        if (fs.existsSync(this.dbPath)) {
            const buffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(buffer);
        } else {
            this.db = new SQL.Database();
        }

        this.createTables();
        this.save();
    }

    /**
     * Shut down the store, saving to disk
     */
    async shutdown(): Promise<void> {
        if (this.db) {
            this.save();
            this.db.close();
        }
    }

    // ========================================================================
    // CONTESTS
    // ========================================================================

    upsertContest(contest: BenchmarkContest): void {
        this.db.run(`
            INSERT OR REPLACE INTO contests
                (id, source, external_id, name, sponsor, language, start_date, end_date,
                 temporal_bucket, code_repo_url, code_repo_path, code_commit_hash,
                 scope_files, scope_description, total_findings, findings_by_severity,
                 tags, difficulty, archived, notes, estimated_duration_sec)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            contest.id,
            contest.source,
            contest.externalId,
            contest.name,
            contest.sponsor,
            contest.language || 'solidity',
            contest.startDate || null,
            contest.endDate || null,
            contest.temporalBucket,
            contest.codeRepoUrl,
            contest.codeRepoPath,
            contest.codeCommitHash || null,
            JSON.stringify(contest.scopeFiles),
            contest.scopeDescription || null,
            contest.totalFindings,
            JSON.stringify(contest.findingsBySeverity),
            JSON.stringify(contest.tags || []),
            contest.difficulty || 'medium',
            contest.archived ? 1 : 0,
            contest.notes || null,
            contest.estimatedDurationSec || null,
        ]);
        this.save();
    }

    getContest(id: string): BenchmarkContest | null {
        const rows = this.query(
            'SELECT * FROM contests WHERE id = ?', [id]
        );
        if (rows.length === 0) return null;
        return this.rowToContest(rows[0]);
    }

    listContests(filters?: {
        source?: string;
        temporalBucket?: string;
        language?: string;
        difficulty?: string;
        includeArchived?: boolean;
        tags?: string[];
        contestIds?: string[];
    }): BenchmarkContest[] {
        let sql = 'SELECT * FROM contests';
        const conditions: string[] = [];
        const params: any[] = [];

        if (filters?.source) {
            conditions.push('source = ?');
            params.push(filters.source);
        }
        if (filters?.temporalBucket) {
            conditions.push('temporal_bucket = ?');
            params.push(filters.temporalBucket);
        }
        if (filters?.language) {
            conditions.push('language = ?');
            params.push(filters.language);
        }
        if (filters?.difficulty) {
            conditions.push('difficulty = ?');
            params.push(filters.difficulty);
        }
        if (!filters?.includeArchived) {
            conditions.push('(archived = 0 OR archived IS NULL)');
        }
        if (filters?.contestIds && filters.contestIds.length > 0) {
            const placeholders = filters.contestIds.map(() => '?').join(', ');
            conditions.push(`id IN (${placeholders})`);
            params.push(...filters.contestIds);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY name';

        let results = this.query(sql, params).map(r => this.rowToContest(r));

        // Tag filtering in JS (JSON column, can't do SQL LIKE efficiently for AND)
        if (filters?.tags && filters.tags.length > 0) {
            results = results.filter(c => {
                const contestTags = c.tags || [];
                return filters.tags!.every(t => contestTags.includes(t));
            });
        }

        return results;
    }

    updateContestMetadata(id: string, updates: {
        tags?: string[];
        addTags?: string[];
        difficulty?: string;
        archived?: boolean;
        notes?: string;
        estimatedDurationSec?: number;
    }): boolean {
        const contest = this.getContest(id);
        if (!contest) return false;

        const sets: string[] = [];
        const params: any[] = [];

        if (updates.tags !== undefined) {
            sets.push('tags = ?');
            params.push(JSON.stringify(updates.tags));
        } else if (updates.addTags && updates.addTags.length > 0) {
            const existing = contest.tags || [];
            const merged = [...new Set([...existing, ...updates.addTags])];
            sets.push('tags = ?');
            params.push(JSON.stringify(merged));
        }
        if (updates.difficulty !== undefined) {
            sets.push('difficulty = ?');
            params.push(updates.difficulty);
        }
        if (updates.archived !== undefined) {
            sets.push('archived = ?');
            params.push(updates.archived ? 1 : 0);
        }
        if (updates.notes !== undefined) {
            sets.push('notes = ?');
            params.push(updates.notes);
        }
        if (updates.estimatedDurationSec !== undefined) {
            sets.push('estimated_duration_sec = ?');
            params.push(updates.estimatedDurationSec);
        }

        if (sets.length === 0) return true;
        params.push(id);

        this.db.run(`UPDATE contests SET ${sets.join(', ')} WHERE id = ?`, params);
        this.save();
        return true;
    }

    // ========================================================================
    // CONTEST SUBSETS
    // ========================================================================

    upsertSubset(name: string, contestIds: string[], description?: string): void {
        const now = new Date().toISOString();
        this.db.run(`
            INSERT OR REPLACE INTO contest_subsets (name, contest_ids, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `, [name, JSON.stringify(contestIds), description || null, now, now]);
        this.save();
    }

    getSubset(name: string): { name: string; contestIds: string[]; description?: string; createdAt: string; updatedAt: string } | null {
        const rows = this.query('SELECT * FROM contest_subsets WHERE name = ?', [name]);
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            name: row.name,
            contestIds: JSON.parse(row.contest_ids),
            description: row.description || undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    listSubsets(): Array<{ name: string; contestIds: string[]; description?: string; createdAt: string; updatedAt: string }> {
        return this.query('SELECT * FROM contest_subsets ORDER BY name').map(row => ({
            name: row.name,
            contestIds: JSON.parse(row.contest_ids),
            description: row.description || undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }

    deleteSubset(name: string): boolean {
        const existing = this.getSubset(name);
        if (!existing) return false;
        this.db.run('DELETE FROM contest_subsets WHERE name = ?', [name]);
        this.save();
        return true;
    }

    // ========================================================================
    // KNOWN FINDINGS
    // ========================================================================

    upsertFinding(finding: KnownFinding): void {
        this.db.run(`
            INSERT OR REPLACE INTO known_findings
                (id, contest_id, external_id, severity, title, description,
                 impact, affected_files, labels)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            finding.id,
            finding.contestId,
            finding.externalId,
            finding.severity,
            finding.title,
            finding.description,
            finding.impact,
            JSON.stringify(finding.affectedFiles),
            JSON.stringify(finding.labels),
        ]);
        this.save();
    }

    getFindingsForContest(contestId: string): KnownFinding[] {
        return this.query(
            'SELECT * FROM known_findings WHERE contest_id = ? ORDER BY severity, title',
            [contestId]
        ).map(r => this.rowToFinding(r));
    }

    // ========================================================================
    // BENCHMARK RUNS
    // ========================================================================

    createRun(run: BenchmarkRun): void {
        this.db.run(`
            INSERT INTO benchmark_runs
                (id, agent_id, agent_version, contest_id, started_at, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            run.id,
            run.agentId,
            run.agentVersion,
            run.contestId,
            run.startedAt,
            run.status,
        ]);
        this.save();
    }

    updateRun(id: string, update: Partial<Pick<BenchmarkRun, 'status' | 'completedAt' | 'error'>>): void {
        const sets: string[] = [];
        const params: any[] = [];

        if (update.status !== undefined) {
            sets.push('status = ?');
            params.push(update.status);
        }
        if (update.completedAt !== undefined) {
            sets.push('completed_at = ?');
            params.push(update.completedAt);
        }
        if (update.error !== undefined) {
            sets.push('error = ?');
            params.push(update.error);
        }

        if (sets.length === 0) return;
        params.push(id);

        this.db.run(
            `UPDATE benchmark_runs SET ${sets.join(', ')} WHERE id = ?`,
            params
        );
        this.save();
    }

    getRun(id: string): BenchmarkRun | null {
        const rows = this.query(
            'SELECT * FROM benchmark_runs WHERE id = ?', [id]
        );
        if (rows.length === 0) return null;
        return this.rowToRun(rows[0]);
    }

    listRuns(filters?: { agentId?: string; contestId?: string }): BenchmarkRun[] {
        let sql = 'SELECT * FROM benchmark_runs';
        const conditions: string[] = [];
        const params: any[] = [];

        if (filters?.agentId) {
            conditions.push('agent_id = ?');
            params.push(filters.agentId);
        }
        if (filters?.contestId) {
            conditions.push('contest_id = ?');
            params.push(filters.contestId);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY started_at DESC';

        return this.query(sql, params).map(r => this.rowToRun(r));
    }

    // ========================================================================
    // BENCHMARK RESULTS
    // ========================================================================

    saveResult(result: BenchmarkResult): void {
        this.db.run(`
            INSERT OR REPLACE INTO benchmark_results
                (id, run_id, agent_id, agent_version, contest_id,
                 evaluated_at, score, metrics, by_severity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            result.id,
            result.runId,
            result.agentId,
            result.agentVersion,
            result.contestId,
            result.evaluatedAt,
            JSON.stringify(result.score),
            JSON.stringify(result.metrics),
            JSON.stringify(result.bySeverity),
        ]);
        this.save();
    }

    getResult(id: string): BenchmarkResult | null {
        const rows = this.query(
            'SELECT * FROM benchmark_results WHERE id = ?', [id]
        );
        if (rows.length === 0) return null;
        return this.rowToResult(rows[0]);
    }

    listResults(filters?: {
        agentId?: string;
        contestId?: string;
    }): BenchmarkResult[] {
        let sql = 'SELECT * FROM benchmark_results';
        const conditions: string[] = [];
        const params: any[] = [];

        if (filters?.agentId) {
            conditions.push('agent_id = ?');
            params.push(filters.agentId);
        }
        if (filters?.contestId) {
            conditions.push('contest_id = ?');
            params.push(filters.contestId);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY evaluated_at DESC';

        return this.query(sql, params).map(r => this.rowToResult(r));
    }

    /**
     * Get score history for a specific agent (for trend charts)
     */
    getAgentHistory(agentId: string): Array<{
        contestId: string;
        contestName: string;
        agentVersion: string;
        evaluatedAt: string;
        percentage: number;
        recall: number;
        precision: number;
        f1Score: number;
    }> {
        return this.query(`
            SELECT r.agent_version, r.contest_id, r.evaluated_at,
                   r.score, r.metrics, c.name as contest_name
            FROM benchmark_results r
            JOIN contests c ON c.id = r.contest_id
            WHERE r.agent_id = ?
            ORDER BY r.evaluated_at ASC
        `, [agentId]).map(row => {
            const score = JSON.parse(row.score);
            const metrics = JSON.parse(row.metrics);
            return {
                contestId: row.contest_id,
                contestName: row.contest_name,
                agentVersion: row.agent_version,
                evaluatedAt: row.evaluated_at,
                percentage: score.percentage,
                recall: metrics.recall,
                precision: metrics.precision,
                f1Score: metrics.f1Score,
            };
        });
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    private createTables(): void {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS contests (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                external_id TEXT NOT NULL,
                name TEXT NOT NULL,
                sponsor TEXT NOT NULL,
                language TEXT DEFAULT 'solidity',
                start_date TEXT,
                end_date TEXT,
                temporal_bucket TEXT NOT NULL,
                code_repo_url TEXT NOT NULL,
                code_repo_path TEXT NOT NULL,
                code_commit_hash TEXT,
                scope_files TEXT NOT NULL,
                scope_description TEXT,
                total_findings INTEGER NOT NULL,
                findings_by_severity TEXT NOT NULL,
                tags TEXT DEFAULT '[]',
                difficulty TEXT DEFAULT 'medium',
                archived INTEGER DEFAULT 0,
                notes TEXT,
                estimated_duration_sec INTEGER
            )
        `);

        // Migrations: add columns to existing databases
        try { this.db.run("ALTER TABLE contests ADD COLUMN language TEXT DEFAULT 'solidity'"); } catch { /* column already exists */ }
        try { this.db.run("ALTER TABLE contests ADD COLUMN tags TEXT DEFAULT '[]'"); } catch { /* column already exists */ }
        try { this.db.run("ALTER TABLE contests ADD COLUMN difficulty TEXT DEFAULT 'medium'"); } catch { /* column already exists */ }
        try { this.db.run("ALTER TABLE contests ADD COLUMN archived INTEGER DEFAULT 0"); } catch { /* column already exists */ }
        try { this.db.run("ALTER TABLE contests ADD COLUMN notes TEXT"); } catch { /* column already exists */ }
        try { this.db.run("ALTER TABLE contests ADD COLUMN estimated_duration_sec INTEGER"); } catch { /* column already exists */ }

        this.db.run(`
            CREATE TABLE IF NOT EXISTS known_findings (
                id TEXT PRIMARY KEY,
                contest_id TEXT NOT NULL,
                external_id TEXT NOT NULL,
                severity TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                impact TEXT NOT NULL,
                affected_files TEXT NOT NULL,
                labels TEXT NOT NULL,
                FOREIGN KEY (contest_id) REFERENCES contests(id)
            )
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_findings_contest
            ON known_findings(contest_id)
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS benchmark_runs (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                agent_version TEXT NOT NULL,
                contest_id TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                status TEXT NOT NULL,
                error TEXT,
                FOREIGN KEY (contest_id) REFERENCES contests(id)
            )
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_runs_agent
            ON benchmark_runs(agent_id)
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_runs_contest
            ON benchmark_runs(contest_id)
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS benchmark_results (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                agent_version TEXT NOT NULL,
                contest_id TEXT NOT NULL,
                evaluated_at TEXT NOT NULL,
                score TEXT NOT NULL,
                metrics TEXT NOT NULL,
                by_severity TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES benchmark_runs(id),
                FOREIGN KEY (contest_id) REFERENCES contests(id)
            )
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_results_agent
            ON benchmark_results(agent_id)
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_results_contest
            ON benchmark_results(contest_id)
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS contest_subsets (
                name TEXT PRIMARY KEY,
                contest_ids TEXT NOT NULL,
                description TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS benchmark_categories (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                fetcher_id TEXT NOT NULL,
                metrics TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS benchmark_datasets (
                id TEXT PRIMARY KEY,
                category_id TEXT NOT NULL,
                name TEXT NOT NULL,
                source_id TEXT NOT NULL,
                source_type TEXT NOT NULL,
                code_repo_path TEXT,
                scope_files TEXT,
                language TEXT,
                fetched_at TEXT NOT NULL,
                metadata TEXT,
                FOREIGN KEY (category_id) REFERENCES benchmark_categories(id)
            )
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_datasets_category
            ON benchmark_datasets(category_id)
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_datasets_source
            ON benchmark_datasets(source_id, source_type)
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS dataset_submissions (
                id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                external_id TEXT NOT NULL,
                severity TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                impact TEXT,
                affected_files TEXT,
                labels TEXT,
                is_valid INTEGER NOT NULL,
                rejection_reason TEXT,
                FOREIGN KEY (dataset_id) REFERENCES benchmark_datasets(id)
            )
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_dataset_submissions_dataset
            ON dataset_submissions(dataset_id)
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_dataset_submissions_valid
            ON dataset_submissions(dataset_id, is_valid)
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS category_results (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                category_id TEXT NOT NULL,
                dataset_id TEXT NOT NULL,
                execution_agent_id TEXT NOT NULL,
                evaluation_agent_id TEXT NOT NULL,
                execution_agent_version TEXT,
                metrics TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT NOT NULL,
                metadata TEXT
            )
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_cat_results_category
            ON category_results(category_id)
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_cat_results_category_agent
            ON category_results(category_id, execution_agent_id)
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_cat_results_category_dataset
            ON category_results(category_id, dataset_id)
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_cat_results_agent
            ON category_results(execution_agent_id)
        `);
    }

    // ========================================================================
    // CATEGORIES
    // ========================================================================

    upsertCategory(category: BenchmarkCategory): void {
        this.db.run(`
            INSERT OR REPLACE INTO benchmark_categories
                (id, name, description, fetcher_id, metrics, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            category.id,
            category.name,
            category.description,
            category.fetcherId,
            JSON.stringify(category.metrics),
            category.createdAt,
        ]);
        this.save();
    }

    getCategory(id: string): BenchmarkCategory | null {
        const rows = this.query(
            'SELECT * FROM benchmark_categories WHERE id = ?', [id]
        );
        if (rows.length === 0) return null;
        return this.rowToCategory(rows[0]);
    }

    listCategories(): BenchmarkCategory[] {
        const rows = this.query('SELECT * FROM benchmark_categories ORDER BY name');
        return rows.map(r => this.rowToCategory(r));
    }

    deleteCategory(id: string): boolean {
        const existing = this.getCategory(id);
        if (!existing) return false;
        this.db.run('DELETE FROM benchmark_categories WHERE id = ?', [id]);
        this.save();
        return true;
    }

    /**
     * Seed built-in categories if they don't already exist.
     */
    seedDefaultCategories(): void {
        if (this.getCategory('issue-identification')) return;

        this.upsertCategory({
            id: 'issue-identification',
            name: 'Issue Identification',
            description: 'Benchmark agents that find security vulnerabilities in source code. Execution agents produce findings, evaluation agents assess those findings against known ground truth.',
            fetcherId: 'valid-findings',
            metrics: [
                { key: 'recall', label: 'Recall', description: 'Proportion of known issues found', sortDirection: 'desc' },
                { key: 'precision', label: 'Precision', description: 'Proportion of submissions that were valid', sortDirection: 'desc' },
                { key: 'f1Score', label: 'F1 Score', description: 'Harmonic mean of recall and precision', sortDirection: 'desc', primary: true },
                { key: 'totalSubmissions', label: 'Submissions', description: 'Total findings submitted', sortDirection: 'desc' },
                { key: 'validMatches', label: 'Valid Matches', description: 'Findings matched to known issues', sortDirection: 'desc' },
            ],
            createdAt: new Date().toISOString(),
        });

        this.upsertCategory({
            id: 'valid-issue-detection',
            name: 'Valid Issue Detection',
            description: 'Benchmark agents that classify submitted findings as valid or invalid. Execution agents produce verdicts on submissions, evaluation compares verdicts against human judge decisions.',
            fetcherId: 'all-submissions-with-labels',
            metrics: [
                { key: 'accuracy', label: 'Accuracy', description: 'Proportion of correct verdicts', sortDirection: 'desc', primary: true },
                { key: 'falseAcceptRate', label: 'False Accept Rate', description: 'Invalid findings incorrectly accepted', sortDirection: 'asc' },
                { key: 'falseRejectRate', label: 'False Reject Rate', description: 'Valid findings incorrectly rejected', sortDirection: 'asc' },
                { key: 'truePositives', label: 'True Positives', description: 'Valid findings correctly accepted', sortDirection: 'desc' },
                { key: 'trueNegatives', label: 'True Negatives', description: 'Invalid findings correctly rejected', sortDirection: 'desc' },
            ],
            createdAt: new Date().toISOString(),
        });
    }

    // ========================================================================
    // DATASETS
    // ========================================================================

    upsertDataset(dataset: BenchmarkDataset): void {
        this.db.run(`
            INSERT OR REPLACE INTO benchmark_datasets
                (id, category_id, name, source_id, source_type, code_repo_path,
                 scope_files, language, fetched_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            dataset.id,
            dataset.categoryId,
            dataset.name,
            dataset.sourceId,
            dataset.sourceType,
            dataset.codeRepoPath || null,
            dataset.scopeFiles ? JSON.stringify(dataset.scopeFiles) : null,
            dataset.language || null,
            dataset.fetchedAt,
            dataset.metadata ? JSON.stringify(dataset.metadata) : null,
        ]);
        this.save();
    }

    getDataset(id: string): BenchmarkDataset | null {
        const rows = this.query(
            'SELECT * FROM benchmark_datasets WHERE id = ?', [id]
        );
        if (rows.length === 0) return null;
        return this.rowToDataset(rows[0]);
    }

    listDatasets(categoryId?: string): BenchmarkDataset[] {
        if (categoryId) {
            return this.query(
                'SELECT * FROM benchmark_datasets WHERE category_id = ? ORDER BY name',
                [categoryId]
            ).map(r => this.rowToDataset(r));
        }
        return this.query(
            'SELECT * FROM benchmark_datasets ORDER BY name'
        ).map(r => this.rowToDataset(r));
    }

    findDatasetBySource(sourceId: string, sourceType: string, categoryId: string): BenchmarkDataset | null {
        const rows = this.query(
            'SELECT * FROM benchmark_datasets WHERE source_id = ? AND source_type = ? AND category_id = ?',
            [sourceId, sourceType, categoryId]
        );
        if (rows.length === 0) return null;
        return this.rowToDataset(rows[0]);
    }

    deleteDataset(id: string): boolean {
        const existing = this.getDataset(id);
        if (!existing) return false;
        // Delete associated ground truth
        this.db.run('DELETE FROM dataset_submissions WHERE dataset_id = ?', [id]);
        this.db.run('DELETE FROM benchmark_datasets WHERE id = ?', [id]);
        this.save();
        return true;
    }

    // ========================================================================
    // DATASET SUBMISSIONS (ground truth for valid-issue-detection)
    // ========================================================================

    upsertDatasetSubmission(submission: {
        id: string;
        datasetId: string;
        externalId: string;
        severity: string;
        title: string;
        description: string;
        impact?: string;
        affectedFiles?: Array<{ path: string; lines?: { start: number; end: number } }>;
        labels?: string[];
        isValid: boolean;
        rejectionReason?: string;
    }): void {
        this.db.run(`
            INSERT OR REPLACE INTO dataset_submissions
                (id, dataset_id, external_id, severity, title, description,
                 impact, affected_files, labels, is_valid, rejection_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            submission.id,
            submission.datasetId,
            submission.externalId,
            submission.severity,
            submission.title,
            submission.description,
            submission.impact || null,
            submission.affectedFiles ? JSON.stringify(submission.affectedFiles) : null,
            submission.labels ? JSON.stringify(submission.labels) : null,
            submission.isValid ? 1 : 0,
            submission.rejectionReason || null,
        ]);
    }

    getDatasetSubmissions(datasetId: string): Array<{
        id: string;
        datasetId: string;
        externalId: string;
        severity: string;
        title: string;
        description: string;
        impact: string;
        affectedFiles: Array<{ path: string; lines?: { start: number; end: number } }>;
        labels: string[];
        isValid: boolean;
        rejectionReason?: string;
    }> {
        return this.query(
            'SELECT * FROM dataset_submissions WHERE dataset_id = ? ORDER BY severity, title',
            [datasetId]
        ).map(row => ({
            id: row.id,
            datasetId: row.dataset_id,
            externalId: row.external_id,
            severity: row.severity,
            title: row.title,
            description: row.description,
            impact: row.impact || '',
            affectedFiles: row.affected_files ? JSON.parse(row.affected_files) : [],
            labels: row.labels ? JSON.parse(row.labels) : [],
            isValid: row.is_valid === 1,
            rejectionReason: row.rejection_reason || undefined,
        }));
    }

    /**
     * Batch insert dataset submissions (no save per row - caller must save after)
     */
    batchUpsertDatasetSubmissions(submissions: Parameters<BenchmarkStore['upsertDatasetSubmission']>[0][]): void {
        for (const s of submissions) {
            this.upsertDatasetSubmission(s);
        }
        this.save();
    }

    // ========================================================================
    // CATEGORY RESULTS
    // ========================================================================

    saveCategoryResult(result: CategoryResult): void {
        this.db.run(`
            INSERT OR REPLACE INTO category_results
                (id, run_id, category_id, dataset_id, execution_agent_id,
                 evaluation_agent_id, execution_agent_version, metrics,
                 started_at, completed_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            result.id,
            result.runId,
            result.categoryId,
            result.datasetId,
            result.executionAgentId,
            result.evaluationAgentId,
            result.executionAgentVersion || null,
            JSON.stringify(result.metrics),
            result.startedAt,
            result.completedAt,
            result.metadata ? JSON.stringify(result.metadata) : null,
        ]);
        this.save();
    }

    getCategoryResult(id: string): CategoryResult | null {
        const rows = this.query(
            'SELECT * FROM category_results WHERE id = ?', [id]
        );
        if (rows.length === 0) return null;
        return this.rowToCategoryResult(rows[0]);
    }

    listCategoryResults(filters?: {
        categoryId?: string;
        datasetId?: string;
        executionAgentId?: string;
    }): CategoryResult[] {
        let sql = 'SELECT * FROM category_results';
        const conditions: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: any[] = [];

        if (filters?.categoryId) {
            conditions.push('category_id = ?');
            params.push(filters.categoryId);
        }
        if (filters?.datasetId) {
            conditions.push('dataset_id = ?');
            params.push(filters.datasetId);
        }
        if (filters?.executionAgentId) {
            conditions.push('execution_agent_id = ?');
            params.push(filters.executionAgentId);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY completed_at DESC';

        return this.query(sql, params).map(r => this.rowToCategoryResult(r));
    }

    /**
     * Build a leaderboard for a category.
     * Groups results by execution agent, picks most recent result per dataset,
     * computes average metrics, sorts by primary metric.
     */
    getCategoryLeaderboard(categoryId: string, options?: {
        datasetIds?: string[];
        evaluationAgentId?: string;
        limit?: number;
    }): {
        entries: Array<{
            executionAgentId: string;
            evaluationAgentId: string;
            executionAgentVersion?: string;
            datasetResults: Record<string, Record<string, number>>;
            averageMetrics: Record<string, number>;
        }>;
    } {
        // Fetch all results for the category
        let sql = 'SELECT * FROM category_results WHERE category_id = ?';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: any[] = [categoryId];

        if (options?.evaluationAgentId) {
            sql += ' AND evaluation_agent_id = ?';
            params.push(options.evaluationAgentId);
        }
        if (options?.datasetIds && options.datasetIds.length > 0) {
            const placeholders = options.datasetIds.map(() => '?').join(', ');
            sql += ` AND dataset_id IN (${placeholders})`;
            params.push(...options.datasetIds);
        }

        sql += ' ORDER BY completed_at DESC';
        const results = this.query(sql, params).map(r => this.rowToCategoryResult(r));

        // Group by execution agent, pick most recent per dataset
        const agentMap = new Map<string, {
            evaluationAgentId: string;
            executionAgentVersion?: string;
            datasetResults: Map<string, Record<string, number>>;
        }>();

        for (const result of results) {
            if (!agentMap.has(result.executionAgentId)) {
                agentMap.set(result.executionAgentId, {
                    evaluationAgentId: result.evaluationAgentId,
                    executionAgentVersion: result.executionAgentVersion,
                    datasetResults: new Map(),
                });
            }
            const entry = agentMap.get(result.executionAgentId)!;
            // Only keep first (most recent due to ORDER BY)
            if (!entry.datasetResults.has(result.datasetId)) {
                entry.datasetResults.set(result.datasetId, result.metrics);
            }
        }

        // Compute averages and build entries
        const category = this.getCategory(categoryId);
        const primaryMetric = category?.metrics.find(m => m.primary)?.key || category?.metrics[0]?.key;
        const primaryDirection = category?.metrics.find(m => m.primary)?.sortDirection || 'desc';

        const entries = [...agentMap.entries()].map(([agentId, data]) => {
            const datasetResults: Record<string, Record<string, number>> = {};
            const metricSums: Record<string, number> = {};
            let datasetCount = 0;

            for (const [dsId, metrics] of data.datasetResults) {
                datasetResults[dsId] = metrics;
                datasetCount++;
                for (const [key, val] of Object.entries(metrics)) {
                    metricSums[key] = (metricSums[key] || 0) + val;
                }
            }

            const averageMetrics: Record<string, number> = {};
            for (const [key, sum] of Object.entries(metricSums)) {
                averageMetrics[key] = datasetCount > 0 ? sum / datasetCount : 0;
            }

            return {
                executionAgentId: agentId,
                evaluationAgentId: data.evaluationAgentId,
                executionAgentVersion: data.executionAgentVersion,
                datasetResults,
                averageMetrics,
            };
        });

        // Sort by primary metric
        if (primaryMetric) {
            entries.sort((a, b) => {
                const av = a.averageMetrics[primaryMetric] || 0;
                const bv = b.averageMetrics[primaryMetric] || 0;
                return primaryDirection === 'desc' ? bv - av : av - bv;
            });
        }

        if (options?.limit && options.limit > 0) {
            entries.splice(options.limit);
        }

        return { entries };
    }

    private rowToCategoryResult(row: Record<string, any>): CategoryResult {
        return {
            id: row.id,
            runId: row.run_id,
            categoryId: row.category_id,
            datasetId: row.dataset_id,
            executionAgentId: row.execution_agent_id,
            evaluationAgentId: row.evaluation_agent_id,
            executionAgentVersion: row.execution_agent_version || undefined,
            metrics: JSON.parse(row.metrics),
            startedAt: row.started_at,
            completedAt: row.completed_at,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        };
    }

    private rowToDataset(row: Record<string, any>): BenchmarkDataset {
        return {
            id: row.id,
            categoryId: row.category_id,
            name: row.name,
            sourceId: row.source_id,
            sourceType: row.source_type,
            codeRepoPath: row.code_repo_path || undefined,
            scopeFiles: row.scope_files ? JSON.parse(row.scope_files) : undefined,
            language: row.language || undefined,
            fetchedAt: row.fetched_at,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        };
    }

    private rowToCategory(row: Record<string, any>): BenchmarkCategory {
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            fetcherId: row.fetcher_id,
            metrics: JSON.parse(row.metrics) as MetricDefinition[],
            createdAt: row.created_at,
        };
    }

    private query(sql: string, params?: any[]): Record<string, any>[] {
        const result = this.db.exec(sql, params || []);
        if (result.length === 0) return [];

        const columns = result[0].columns;
        return result[0].values.map((row: any[]) => {
            const obj: Record<string, any> = {};
            columns.forEach((col: string, i: number) => {
                obj[col] = row[i];
            });
            return obj;
        });
    }

    private save(): void {
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
    }

    private rowToContest(row: Record<string, any>): BenchmarkContest {
        return {
            id: row.id,
            source: row.source,
            externalId: row.external_id,
            name: row.name,
            sponsor: row.sponsor,
            language: row.language || 'solidity',
            startDate: row.start_date || undefined,
            endDate: row.end_date || undefined,
            temporalBucket: row.temporal_bucket,
            codeRepoUrl: row.code_repo_url,
            codeRepoPath: row.code_repo_path,
            codeCommitHash: row.code_commit_hash || undefined,
            scopeFiles: JSON.parse(row.scope_files),
            scopeDescription: row.scope_description || undefined,
            totalFindings: row.total_findings,
            findingsBySeverity: JSON.parse(row.findings_by_severity),
            tags: row.tags ? JSON.parse(row.tags) : [],
            difficulty: row.difficulty || 'medium',
            archived: row.archived === 1,
            notes: row.notes || undefined,
            estimatedDurationSec: row.estimated_duration_sec || undefined,
        };
    }

    private rowToFinding(row: Record<string, any>): KnownFinding {
        return {
            id: row.id,
            contestId: row.contest_id,
            externalId: row.external_id,
            severity: row.severity,
            title: row.title,
            description: row.description,
            impact: row.impact,
            affectedFiles: JSON.parse(row.affected_files),
            labels: JSON.parse(row.labels),
        };
    }

    private rowToRun(row: Record<string, any>): BenchmarkRun {
        return {
            id: row.id,
            agentId: row.agent_id,
            agentVersion: row.agent_version,
            contestId: row.contest_id,
            startedAt: row.started_at,
            completedAt: row.completed_at || undefined,
            status: row.status,
            error: row.error || undefined,
        };
    }

    private rowToResult(row: Record<string, any>): BenchmarkResult {
        return {
            id: row.id,
            runId: row.run_id,
            agentId: row.agent_id,
            agentVersion: row.agent_version,
            contestId: row.contest_id,
            evaluatedAt: row.evaluated_at,
            score: JSON.parse(row.score),
            metrics: JSON.parse(row.metrics),
            bySeverity: JSON.parse(row.by_severity),
        };
    }
}
