/**
 * @fileoverview Pipeline execution persistence layer
 * @module sera-core/pipeline/PipelinePersistence
 *
 * Stores pipeline runs, node runs, execution events, and snapshots
 * using sera-core's StorageEngine (sql.js) per audit.
 */

import type {
    PipelineRun,
    NodeRun,
    PipelineExecutionEvent,
    PipelineSnapshot,
    PipelineSpec,
    TableSchema,
} from '@sera/types';
import type { DatabaseManager } from '../database/DatabaseManager';

const APPLET_ID = 'pipeline';

/** Table schemas registered with StorageEngine */
export const PIPELINE_TABLE_SCHEMAS: TableSchema[] = [
    {
        name: 'pipeline_runs',
        fields: [
            { name: 'id', type: 'TEXT' as const, required: true, primaryKey: true },
            { name: 'pipelineId', type: 'TEXT' as const, required: false },
            { name: 'pipelineSpecVersion', type: 'TEXT' as const, required: false },
            { name: 'auditSlug', type: 'TEXT' as const, required: false },
            { name: 'state', type: 'TEXT' as const, required: true },
            { name: 'variables', type: 'TEXT' as const, required: false },
            { name: 'concurrency', type: 'TEXT' as const, required: false },
            { name: 'startedAt', type: 'TEXT' as const, required: false },
            { name: 'completedAt', type: 'TEXT' as const, required: false },
            { name: 'error', type: 'TEXT' as const, required: false },
            { name: 'progress', type: 'REAL' as const, required: false },
        ],
    },
    {
        name: 'node_runs',
        fields: [
            { name: 'id', type: 'TEXT' as const, required: true, primaryKey: true },
            { name: 'runId', type: 'TEXT' as const, required: true },
            { name: 'nodeId', type: 'TEXT' as const, required: true },
            { name: 'nodeType', type: 'TEXT' as const, required: true },
            { name: 'state', type: 'TEXT' as const, required: true },
            { name: 'attempts', type: 'INTEGER' as const, required: false },
            { name: 'startedAt', type: 'TEXT' as const, required: false },
            { name: 'completedAt', type: 'TEXT' as const, required: false },
            { name: 'error', type: 'TEXT' as const, required: false },
            { name: 'outputs', type: 'TEXT' as const, required: false },
        ],
    },
    {
        name: 'execution_events',
        fields: [
            { name: 'id', type: 'TEXT' as const, required: true, primaryKey: true },
            { name: 'runId', type: 'TEXT' as const, required: true },
            { name: 'type', type: 'TEXT' as const, required: true },
            { name: 'nodeId', type: 'TEXT' as const, required: false },
            { name: 'timestamp', type: 'TEXT' as const, required: true },
            { name: 'payload', type: 'TEXT' as const, required: false },
        ],
    },
    {
        name: 'pipeline_snapshots',
        fields: [
            { name: 'runId', type: 'TEXT' as const, required: true, primaryKey: true },
            { name: 'timestamp', type: 'TEXT' as const, required: true },
            { name: 'walkerState', type: 'TEXT' as const, required: true },
        ],
    },
    {
        name: 'pipeline_specs',
        fields: [
            { name: 'id', type: 'TEXT' as const, required: true, primaryKey: true },
            { name: 'name', type: 'TEXT' as const, required: true },
            { name: 'version', type: 'TEXT' as const, required: true },
            { name: 'spec', type: 'TEXT' as const, required: true },
            { name: 'createdAt', type: 'TEXT' as const, required: false },
            { name: 'updatedAt', type: 'TEXT' as const, required: false },
        ],
    },
];

/**
 * Persistence layer for pipeline execution data.
 */
export class PipelinePersistence {
    private dbManager: DatabaseManager;

    constructor(dbManager: DatabaseManager) {
        this.dbManager = dbManager;
    }

    /**
     * Ensure pipeline tables are registered for an audit.
     */
    async ensureTables(auditSlug: string): Promise<void> {
        const engine = await this.dbManager.getEngine(auditSlug);
        engine.registerTables(APPLET_ID, PIPELINE_TABLE_SCHEMAS);
    }

    // ========================================================================
    // PIPELINE RUNS
    // ========================================================================

    async createRun(auditSlug: string, run: PipelineRun): Promise<void> {
        const engine = await this.dbManager.getEngine(auditSlug);
        engine.write(APPLET_ID, 'pipeline_runs', {
            id: run.id,
            pipelineId: run.pipelineId,
            pipelineSpecVersion: run.pipelineSpecVersion,
            auditSlug: run.auditSlug,
            state: run.state,
            variables: JSON.stringify(run.variables),
            concurrency: JSON.stringify(run.concurrency),
            startedAt: run.startedAt ?? null,
            completedAt: run.completedAt ?? null,
            error: run.error ?? null,
            progress: run.progress,
        });
    }

    async updateRun(auditSlug: string, runId: string, updates: Partial<PipelineRun>): Promise<void> {
        const engine = await this.dbManager.getEngine(auditSlug);
        const data: Record<string, unknown> = { id: runId };
        if (updates.state !== undefined) data.state = updates.state;
        if (updates.startedAt !== undefined) data.startedAt = updates.startedAt;
        if (updates.completedAt !== undefined) data.completedAt = updates.completedAt;
        if (updates.error !== undefined) data.error = updates.error;
        if (updates.progress !== undefined) data.progress = updates.progress;
        engine.write(APPLET_ID, 'pipeline_runs', data);
    }

    async getRun(auditSlug: string, runId: string): Promise<PipelineRun | null> {
        const engine = await this.dbManager.getEngine(auditSlug);
        const records = engine.query(APPLET_ID, 'pipeline_runs', { id: runId });
        if (records.length === 0) return null;
        return this.deserializeRun(records[0]);
    }

    async listRuns(auditSlug?: string): Promise<PipelineRun[]> {
        if (!auditSlug) return [];
        const engine = await this.dbManager.getEngine(auditSlug);
        const records = engine.query(APPLET_ID, 'pipeline_runs');
        return records.map(r => this.deserializeRun(r));
    }

    // ========================================================================
    // NODE RUNS
    // ========================================================================

    async createNodeRun(auditSlug: string, nodeRun: NodeRun): Promise<void> {
        const engine = await this.dbManager.getEngine(auditSlug);
        engine.write(APPLET_ID, 'node_runs', {
            id: nodeRun.id,
            runId: nodeRun.runId,
            nodeId: nodeRun.nodeId,
            nodeType: nodeRun.nodeType,
            state: nodeRun.state,
            attempts: nodeRun.attempts,
            startedAt: nodeRun.startedAt ?? null,
            completedAt: nodeRun.completedAt ?? null,
            error: nodeRun.error ?? null,
            outputs: nodeRun.outputs ? JSON.stringify(nodeRun.outputs) : null,
        });
    }

    async updateNodeRun(auditSlug: string, nodeRunId: string, updates: Partial<NodeRun>): Promise<void> {
        const engine = await this.dbManager.getEngine(auditSlug);
        const data: Record<string, unknown> = { id: nodeRunId };
        if (updates.state !== undefined) data.state = updates.state;
        if (updates.startedAt !== undefined) data.startedAt = updates.startedAt;
        if (updates.completedAt !== undefined) data.completedAt = updates.completedAt;
        if (updates.error !== undefined) data.error = updates.error;
        if (updates.attempts !== undefined) data.attempts = updates.attempts;
        if (updates.outputs !== undefined) data.outputs = JSON.stringify(updates.outputs);
        engine.write(APPLET_ID, 'node_runs', data);
    }

    async getNodeRuns(auditSlug: string, runId: string): Promise<NodeRun[]> {
        const engine = await this.dbManager.getEngine(auditSlug);
        const records = engine.query(APPLET_ID, 'node_runs', { runId });
        return records.map(r => this.deserializeNodeRun(r));
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    async logEvent(auditSlug: string, event: PipelineExecutionEvent): Promise<void> {
        const engine = await this.dbManager.getEngine(auditSlug);
        engine.write(APPLET_ID, 'execution_events', {
            id: event.id,
            runId: event.runId,
            type: event.type,
            nodeId: event.nodeId ?? null,
            timestamp: event.timestamp,
            payload: event.payload ? JSON.stringify(event.payload) : null,
        });
    }

    async getEvents(auditSlug: string, runId: string): Promise<PipelineExecutionEvent[]> {
        const engine = await this.dbManager.getEngine(auditSlug);
        const records = engine.query(APPLET_ID, 'execution_events', { runId });
        return records.map(r => ({
            id: r.id as string,
            runId: r.runId as string,
            type: r.type as PipelineExecutionEvent['type'],
            nodeId: r.nodeId as string | undefined,
            timestamp: r.timestamp as string,
            payload: r.payload ? JSON.parse(r.payload as string) : undefined,
        }));
    }

    // ========================================================================
    // SNAPSHOTS
    // ========================================================================

    async saveSnapshot(auditSlug: string, snapshot: PipelineSnapshot): Promise<void> {
        const engine = await this.dbManager.getEngine(auditSlug);
        engine.write(APPLET_ID, 'pipeline_snapshots', {
            runId: snapshot.runId,
            timestamp: snapshot.timestamp,
            walkerState: JSON.stringify(snapshot.walkerState),
        });
    }

    async loadSnapshot(auditSlug: string, runId: string): Promise<PipelineSnapshot | null> {
        const engine = await this.dbManager.getEngine(auditSlug);
        const records = engine.query(APPLET_ID, 'pipeline_snapshots', { runId });
        if (records.length === 0) return null;
        const r = records[0];
        return {
            runId: r.runId as string,
            timestamp: r.timestamp as string,
            walkerState: JSON.parse(r.walkerState as string),
        };
    }

    // ========================================================================
    // PIPELINE SPECS
    // ========================================================================

    async saveSpec(auditSlug: string, spec: PipelineSpec): Promise<void> {
        const engine = await this.dbManager.getEngine(auditSlug);
        engine.write(APPLET_ID, 'pipeline_specs', {
            id: spec.id,
            name: spec.name,
            version: spec.version,
            spec: JSON.stringify(spec),
            createdAt: spec.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    }

    async getSpec(auditSlug: string, specId: string): Promise<PipelineSpec | null> {
        const engine = await this.dbManager.getEngine(auditSlug);
        const records = engine.query(APPLET_ID, 'pipeline_specs', { id: specId });
        if (records.length === 0) return null;
        return JSON.parse(records[0].spec as string);
    }

    async listSpecs(auditSlug: string): Promise<Array<{ id: string; name: string; version: string; updatedAt: string }>> {
        const engine = await this.dbManager.getEngine(auditSlug);
        const records = engine.query(APPLET_ID, 'pipeline_specs');
        return records.map(r => ({
            id: r.id as string,
            name: r.name as string,
            version: r.version as string,
            updatedAt: r.updatedAt as string,
        }));
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    private deserializeRun(r: Record<string, unknown>): PipelineRun {
        return {
            id: r.id as string,
            pipelineId: r.pipelineId as string,
            pipelineSpecVersion: r.pipelineSpecVersion as string,
            auditSlug: r.auditSlug as string,
            state: r.state as PipelineRun['state'],
            variables: r.variables ? JSON.parse(r.variables as string) : {},
            concurrency: r.concurrency ? JSON.parse(r.concurrency as string) : { maxParallelNodes: 4, maxParallelAgents: 2, maxDockerContainers: 2 },
            startedAt: r.startedAt as string | undefined,
            completedAt: r.completedAt as string | undefined,
            error: r.error as string | undefined,
            progress: (r.progress as number) ?? 0,
        };
    }

    private deserializeNodeRun(r: Record<string, unknown>): NodeRun {
        return {
            id: r.id as string,
            runId: r.runId as string,
            nodeId: r.nodeId as string,
            nodeType: r.nodeType as NodeRun['nodeType'],
            state: r.state as NodeRun['state'],
            attempts: (r.attempts as number) ?? 1,
            startedAt: r.startedAt as string | undefined,
            completedAt: r.completedAt as string | undefined,
            error: r.error as string | undefined,
            outputs: r.outputs ? JSON.parse(r.outputs as string) : undefined,
        };
    }
}
