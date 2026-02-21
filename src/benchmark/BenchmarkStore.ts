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
                (id, source, external_id, name, sponsor, start_date, end_date,
                 temporal_bucket, code_repo_url, code_repo_path, code_commit_hash,
                 scope_files, scope_description, total_findings, findings_by_severity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            contest.id,
            contest.source,
            contest.externalId,
            contest.name,
            contest.sponsor,
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

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY name';

        return this.query(sql, params).map(r => this.rowToContest(r));
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
                start_date TEXT,
                end_date TEXT,
                temporal_bucket TEXT NOT NULL,
                code_repo_url TEXT NOT NULL,
                code_repo_path TEXT NOT NULL,
                code_commit_hash TEXT,
                scope_files TEXT NOT NULL,
                scope_description TEXT,
                total_findings INTEGER NOT NULL,
                findings_by_severity TEXT NOT NULL
            )
        `);

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
