/**
 * @fileoverview Unit tests for ResourceStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ResourceStore } from './ResourceStore';

describe('ResourceStore', () => {
    let store: ResourceStore;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-resource-test-'));
        store = new ResourceStore(tmpDir);
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
        expect(fs.existsSync(path.join(tmpDir, 'resources.db'))).toBe(true);
    });

    it('starts with zero resources', () => {
        expect(store.count()).toBe(0);
    });

    // ========================================================================
    // CREATE
    // ========================================================================

    it('creates a resource with all fields', () => {
        const resource = store.create({
            type: 'role',
            language: 'solidity',
            name: 'Hunter',
            content: '# Hunter\nFinds vulnerabilities.',
            tags: ['hunter', 'solidity'],
            metadata: { author: 'test' },
        });

        expect(resource.id).toBe('role-solidity-hunter');
        expect(resource.slug).toBe('solidity-hunter');
        expect(resource.type).toBe('role');
        expect(resource.language).toBe('solidity');
        expect(resource.name).toBe('Hunter');
        expect(resource.content).toBe('# Hunter\nFinds vulnerabilities.');
        expect(resource.tags).toEqual(['hunter', 'solidity']);
        expect(resource.metadata).toEqual({ author: 'test' });
        expect(resource.version).toBe(1);
        expect(resource.createdAt).toBeGreaterThan(0);
        expect(resource.updatedAt).toBe(resource.createdAt);
    });

    it('creates a resource with minimal fields (defaults applied)', () => {
        const resource = store.create({
            type: 'reference',
            name: 'Reentrancy',
            content: '# Reentrancy patterns',
        });

        expect(resource.language).toBe('any');
        expect(resource.tags).toEqual([]);
        expect(resource.metadata).toEqual({});
        expect(resource.version).toBe(1);
    });

    it('throws when creating a resource with duplicate ID', () => {
        store.create({ type: 'role', language: 'solidity', name: 'Hunter', content: 'v1' });
        expect(() => {
            store.create({ type: 'role', language: 'solidity', name: 'Hunter', content: 'v2' });
        }).toThrow('Resource already exists');
    });

    // ========================================================================
    // GET
    // ========================================================================

    it('gets a resource by ID', () => {
        store.create({ type: 'role', language: 'solidity', name: 'Hunter', content: 'test content' });

        const resource = store.get('role-solidity-hunter');
        expect(resource).not.toBeNull();
        expect(resource!.name).toBe('Hunter');
        expect(resource!.content).toBe('test content');
    });

    it('returns null for non-existent ID', () => {
        expect(store.get('role-solidity-nonexistent')).toBeNull();
    });

    it('gets a resource by slug', () => {
        store.create({ type: 'role', language: 'solidity', name: 'Hunter', content: 'test' });

        const resource = store.getBySlug('solidity-hunter');
        expect(resource).not.toBeNull();
        expect(resource!.id).toBe('role-solidity-hunter');
    });

    // ========================================================================
    // LIST
    // ========================================================================

    it('lists all resources as summaries (no content field)', () => {
        store.create({ type: 'role', name: 'Hunter', content: 'long content here' });
        store.create({ type: 'primer', name: 'Lending', content: 'lending primer' });

        const list = store.list();
        expect(list).toHaveLength(2);

        // Summaries should not have content, but should have contentLength
        const summary = list[0];
        expect(summary).not.toHaveProperty('content');
        expect(summary.contentLength).toBeGreaterThan(0);
    });

    it('filters by type', () => {
        store.create({ type: 'role', name: 'Hunter', content: 'role content' });
        store.create({ type: 'primer', name: 'Lending', content: 'primer content' });
        store.create({ type: 'reference', name: 'Reentrancy', content: 'ref content' });

        const roles = store.list({ type: 'role' });
        expect(roles).toHaveLength(1);
        expect(roles[0].name).toBe('Hunter');
    });

    it('filters by language', () => {
        store.create({ type: 'role', language: 'solidity', name: 'Sol Hunter', content: 'sol' });
        store.create({ type: 'role', language: 'rust-solana', name: 'Rust Hunter', content: 'rust' });

        const solidity = store.list({ language: 'solidity' });
        expect(solidity).toHaveLength(1);
        expect(solidity[0].name).toBe('Sol Hunter');
    });

    it('filters by tags (ANY match)', () => {
        store.create({ type: 'reference', name: 'Reentrancy', content: 'r', tags: ['reentrancy', 'external-calls'] });
        store.create({ type: 'reference', name: 'Access Control', content: 'a', tags: ['access-control'] });
        store.create({ type: 'reference', name: 'Flash Loans', content: 'f', tags: ['flash-loans', 'reentrancy'] });

        const results = store.list({ tags: ['reentrancy'] });
        expect(results).toHaveLength(2);
        expect(results.map(r => r.name).sort()).toEqual(['Flash Loans', 'Reentrancy']);
    });

    it('filters by search term (name match)', () => {
        store.create({ type: 'role', name: 'Hunter', content: 'hunter role' });
        store.create({ type: 'role', name: 'Cartographer', content: 'carto role' });

        const results = store.list({ search: 'hunt' });
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('Hunter');
    });

    it('combines multiple filters', () => {
        store.create({ type: 'role', language: 'solidity', name: 'Hunter', content: 'h', tags: ['audit'] });
        store.create({ type: 'role', language: 'rust-solana', name: 'Rust Hunter', content: 'rh', tags: ['audit'] });
        store.create({ type: 'primer', language: 'solidity', name: 'Lending', content: 'l', tags: ['defi'] });

        const results = store.list({ type: 'role', language: 'solidity' });
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('Hunter');
    });

    // ========================================================================
    // UPDATE
    // ========================================================================

    it('updates content and increments version', () => {
        const created = store.create({ type: 'role', name: 'Hunter', content: 'v1' });
        expect(created.version).toBe(1);

        const updated = store.update(created.id, { content: 'v2 improved content' });
        expect(updated).not.toBeNull();
        expect(updated!.content).toBe('v2 improved content');
        expect(updated!.version).toBe(2);
        expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('updates tags only, preserving content', () => {
        const created = store.create({ type: 'role', name: 'Hunter', content: 'original content', tags: ['old'] });

        const updated = store.update(created.id, { tags: ['new', 'tags'] });
        expect(updated!.content).toBe('original content');
        expect(updated!.tags).toEqual(['new', 'tags']);
        expect(updated!.version).toBe(2);
    });

    it('returns null when updating non-existent resource', () => {
        const result = store.update('nonexistent-id', { content: 'new' });
        expect(result).toBeNull();
    });

    // ========================================================================
    // DELETE
    // ========================================================================

    it('deletes an existing resource', () => {
        store.create({ type: 'role', name: 'Hunter', content: 'to delete' });
        expect(store.delete('role-any-hunter')).toBe(true);
        expect(store.get('role-any-hunter')).toBeNull();
        expect(store.count()).toBe(0);
    });

    it('returns false when deleting non-existent resource', () => {
        expect(store.delete('nonexistent-id')).toBe(false);
    });

    // ========================================================================
    // UPSERT
    // ========================================================================

    it('upserts a new resource (create path)', () => {
        const resource = store.upsert({ type: 'role', name: 'Hunter', content: 'v1' });
        expect(resource.version).toBe(1);
        expect(store.count()).toBe(1);
    });

    it('upserts an existing resource (update path)', () => {
        store.upsert({ type: 'role', name: 'Hunter', content: 'v1' });
        const resource = store.upsert({ type: 'role', name: 'Hunter', content: 'v2' });
        expect(resource.version).toBe(2);
        expect(resource.content).toBe('v2');
        expect(store.count()).toBe(1);
    });

    // ========================================================================
    // ID GENERATION
    // ========================================================================

    it('generates deterministic IDs from type, language, and name', () => {
        const id1 = store.generateId('role', 'solidity', 'Hunter');
        const id2 = store.generateId('role', 'solidity', 'Hunter');
        expect(id1).toBe(id2);
        expect(id1).toBe('role-solidity-hunter');
    });

    it('generates different IDs for different types with same name', () => {
        const id1 = store.generateId('role', 'solidity', 'Hunter');
        const id2 = store.generateId('primer', 'solidity', 'Hunter');
        expect(id1).not.toBe(id2);
    });

    it('slugifies names with special characters', () => {
        const id = store.generateId('reference', 'any', 'Access Control & Authorization');
        expect(id).toBe('reference-any-access-control-authorization');
    });

    it('handles ALLCAPS names', () => {
        const id = store.generateId('reference', 'any', 'CHEATSHEET');
        expect(id).toBe('reference-any-cheatsheet');
    });

    // ========================================================================
    // PERSISTENCE
    // ========================================================================

    it('persists data across shutdown and reinitialize', async () => {
        store.create({ type: 'role', name: 'Hunter', content: 'persistent content', tags: ['test'] });
        expect(store.count()).toBe(1);

        await store.shutdown();

        // Reinitialize from the same path
        const store2 = new ResourceStore(tmpDir);
        await store2.initialize();

        expect(store2.count()).toBe(1);
        const resource = store2.get('role-any-hunter');
        expect(resource).not.toBeNull();
        expect(resource!.content).toBe('persistent content');
        expect(resource!.tags).toEqual(['test']);

        await store2.shutdown();

        // Reassign for afterEach cleanup
        store = new ResourceStore(tmpDir);
        await store.initialize();
    });
});
