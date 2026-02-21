/**
 * @fileoverview Unit tests for AuditRegistry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuditRegistry } from './AuditRegistry';

describe('AuditRegistry', () => {
    let tmpDir: string;
    let registry: AuditRegistry;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-ar-test-'));
        // Create the audits subdir since ensureSeraHome isn't called
        fs.mkdirSync(path.join(tmpDir, 'audits'), { recursive: true });
        registry = new AuditRegistry(tmpDir);
        registry.load();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('createAudit', () => {
        it('creates audit directory and meta.json', () => {
            const dbPath = registry.createAudit('test-audit', 'Test Audit', '/workspace');

            expect(fs.existsSync(path.join(tmpDir, 'audits', 'test-audit', 'meta.json'))).toBe(true);
            expect(dbPath).toContain('test-audit');
            expect(dbPath).toContain('audit.db');
        });

        it('registers the workspace mapping', () => {
            registry.createAudit('test-audit', 'Test Audit', '/workspace');

            expect(registry.lookupWorkspace('/workspace')).toBe('test-audit');
        });
    });

    describe('lookupWorkspace', () => {
        it('returns null for unknown workspace', () => {
            expect(registry.lookupWorkspace('/unknown')).toBeNull();
        });

        it('returns slug for registered workspace', () => {
            registry.registerWorkspace('/my/workspace', 'my-audit');
            expect(registry.lookupWorkspace('/my/workspace')).toBe('my-audit');
        });
    });

    describe('auditExists', () => {
        it('returns false for non-existent audit', () => {
            expect(registry.auditExists('fake')).toBe(false);
        });

        it('returns true for existing audit', () => {
            registry.createAudit('real', 'Real Audit', '/ws');
            expect(registry.auditExists('real')).toBe(true);
        });
    });

    describe('listAudits', () => {
        it('returns empty array when no audits exist', () => {
            expect(registry.listAudits()).toHaveLength(0);
        });

        it('lists all created audits', () => {
            registry.createAudit('alpha', 'Alpha', '/ws-a');
            registry.createAudit('beta', 'Beta', '/ws-b');

            const audits = registry.listAudits();
            expect(audits).toHaveLength(2);
            const slugs = audits.map(a => a.slug).sort();
            expect(slugs).toEqual(['alpha', 'beta']);
        });
    });

    describe('touchAudit', () => {
        it('updates lastAccessed timestamp', () => {
            registry.createAudit('touch-test', 'Touch Test', '/ws');
            const before = registry.getAuditMeta('touch-test')!.lastAccessed;

            // Small delay to ensure timestamp differs
            const meta = registry.getAuditMeta('touch-test')!;
            meta.lastAccessed = '2000-01-01T00:00:00.000Z';
            fs.writeFileSync(
                path.join(tmpDir, 'audits', 'touch-test', 'meta.json'),
                JSON.stringify(meta, null, 2)
            );

            registry.touchAudit('touch-test');
            const after = registry.getAuditMeta('touch-test')!.lastAccessed;

            expect(after).not.toBe('2000-01-01T00:00:00.000Z');
        });
    });

    describe('getAuditMeta', () => {
        it('returns null for non-existent audit', () => {
            expect(registry.getAuditMeta('fake')).toBeNull();
        });

        it('returns metadata for existing audit', () => {
            registry.createAudit('meta-test', 'Meta Test', '/ws');
            const meta = registry.getAuditMeta('meta-test');

            expect(meta).not.toBeNull();
            expect(meta!.slug).toBe('meta-test');
            expect(meta!.name).toBe('Meta Test');
            expect(meta!.workspacePaths).toContain('/ws');
        });
    });

    describe('slugify', () => {
        it('converts to lowercase kebab-case', () => {
            expect(AuditRegistry.slugify('My Audit Name')).toBe('my-audit-name');
        });

        it('strips special characters', () => {
            expect(AuditRegistry.slugify('Test@#$Audit!')).toBe('test-audit');
        });

        it('trims leading/trailing hyphens', () => {
            expect(AuditRegistry.slugify('---test---')).toBe('test');
        });

        it('collapses multiple hyphens', () => {
            expect(AuditRegistry.slugify('a   b   c')).toBe('a-b-c');
        });
    });

    describe('persistence', () => {
        it('persists registry across instances', () => {
            registry.createAudit('persist-test', 'Persist Test', '/ws');

            // Create a new instance and load
            const registry2 = new AuditRegistry(tmpDir);
            registry2.load();

            expect(registry2.lookupWorkspace('/ws')).toBe('persist-test');
            expect(registry2.auditExists('persist-test')).toBe(true);
        });
    });
});
