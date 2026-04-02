/**
 * @fileoverview Unit tests for DatabaseManager
 *
 * Tests getEngine, hasEngine, closeEngine, shutdownAll, getActiveAudits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseManager } from './DatabaseManager';
import { AuditRegistry } from './AuditRegistry';

describe('DatabaseManager', () => {
    let tmpDir: string;
    let registry: AuditRegistry;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-dbmgr-test-'));
        registry = new AuditRegistry(tmpDir);
        registry.load();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('getEngine creates and caches an engine', async () => {
        // createAudit sets up the audit directory and meta file
        registry.createAudit('test-audit', 'Test Audit', '/tmp/workspace');

        const mgr = new DatabaseManager(registry, 0);
        expect(mgr.hasEngine('test-audit')).toBe(false);

        const engine = await mgr.getEngine('test-audit');
        expect(engine).toBeDefined();
        expect(mgr.hasEngine('test-audit')).toBe(true);

        // Second call returns the same instance
        const engine2 = await mgr.getEngine('test-audit');
        expect(engine2).toBe(engine);

        await mgr.shutdownAll();
    });

    it('getActiveAudits returns active slugs', async () => {
        registry.createAudit('audit-a', 'Audit A', '/tmp/a');
        registry.createAudit('audit-b', 'Audit B', '/tmp/b');

        const mgr = new DatabaseManager(registry, 0);
        expect(mgr.getActiveAudits()).toEqual([]);

        await mgr.getEngine('audit-a');
        expect(mgr.getActiveAudits()).toEqual(['audit-a']);

        await mgr.getEngine('audit-b');
        expect(mgr.getActiveAudits()).toEqual(['audit-a', 'audit-b']);

        await mgr.shutdownAll();
    });

    it('closeEngine shuts down and removes one engine', async () => {
        registry.createAudit('close-test', 'Close Test', '/tmp/close');
        const mgr = new DatabaseManager(registry, 0);

        await mgr.getEngine('close-test');
        expect(mgr.hasEngine('close-test')).toBe(true);

        await mgr.closeEngine('close-test');
        expect(mgr.hasEngine('close-test')).toBe(false);
        expect(mgr.getActiveAudits()).toEqual([]);
    });

    it('closeEngine is a no-op for unknown slug', async () => {
        const mgr = new DatabaseManager(registry, 0);
        await mgr.closeEngine('nonexistent');
        expect(mgr.getActiveAudits()).toEqual([]);
    });

    it('shutdownAll closes all engines', async () => {
        registry.createAudit('sa-1', 'SA 1', '/tmp/sa1');
        registry.createAudit('sa-2', 'SA 2', '/tmp/sa2');

        const mgr = new DatabaseManager(registry, 0);
        await mgr.getEngine('sa-1');
        await mgr.getEngine('sa-2');
        expect(mgr.getActiveAudits()).toHaveLength(2);

        await mgr.shutdownAll();
        expect(mgr.getActiveAudits()).toEqual([]);
        expect(mgr.hasEngine('sa-1')).toBe(false);
        expect(mgr.hasEngine('sa-2')).toBe(false);
    });

    it('shutdownAll is safe with no engines', async () => {
        const mgr = new DatabaseManager(registry, 0);
        await mgr.shutdownAll();
        expect(mgr.getActiveAudits()).toEqual([]);
    });
});
