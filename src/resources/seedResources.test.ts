/**
 * @fileoverview Unit tests for seedResources
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ResourceStore } from './ResourceStore';
import { seedResources } from './seedResources';

describe('seedResources', () => {
    let store: ResourceStore;
    let tmpDir: string;
    let resourcesDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-seed-test-'));
        store = new ResourceStore(tmpDir);
        await store.initialize();

        // Create a fake resources directory structure
        resourcesDir = path.join(tmpDir, 'resources');
        fs.mkdirSync(resourcesDir, { recursive: true });
    });

    afterEach(async () => {
        await store.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ========================================================================
    // BASIC SEEDING
    // ========================================================================

    it('seeds roles from roles/ directory', () => {
        const rolesDir = path.join(resourcesDir, 'roles');
        fs.mkdirSync(rolesDir, { recursive: true });
        fs.writeFileSync(path.join(rolesDir, 'hunter.md'), '# Hunter\nFinds vulnerabilities.');

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(1);
        expect(result.errors).toHaveLength(0);

        const resource = store.get('role-any-hunter');
        expect(resource).not.toBeNull();
        expect(resource!.name).toBe('Hunter');
        expect(resource!.type).toBe('role');
        expect(resource!.content).toBe('# Hunter\nFinds vulnerabilities.');
        expect(resource!.tags).toContain('role');
    });

    it('seeds articles from agents/ directory', () => {
        const agentsDir = path.join(resourcesDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, 'claude.md'), '# Claude Agent\nAI assistant.');

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(1);
        const resource = store.get('article-any-claude');
        expect(resource).not.toBeNull();
        expect(resource!.type).toBe('article');
    });

    it('seeds references from references/vulnerabilities/ directory', () => {
        const refDir = path.join(resourcesDir, 'references', 'vulnerabilities');
        fs.mkdirSync(refDir, { recursive: true });
        fs.writeFileSync(path.join(refDir, 'reentrancy.md'), '# Reentrancy\nCross-function reentrancy.');
        fs.writeFileSync(path.join(refDir, 'overflow-underflow.md'), '# Overflow\nInteger overflow.');

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(2);
        expect(store.count()).toBe(2);

        const ref = store.get('reference-any-reentrancy');
        expect(ref).not.toBeNull();
        expect(ref!.type).toBe('reference');
        expect(ref!.tags).toContain('reference');
    });

    // ========================================================================
    // PRIMERS (subdirectory tagging)
    // ========================================================================

    it('seeds primers with subdirectory name as tag', () => {
        const stakingDir = path.join(resourcesDir, 'primers', 'staking');
        fs.mkdirSync(stakingDir, { recursive: true });
        fs.writeFileSync(
            path.join(stakingDir, 'rocketpool.primer.md'),
            '# RocketPool\nDecentralized staking.',
        );

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(1);
        const resource = store.get('primer-any-rocketpool');
        expect(resource).not.toBeNull();
        expect(resource!.type).toBe('primer');
        expect(resource!.tags).toContain('staking');
        expect(resource!.tags).toContain('primer');
    });

    it('skips empty primer subdirectories', () => {
        const ammDir = path.join(resourcesDir, 'primers', 'amm');
        fs.mkdirSync(ammDir, { recursive: true });

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(0);
        expect(store.count()).toBe(0);
    });

    // ========================================================================
    // REPORTS (frontmatter stripping, recursive, skip non-md)
    // ========================================================================

    it('seeds markdown reports and strips YAML frontmatter', () => {
        const etherfiDir = path.join(resourcesDir, 'reports', 'etherfi');
        fs.mkdirSync(etherfiDir, { recursive: true });
        fs.writeFileSync(
            path.join(etherfiDir, 'zero-cool-report-2.md'),
            '---\ntitle: Etherfi Bb 2026\n---\n# Report\nFindings here.',
        );

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(1);
        const resource = store.get('report-any-zero-cool-report-2');
        expect(resource).not.toBeNull();
        expect(resource!.type).toBe('report');
        expect(resource!.content).toBe('# Report\nFindings here.');
        expect(resource!.tags).toContain('etherfi');
        expect(resource!.tags).toContain('report');
    });

    it('ignores non-markdown files in reports directory', () => {
        const reportsDir = path.join(resourcesDir, 'reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(path.join(reportsDir, 'audit.pdf'), 'PDF content');
        fs.writeFileSync(path.join(reportsDir, 'notes.txt'), 'text content');

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(0);
        expect(store.count()).toBe(0);
    });

    it('skips hidden directories in reports', () => {
        const hiddenDir = path.join(resourcesDir, 'reports', '.vscode');
        fs.mkdirSync(hiddenDir, { recursive: true });
        fs.writeFileSync(path.join(hiddenDir, 'notes.md'), '# Hidden notes');

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(0);
    });

    // ========================================================================
    // NAME GENERATION
    // ========================================================================

    it('converts filenames to display names correctly', () => {
        const rolesDir = path.join(resourcesDir, 'roles');
        fs.mkdirSync(rolesDir, { recursive: true });
        fs.writeFileSync(path.join(rolesDir, 'access-control-patterns.md'), '# Access Control');

        seedResources(store, resourcesDir);

        const resource = store.get('role-any-access-control-patterns');
        expect(resource).not.toBeNull();
        expect(resource!.name).toBe('Access Control Patterns');
    });

    it('strips .primer.md extension from primer filenames', () => {
        const dir = path.join(resourcesDir, 'primers', 'defi');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'lending-protocol.primer.md'), '# Lending');

        seedResources(store, resourcesDir);

        const resource = store.get('primer-any-lending-protocol');
        expect(resource).not.toBeNull();
        expect(resource!.name).toBe('Lending Protocol');
    });

    // ========================================================================
    // UPSERT BEHAVIOR
    // ========================================================================

    it('upserts on re-seed (version increments, content updates)', () => {
        const rolesDir = path.join(resourcesDir, 'roles');
        fs.mkdirSync(rolesDir, { recursive: true });
        fs.writeFileSync(path.join(rolesDir, 'hunter.md'), '# Hunter v1');

        seedResources(store, resourcesDir);
        const v1 = store.get('role-any-hunter');
        expect(v1!.version).toBe(1);

        // Update file and re-seed
        fs.writeFileSync(path.join(rolesDir, 'hunter.md'), '# Hunter v2');
        seedResources(store, resourcesDir);

        const v2 = store.get('role-any-hunter');
        expect(v2!.version).toBe(2);
        expect(v2!.content).toBe('# Hunter v2');
        expect(store.count()).toBe(1);
    });

    // ========================================================================
    // MULTI-CATEGORY
    // ========================================================================

    it('seeds multiple categories in a single call', () => {
        // Create roles
        const rolesDir = path.join(resourcesDir, 'roles');
        fs.mkdirSync(rolesDir, { recursive: true });
        fs.writeFileSync(path.join(rolesDir, 'hunter.md'), '# Hunter');
        fs.writeFileSync(path.join(rolesDir, 'cartographer.md'), '# Cartographer');

        // Create agents
        const agentsDir = path.join(resourcesDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, 'claude.md'), '# Claude');

        // Create references
        const refDir = path.join(resourcesDir, 'references', 'vulnerabilities');
        fs.mkdirSync(refDir, { recursive: true });
        fs.writeFileSync(path.join(refDir, 'reentrancy.md'), '# Reentrancy');

        // Create primers
        const primerDir = path.join(resourcesDir, 'primers', 'staking');
        fs.mkdirSync(primerDir, { recursive: true });
        fs.writeFileSync(path.join(primerDir, 'rocketpool.primer.md'), '# RP');

        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(5);
        expect(result.errors).toHaveLength(0);
        expect(store.count()).toBe(5);
    });

    // ========================================================================
    // ERROR HANDLING
    // ========================================================================

    it('returns error when resources directory does not exist', () => {
        const result = seedResources(store, '/nonexistent/path');

        expect(result.seeded).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('not found');
    });

    it('handles missing subdirectories gracefully', () => {
        // resourcesDir exists but has no subdirectories
        const result = seedResources(store, resourcesDir);

        expect(result.seeded).toBe(0);
        expect(result.errors).toHaveLength(0);
    });
});
