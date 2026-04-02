/**
 * @fileoverview Unit tests for VersionStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VersionStore } from './VersionStore';

describe('VersionStore', () => {
    let store: VersionStore;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-version-test-'));
        store = new VersionStore(tmpDir);
        await store.initialize();
    });

    afterEach(async () => {
        await store.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    it('initializes without error and creates database file', () => {
        expect(fs.existsSync(path.join(tmpDir, 'versions.db'))).toBe(true);
    });

    it('starts with zero versions and experiments', () => {
        expect(store.versionCount()).toBe(0);
        expect(store.experimentCount()).toBe(0);
    });

    // ========================================================================
    // VERSION CRUD
    // ========================================================================

    it('creates a version with all fields', () => {
        const version = store.createVersion({
            agentId: 'hunter-v1',
            version: '0.1.0',
            createdBy: 'human',
            registrationSnapshot: { id: 'hunter-v1', name: 'Hunter' },
            resourcesSnapshot: { roleId: 'role-solidity-hunter', primerIds: [] },
        });

        expect(version.id).toBeDefined();
        expect(version.agentId).toBe('hunter-v1');
        expect(version.version).toBe('0.1.0');
        expect(version.parentVersionId).toBeNull();
        expect(version.createdBy).toBe('human');
        expect(version.registrationSnapshot).toEqual({ id: 'hunter-v1', name: 'Hunter' });
        expect(version.resourcesSnapshot).toEqual({ roleId: 'role-solidity-hunter', primerIds: [] });
        expect(version.createdAt).toBeDefined();
    });

    it('creates a root version with null parentVersionId', () => {
        const version = store.createVersion({
            agentId: 'hunter-v1',
            version: '0.1.0',
            createdBy: 'human',
        });

        expect(version.parentVersionId).toBeNull();
    });

    it('creates a child version linked to parent', () => {
        const parent = store.createVersion({
            agentId: 'hunter-v1',
            version: '0.1.0',
            createdBy: 'human',
        });

        const child = store.createVersion({
            agentId: 'hunter-v1',
            version: '0.2.0',
            parentVersionId: parent.id,
            createdBy: 'autonomous-loop',
        });

        expect(child.parentVersionId).toBe(parent.id);
    });

    it('gets a version by ID', () => {
        const created = store.createVersion({
            agentId: 'hunter-v1',
            version: '0.1.0',
            createdBy: 'human',
            registrationSnapshot: { id: 'hunter-v1' },
        });

        const fetched = store.getVersion(created.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.agentId).toBe('hunter-v1');
        expect(fetched!.registrationSnapshot).toEqual({ id: 'hunter-v1' });
    });

    it('returns null for non-existent version ID', () => {
        expect(store.getVersion('nonexistent')).toBeNull();
    });

    it('lists versions by agent, newest first', () => {
        store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        store.createVersion({ agentId: 'hunter', version: '0.2.0', createdBy: 'human' });
        store.createVersion({ agentId: 'other-agent', version: '0.1.0', createdBy: 'human' });

        const versions = store.getVersionsByAgent('hunter');
        expect(versions).toHaveLength(2);
        expect(versions[0].version).toBe('0.2.0');
        expect(versions[1].version).toBe('0.1.0');
    });

    it('returns empty array for unknown agent', () => {
        expect(store.getVersionsByAgent('nonexistent')).toEqual([]);
    });

    it('gets the latest version for an agent', () => {
        store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        store.createVersion({ agentId: 'hunter', version: '0.2.0', createdBy: 'human' });

        const latest = store.getLatestVersion('hunter');
        expect(latest).not.toBeNull();
        expect(latest!.version).toBe('0.2.0');
    });

    it('returns null for latest version of unknown agent', () => {
        expect(store.getLatestVersion('nonexistent')).toBeNull();
    });

    it('enforces unique (agent_id, version) constraint', () => {
        store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        expect(() => {
            store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        }).toThrow();
    });

    // ========================================================================
    // VERSION LINEAGE
    // ========================================================================

    it('walks parent chain from child to root', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const v2 = store.createVersion({ agentId: 'hunter', version: '0.2.0', parentVersionId: v1.id, createdBy: 'human' });
        const v3 = store.createVersion({ agentId: 'hunter', version: '0.3.0', parentVersionId: v2.id, createdBy: 'autonomous-loop' });

        const lineage = store.getLineage(v3.id);
        expect(lineage).toHaveLength(3);
        expect(lineage[0].version).toBe('0.3.0');
        expect(lineage[1].version).toBe('0.2.0');
        expect(lineage[2].version).toBe('0.1.0');
    });

    it('returns single-element array for root version', () => {
        const root = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const lineage = store.getLineage(root.id);
        expect(lineage).toHaveLength(1);
        expect(lineage[0].id).toBe(root.id);
    });

    it('returns empty array for non-existent version ID', () => {
        expect(store.getLineage('nonexistent')).toEqual([]);
    });

    // ========================================================================
    // EXPERIMENT CRUD
    // ========================================================================

    it('creates an experiment with status pending', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });

        const exp = store.createExperiment({
            agentId: 'hunter',
            baseVersionId: v1.id,
            hypothesis: 'Adding reentrancy primer improves recall',
            modificationType: 'primer-attachment',
            modificationDetail: { primerId: 'primer-reentrancy', action: 'add' },
        });

        expect(exp.id).toBeDefined();
        expect(exp.status).toBe('pending');
        expect(exp.agentId).toBe('hunter');
        expect(exp.baseVersionId).toBe(v1.id);
        expect(exp.hypothesis).toBe('Adding reentrancy primer improves recall');
        expect(exp.modificationType).toBe('primer-attachment');
        expect(exp.modificationDetail).toEqual({ primerId: 'primer-reentrancy', action: 'add' });
        expect(exp.benchmarkRunIds).toEqual([]);
        expect(exp.resultVersionId).toBeNull();
        expect(exp.verdict).toBeNull();
    });

    it('gets experiment by ID', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const created = store.createExperiment({
            agentId: 'hunter', baseVersionId: v1.id,
            hypothesis: 'test', modificationType: 'custom',
            modificationDetail: { description: 'test' },
        });

        const fetched = store.getExperiment(created.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.hypothesis).toBe('test');
    });

    it('returns null for non-existent experiment ID', () => {
        expect(store.getExperiment('nonexistent')).toBeNull();
    });

    it('lists experiments by agent', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });
        store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h2', modificationType: 'custom', modificationDetail: {} });
        store.createExperiment({ agentId: 'other', baseVersionId: v1.id, hypothesis: 'h3', modificationType: 'custom', modificationDetail: {} });

        const experiments = store.listExperiments('hunter');
        expect(experiments).toHaveLength(2);
    });

    it('filters experiments by status', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const exp1 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });
        store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h2', modificationType: 'custom', modificationDetail: {} });

        store.updateExperiment(exp1.id, { status: 'improved' });

        const improved = store.listExperiments('hunter', { status: 'improved' });
        expect(improved).toHaveLength(1);
        expect(improved[0].id).toBe(exp1.id);
    });

    it('filters experiments by modification type', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'primer-attachment', modificationDetail: {} });
        store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h2', modificationType: 'tool-addition', modificationDetail: {} });

        const primers = store.listExperiments('hunter', { modificationType: 'primer-attachment' });
        expect(primers).toHaveLength(1);
        expect(primers[0].modificationType).toBe('primer-attachment');
    });

    it('respects limit parameter', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        for (let i = 0; i < 5; i++) {
            store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: `h${i}`, modificationType: 'custom', modificationDetail: {} });
        }

        const limited = store.listExperiments('hunter', { limit: 2 });
        expect(limited).toHaveLength(2);
    });

    // ========================================================================
    // EXPERIMENT UPDATE
    // ========================================================================

    it('updates experiment status and verdict', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const exp = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });

        store.updateExperiment(exp.id, {
            status: 'improved',
            verdict: 'keep',
            completedAt: new Date().toISOString(),
            notes: 'Significant improvement in recall',
        });

        const updated = store.getExperiment(exp.id);
        expect(updated!.status).toBe('improved');
        expect(updated!.verdict).toBe('keep');
        expect(updated!.completedAt).toBeDefined();
        expect(updated!.notes).toBe('Significant improvement in recall');
    });

    it('updates metrics and delta as JSON', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const exp = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });

        const before = { score: 60, recall: 0.5, precision: 0.8 };
        const after = { score: 72, recall: 0.65, precision: 0.75 };
        const delta = { score: 12, recall: 0.15, precision: -0.05 };

        store.updateExperiment(exp.id, {
            benchmarkRunIds: ['run-1', 'run-2'],
            beforeMetrics: before,
            afterMetrics: after,
            delta,
        });

        const updated = store.getExperiment(exp.id);
        expect(updated!.benchmarkRunIds).toEqual(['run-1', 'run-2']);
        expect(updated!.beforeMetrics).toEqual(before);
        expect(updated!.afterMetrics).toEqual(after);
        expect(updated!.delta).toEqual(delta);
    });

    it('updates result version ID', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const v2 = store.createVersion({ agentId: 'hunter', version: '0.2.0', parentVersionId: v1.id, createdBy: 'autonomous-loop' });
        const exp = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });

        store.updateExperiment(exp.id, { resultVersionId: v2.id });

        const updated = store.getExperiment(exp.id);
        expect(updated!.resultVersionId).toBe(v2.id);
    });

    // ========================================================================
    // EXPERIMENT SUMMARY
    // ========================================================================

    it('returns correct totals for experiment summary', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });

        const e1 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });
        const e2 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h2', modificationType: 'custom', modificationDetail: {} });
        const e3 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h3', modificationType: 'custom', modificationDetail: {} });
        const e4 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h4', modificationType: 'custom', modificationDetail: {} });

        store.updateExperiment(e1.id, { status: 'improved', delta: { score: 5 } });
        store.updateExperiment(e2.id, { status: 'regressed', delta: { score: -3 } });
        store.updateExperiment(e3.id, { status: 'neutral', delta: { score: 0 } });
        store.updateExperiment(e4.id, { status: 'reverted', delta: { score: -1 } });

        const summary = store.getExperimentSummary('hunter');
        expect(summary.totalExperiments).toBe(4);
        expect(summary.improved).toBe(1);
        expect(summary.regressed).toBe(1);
        expect(summary.neutral).toBe(1);
        expect(summary.reverted).toBe(1);
    });

    it('calculates success rate correctly', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const e1 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });
        const e2 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h2', modificationType: 'custom', modificationDetail: {} });

        store.updateExperiment(e1.id, { status: 'improved' });
        store.updateExperiment(e2.id, { status: 'regressed' });

        const summary = store.getExperimentSummary('hunter');
        expect(summary.successRate).toBe(0.5);
    });

    it('returns top improvements sorted by delta.score', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const e1 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'small gain', modificationType: 'custom', modificationDetail: {} });
        const e2 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'big gain', modificationType: 'custom', modificationDetail: {} });

        store.updateExperiment(e1.id, { status: 'improved', delta: { score: 2 } });
        store.updateExperiment(e2.id, { status: 'improved', delta: { score: 10 } });

        const summary = store.getExperimentSummary('hunter');
        expect(summary.topImprovements).toHaveLength(2);
        expect(summary.topImprovements[0].delta.score).toBe(10);
        expect(summary.topImprovements[1].delta.score).toBe(2);
    });

    it('calculates net score change', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        const e1 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });
        const e2 = store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h2', modificationType: 'custom', modificationDetail: {} });

        store.updateExperiment(e1.id, { delta: { score: 8 } });
        store.updateExperiment(e2.id, { delta: { score: -3 } });

        const summary = store.getExperimentSummary('hunter');
        expect(summary.netScoreChange).toBe(5);
    });

    it('returns sensible defaults when no experiments exist', () => {
        const summary = store.getExperimentSummary('nonexistent');
        expect(summary.totalExperiments).toBe(0);
        expect(summary.improved).toBe(0);
        expect(summary.successRate).toBe(0);
        expect(summary.topImprovements).toEqual([]);
        expect(summary.topRegressions).toEqual([]);
        expect(summary.netScoreChange).toBe(0);
        expect(summary.currentBestVersion).toBeNull();
    });

    it('filters summary by since date', () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: {} });

        // Query with a future date should return nothing
        const summary = store.getExperimentSummary('hunter', '2099-01-01T00:00:00Z');
        expect(summary.totalExperiments).toBe(0);
    });

    // ========================================================================
    // PERSISTENCE
    // ========================================================================

    it('persists versions across shutdown and reinitialize', async () => {
        store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        expect(store.versionCount()).toBe(1);

        await store.shutdown();

        const store2 = new VersionStore(tmpDir);
        await store2.initialize();

        expect(store2.versionCount()).toBe(1);
        const versions = store2.getVersionsByAgent('hunter');
        expect(versions[0].version).toBe('0.1.0');

        await store2.shutdown();
        store = new VersionStore(tmpDir);
        await store.initialize();
    });

    it('persists experiments across shutdown and reinitialize', async () => {
        const v1 = store.createVersion({ agentId: 'hunter', version: '0.1.0', createdBy: 'human' });
        store.createExperiment({ agentId: 'hunter', baseVersionId: v1.id, hypothesis: 'h1', modificationType: 'custom', modificationDetail: { x: 1 } });
        expect(store.experimentCount()).toBe(1);

        await store.shutdown();

        const store2 = new VersionStore(tmpDir);
        await store2.initialize();

        expect(store2.experimentCount()).toBe(1);
        const exps = store2.listExperiments('hunter');
        expect(exps[0].hypothesis).toBe('h1');
        expect(exps[0].modificationDetail).toEqual({ x: 1 });

        await store2.shutdown();
        store = new VersionStore(tmpDir);
        await store.initialize();
    });
});
