/**
 * @fileoverview Unit tests for StorageEngine
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageEngine } from './StorageEngine';

describe('StorageEngine', () => {
    let tmpDir: string;
    let dbPath: string;
    let engine: StorageEngine;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-se-test-'));
        dbPath = path.join(tmpDir, 'test.db');
        engine = new StorageEngine(dbPath, 60000);
        await engine.initialize();
    });

    afterEach(async () => {
        await engine.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('registerTables', () => {
        it('creates a new table', () => {
            const results = engine.registerTables('test', [
                {
                    name: 'items',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'value', type: 'TEXT', required: false },
                    ],
                },
            ]);

            expect(results).toHaveLength(1);
            expect(results[0].table).toBe('items');
            expect(results[0].exists).toBe(false);
            expect(results[0].data).toBeNull();
        });

        it('returns existing data when table already registered', () => {
            const schema = {
                name: 'items',
                version: '1',
                fields: [
                    { name: 'id', type: 'TEXT' as const, primaryKey: true, required: true },
                    { name: 'value', type: 'TEXT' as const, required: false },
                ],
            };

            engine.registerTables('test', [schema]);
            engine.write('test', 'items', { id: '1', value: 'hello' });

            // Force SQL flush before re-registering (registerTables loads from DB)
            engine.sql('SELECT 1');

            const results = engine.registerTables('test', [schema]);
            expect(results[0].exists).toBe(true);
            expect(results[0].data).toHaveLength(1);
            expect(results[0].data![0].value).toBe('hello');
        });

        it('recreates table on version upgrade', () => {
            engine.registerTables('test', [
                {
                    name: 'items',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                    ],
                },
            ]);
            engine.write('test', 'items', { id: '1' });

            const results = engine.registerTables('test', [
                {
                    name: 'items',
                    version: '2',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'extra', type: 'TEXT', required: false },
                    ],
                },
            ]);

            expect(results[0].exists).toBe(false);
            expect(results[0].data).toBeNull();
            // Old data is gone
            expect(engine.query('test', 'items')).toHaveLength(0);
        });
    });

    describe('write and query', () => {
        beforeEach(() => {
            engine.registerTables('app', [
                {
                    name: 'notes',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'title', type: 'TEXT', required: true },
                        { name: 'body', type: 'TEXT', required: false },
                    ],
                },
            ]);
        });

        it('writes and queries records', () => {
            engine.write('app', 'notes', { id: '1', title: 'First', body: 'Hello' });
            engine.write('app', 'notes', { id: '2', title: 'Second', body: 'World' });

            const all = engine.query('app', 'notes');
            expect(all).toHaveLength(2);
        });

        it('upserts by primary key', () => {
            engine.write('app', 'notes', { id: '1', title: 'Original', body: 'v1' });
            engine.write('app', 'notes', { id: '1', title: 'Updated', body: 'v2' });

            const all = engine.query('app', 'notes');
            expect(all).toHaveLength(1);
            expect(all[0].title).toBe('Updated');
            expect(all[0].body).toBe('v2');
        });

        it('filters by field values', () => {
            engine.write('app', 'notes', { id: '1', title: 'Alpha', body: 'a' });
            engine.write('app', 'notes', { id: '2', title: 'Beta', body: 'b' });

            const results = engine.query('app', 'notes', { title: 'Alpha' });
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('1');
        });

        it('returns empty array for no matches', () => {
            const results = engine.query('app', 'notes', { title: 'nonexistent' });
            expect(results).toHaveLength(0);
        });
    });

    describe('delete', () => {
        beforeEach(() => {
            engine.registerTables('app', [
                {
                    name: 'items',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'tag', type: 'TEXT', required: false },
                    ],
                },
            ]);
        });

        it('deletes matching records', () => {
            engine.write('app', 'items', { id: '1', tag: 'a' });
            engine.write('app', 'items', { id: '2', tag: 'b' });
            engine.write('app', 'items', { id: '3', tag: 'a' });

            const deleted = engine.delete('app', 'items', { tag: 'a' });
            expect(deleted).toBe(2);
            expect(engine.query('app', 'items')).toHaveLength(1);
        });

        it('returns 0 when nothing matches', () => {
            engine.write('app', 'items', { id: '1', tag: 'a' });
            const deleted = engine.delete('app', 'items', { tag: 'z' });
            expect(deleted).toBe(0);
        });
    });

    describe('sql', () => {
        it('executes raw SQL queries', () => {
            engine.registerTables('app', [
                {
                    name: 'data',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
                        { name: 'score', type: 'REAL', required: false },
                    ],
                },
            ]);

            engine.write('app', 'data', { id: 1, score: 9.5 });
            engine.write('app', 'data', { id: 2, score: 7.2 });

            const results = engine.sql('SELECT * FROM "app_data" WHERE score > ?', [8.0]);
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe(1);
        });
    });

    describe('validation', () => {
        it('throws on missing required fields', () => {
            engine.registerTables('app', [
                {
                    name: 'strict',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'name', type: 'TEXT', required: true },
                    ],
                },
            ]);

            expect(() => engine.write('app', 'strict', { id: '1' }))
                .toThrow('Missing required field: name');
        });

        it('throws on unregistered table', () => {
            expect(() => engine.write('app', 'nonexistent', { id: '1' }))
                .toThrow('not registered');
        });
    });

    describe('persistence', () => {
        it('saves to disk and reloads', async () => {
            engine.registerTables('app', [
                {
                    name: 'persist',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'value', type: 'TEXT', required: false },
                    ],
                },
            ]);

            engine.write('app', 'persist', { id: '1', value: 'saved' });
            await engine.shutdown();

            // Reload from disk
            const engine2 = new StorageEngine(dbPath, 60000);
            await engine2.initialize();

            const results = engine2.registerTables('app', [
                {
                    name: 'persist',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'value', type: 'TEXT', required: false },
                    ],
                },
            ]);

            expect(results[0].exists).toBe(true);
            expect(results[0].data).toHaveLength(1);
            expect(results[0].data![0].value).toBe('saved');

            await engine2.shutdown();

            // Create a fresh engine for afterEach to shutdown
            engine = new StorageEngine(dbPath, 60000);
            await engine.initialize();
        });
    });
});
