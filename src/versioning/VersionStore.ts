/**
 * @fileoverview VersionStore - SQLite store for agent version lineage and experiments
 * @module sera-core/versioning/VersionStore
 *
 * Tracks how agent definitions evolve over time and records experiments
 * comparing versions. Uses sql.js with its own versions.db file.
 * Data is global (not per-audit).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database } from 'sql.js';
import type {
    AgentVersion,
    Experiment,
    ExperimentMetrics,
    ExperimentStatus,
    ExperimentSummary,
    ExperimentVerdict,
    ModificationType,
    ResourceSnapshot,
    VersionCreator,
} from '@sera/types';

export interface VersionCreateInput {
    agentId: string;
    version: string;
    parentVersionId?: string;
    createdBy: VersionCreator;
    registrationSnapshot?: Record<string, unknown>;
    resourcesSnapshot?: ResourceSnapshot;
}

export interface ExperimentCreateInput {
    agentId: string;
    baseVersionId: string;
    hypothesis: string;
    modificationType: ModificationType;
    modificationDetail: Record<string, unknown>;
}

export interface ExperimentUpdateInput {
    resultVersionId?: string;
    status?: ExperimentStatus;
    completedAt?: string;
    benchmarkRunIds?: string[];
    beforeMetrics?: ExperimentMetrics;
    afterMetrics?: ExperimentMetrics;
    delta?: ExperimentMetrics;
    verdict?: ExperimentVerdict;
    notes?: string;
}

export interface ExperimentListFilter {
    status?: ExperimentStatus;
    modificationType?: ModificationType;
    limit?: number;
}

export class VersionStore {
    private db!: Database;
    private dbPath: string;

    constructor(seraHome: string | undefined) {
        const home = seraHome || path.join(require('os').homedir(), '.sera');
        this.dbPath = path.join(home, 'versions.db');
    }

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

    async shutdown(): Promise<void> {
        if (this.db) {
            this.save();
            this.db.close();
        }
    }

    // ========================================================================
    // VERSION CRUD
    // ========================================================================

    createVersion(input: VersionCreateInput): AgentVersion {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        this.db.run(`
            INSERT INTO agent_versions
                (id, agent_id, version, parent_version_id, created_at, created_by,
                 registration_snapshot, resources_snapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            input.agentId,
            input.version,
            input.parentVersionId || null,
            now,
            input.createdBy,
            input.registrationSnapshot ? JSON.stringify(input.registrationSnapshot) : null,
            input.resourcesSnapshot ? JSON.stringify(input.resourcesSnapshot) : null,
        ]);
        this.save();

        return {
            id,
            agentId: input.agentId,
            version: input.version,
            parentVersionId: input.parentVersionId || null,
            createdAt: now,
            createdBy: input.createdBy,
            registrationSnapshot: input.registrationSnapshot || null,
            resourcesSnapshot: input.resourcesSnapshot || null,
        };
    }

    getVersion(id: string): AgentVersion | null {
        const rows = this.query('SELECT * FROM agent_versions WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this.rowToVersion(rows[0]);
    }

    getVersionsByAgent(agentId: string, limit?: number): AgentVersion[] {
        const maxRows = limit || 100;
        const rows = this.query(
            'SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
            [agentId, maxRows],
        );
        return rows.map(r => this.rowToVersion(r));
    }

    getLatestVersion(agentId: string): AgentVersion | null {
        const rows = this.query(
            'SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
            [agentId],
        );
        if (rows.length === 0) return null;
        return this.rowToVersion(rows[0]);
    }

    getLineage(versionId: string): AgentVersion[] {
        const lineage: AgentVersion[] = [];
        let currentId: string | null = versionId;
        let iterations = 0;

        while (currentId && iterations < 100) {
            const version = this.getVersion(currentId);
            if (!version) break;
            lineage.push(version);
            currentId = version.parentVersionId;
            iterations++;
        }

        return lineage;
    }

    // ========================================================================
    // EXPERIMENT CRUD
    // ========================================================================

    createExperiment(input: ExperimentCreateInput): Experiment {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        this.db.run(`
            INSERT INTO experiments
                (id, agent_id, base_version_id, hypothesis, modification_type,
                 modification_detail, status, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            input.agentId,
            input.baseVersionId,
            input.hypothesis,
            input.modificationType,
            JSON.stringify(input.modificationDetail),
            'pending',
            now,
        ]);
        this.save();

        return {
            id,
            agentId: input.agentId,
            baseVersionId: input.baseVersionId,
            resultVersionId: null,
            hypothesis: input.hypothesis,
            modificationType: input.modificationType,
            modificationDetail: input.modificationDetail,
            status: 'pending',
            startedAt: now,
            completedAt: null,
            benchmarkRunIds: [],
            beforeMetrics: null,
            afterMetrics: null,
            delta: null,
            verdict: null,
            notes: null,
        };
    }

    updateExperiment(id: string, patch: ExperimentUpdateInput): void {
        const sets: string[] = [];
        const params: (string | number | null)[] = [];

        if (patch.resultVersionId !== undefined) {
            sets.push('result_version_id = ?');
            params.push(patch.resultVersionId);
        }
        if (patch.status !== undefined) {
            sets.push('status = ?');
            params.push(patch.status);
        }
        if (patch.completedAt !== undefined) {
            sets.push('completed_at = ?');
            params.push(patch.completedAt);
        }
        if (patch.benchmarkRunIds !== undefined) {
            sets.push('benchmark_run_ids = ?');
            params.push(JSON.stringify(patch.benchmarkRunIds));
        }
        if (patch.beforeMetrics !== undefined) {
            sets.push('before_metrics = ?');
            params.push(JSON.stringify(patch.beforeMetrics));
        }
        if (patch.afterMetrics !== undefined) {
            sets.push('after_metrics = ?');
            params.push(JSON.stringify(patch.afterMetrics));
        }
        if (patch.delta !== undefined) {
            sets.push('delta = ?');
            params.push(JSON.stringify(patch.delta));
        }
        if (patch.verdict !== undefined) {
            sets.push('verdict = ?');
            params.push(patch.verdict);
        }
        if (patch.notes !== undefined) {
            sets.push('notes = ?');
            params.push(patch.notes);
        }

        if (sets.length === 0) return;

        params.push(id);
        this.db.run(
            `UPDATE experiments SET ${sets.join(', ')} WHERE id = ?`,
            params,
        );
        this.save();
    }

    getExperiment(id: string): Experiment | null {
        const rows = this.query('SELECT * FROM experiments WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this.rowToExperiment(rows[0]);
    }

    listExperiments(agentId: string, filter?: ExperimentListFilter): Experiment[] {
        let sql = 'SELECT * FROM experiments WHERE agent_id = ?';
        const params: (string | number)[] = [agentId];

        if (filter?.status) {
            sql += ' AND status = ?';
            params.push(filter.status);
        }
        if (filter?.modificationType) {
            sql += ' AND modification_type = ?';
            params.push(filter.modificationType);
        }

        sql += ' ORDER BY started_at DESC, rowid DESC';

        if (filter?.limit) {
            sql += ' LIMIT ?';
            params.push(filter.limit);
        }

        return this.query(sql, params).map(r => this.rowToExperiment(r));
    }

    getExperimentSummary(agentId: string, since?: string): ExperimentSummary {
        let sql = 'SELECT * FROM experiments WHERE agent_id = ?';
        const params: (string | number)[] = [agentId];

        if (since) {
            sql += ' AND started_at >= ?';
            params.push(since);
        }

        sql += ' ORDER BY started_at DESC, rowid DESC';
        const experiments = this.query(sql, params).map(r => this.rowToExperiment(r));

        const now = new Date().toISOString();
        let improved = 0;
        let regressed = 0;
        let neutral = 0;
        let reverted = 0;
        let netScoreChange = 0;

        const improvements: Array<{ id: string; type: string; hypothesis: string; delta: ExperimentMetrics }> = [];
        const regressions: Array<{ id: string; type: string; hypothesis: string; delta: ExperimentMetrics }> = [];

        for (const exp of experiments) {
            switch (exp.status) {
                case 'improved': improved++; break;
                case 'regressed': regressed++; break;
                case 'neutral': neutral++; break;
                case 'reverted': reverted++; break;
            }

            if (exp.delta) {
                const scoreChange = exp.delta.score ?? 0;
                netScoreChange += scoreChange;

                if (scoreChange > 0) {
                    improvements.push({
                        id: exp.id,
                        type: exp.modificationType,
                        hypothesis: exp.hypothesis,
                        delta: exp.delta,
                    });
                } else if (scoreChange < 0) {
                    regressions.push({
                        id: exp.id,
                        type: exp.modificationType,
                        hypothesis: exp.hypothesis,
                        delta: exp.delta,
                    });
                }
            }
        }

        // Sort improvements descending, regressions ascending (worst first)
        improvements.sort((a, b) => (b.delta.score ?? 0) - (a.delta.score ?? 0));
        regressions.sort((a, b) => (a.delta.score ?? 0) - (b.delta.score ?? 0));

        const total = experiments.length;
        const successRate = total > 0 ? improved / total : 0;

        // Find current best version (latest 'improved' experiment's result version)
        const latestVersion = this.getLatestVersion(agentId);

        return {
            agentId,
            period: { since: since || '1970-01-01T00:00:00.000Z', until: now },
            totalExperiments: total,
            improved,
            regressed,
            neutral,
            reverted,
            successRate,
            topImprovements: improvements.slice(0, 3),
            topRegressions: regressions.slice(0, 3),
            netScoreChange,
            currentBestVersion: latestVersion?.version || null,
        };
    }

    // ========================================================================
    // COUNTS
    // ========================================================================

    versionCount(): number {
        const rows = this.query('SELECT COUNT(*) as cnt FROM agent_versions');
        return rows[0]?.cnt ?? 0;
    }

    experimentCount(): number {
        const rows = this.query('SELECT COUNT(*) as cnt FROM experiments');
        return rows[0]?.cnt ?? 0;
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    private createTables(): void {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS agent_versions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                version TEXT NOT NULL,
                parent_version_id TEXT,
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL,
                registration_snapshot TEXT,
                resources_snapshot TEXT
            )
        `);
        this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_agent_version ON agent_versions(agent_id, version)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_versions_agent ON agent_versions(agent_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_versions_parent ON agent_versions(parent_version_id)');

        this.db.run(`
            CREATE TABLE IF NOT EXISTS experiments (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                base_version_id TEXT NOT NULL,
                result_version_id TEXT,
                hypothesis TEXT NOT NULL,
                modification_type TEXT NOT NULL,
                modification_detail TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                benchmark_run_ids TEXT,
                before_metrics TEXT,
                after_metrics TEXT,
                delta TEXT,
                verdict TEXT,
                notes TEXT
            )
        `);
        this.db.run('CREATE INDEX IF NOT EXISTS idx_experiments_agent ON experiments(agent_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_experiments_type ON experiments(modification_type)');
    }

    private query(sql: string, params?: (string | number | null)[]): Record<string, any>[] {
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

    private rowToVersion(row: Record<string, any>): AgentVersion {
        return {
            id: row.id,
            agentId: row.agent_id,
            version: row.version,
            parentVersionId: row.parent_version_id || null,
            createdAt: row.created_at,
            createdBy: row.created_by,
            registrationSnapshot: row.registration_snapshot ? JSON.parse(row.registration_snapshot) : null,
            resourcesSnapshot: row.resources_snapshot ? JSON.parse(row.resources_snapshot) : null,
        };
    }

    private rowToExperiment(row: Record<string, any>): Experiment {
        return {
            id: row.id,
            agentId: row.agent_id,
            baseVersionId: row.base_version_id,
            resultVersionId: row.result_version_id || null,
            hypothesis: row.hypothesis,
            modificationType: row.modification_type,
            modificationDetail: JSON.parse(row.modification_detail),
            status: row.status,
            startedAt: row.started_at,
            completedAt: row.completed_at || null,
            benchmarkRunIds: row.benchmark_run_ids ? JSON.parse(row.benchmark_run_ids) : [],
            beforeMetrics: row.before_metrics ? JSON.parse(row.before_metrics) : null,
            afterMetrics: row.after_metrics ? JSON.parse(row.after_metrics) : null,
            delta: row.delta ? JSON.parse(row.delta) : null,
            verdict: row.verdict || null,
            notes: row.notes || null,
        };
    }
}
