/**
 * @fileoverview Unit tests for SchemaHandler
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SchemaHandler } from './SchemaHandler';
import { ResourceStore } from '../../resources/ResourceStore';
import { HandlerContext } from '@sera/types';

const mockCtx: HandlerContext = {
    auditSlug: 'test',
    sessionId: 'sess-1',
    agentType: 'hunter',
    workspacePath: '/tmp',
    db: { write: async () => {}, query: async () => [], sql: async () => [], delete: async () => 0 },
    bridge: { emit: () => {}, broadcastStorageUpdate: () => {} },
};

describe('SchemaHandler', () => {
    let tmpDir: string;
    let store: ResourceStore;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-schema-h-test-'));
        store = new ResourceStore(tmpDir);
        await store.initialize();
    });

    afterEach(async () => {
        await store.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws for unknown tool name', async () => {
        const handler = new SchemaHandler(store);
        await expect(
            handler.handleToolCall('nonexistent', {}, mockCtx)
        ).rejects.toThrow('Unknown schema tool: nonexistent');
    });

    it('throws when schema resource contains invalid JSON', async () => {
        // Create a resource with invalid JSON content
        store.create({
            type: 'schema' as any,
            language: 'any' as any,
            name: 'Bad Schema',
            content: 'not valid json{{{',
            tags: [],
        });

        const handler = new SchemaHandler(store);
        const schemaId = store.generateId('schema', 'any', 'Bad Schema');

        await expect(
            handler.handleToolCall('validate_against_schema', {
                schema_id: schemaId,
                data: { title: 'test' },
            }, mockCtx)
        ).rejects.toThrow('contains invalid JSON');
    });

    it('throws when resource type is not schema', async () => {
        store.create({
            type: 'role' as any,
            language: 'solidity' as any,
            name: 'Hunter Role',
            content: 'Some role content',
            tags: [],
        });

        const handler = new SchemaHandler(store);
        const roleId = store.generateId('role', 'solidity', 'Hunter Role');

        await expect(
            handler.handleToolCall('validate_against_schema', {
                schema_id: roleId,
                data: {},
            }, mockCtx)
        ).rejects.toThrow('is not a schema');
    });

    it('throws when schema not found', async () => {
        const handler = new SchemaHandler(store);
        await expect(
            handler.handleToolCall('validate_against_schema', {
                schema_id: 'nonexistent-id',
                data: {},
            }, mockCtx)
        ).rejects.toThrow('Schema not found');
    });

    it('validates data against a valid schema', async () => {
        const schema = {
            type: 'object',
            required: ['title'],
            properties: {
                title: { type: 'string' },
            },
        };

        store.create({
            type: 'schema' as any,
            language: 'any' as any,
            name: 'Test Schema',
            content: JSON.stringify(schema),
            tags: [],
        });

        const handler = new SchemaHandler(store);
        const schemaId = store.generateId('schema', 'any', 'Test Schema');

        const result = await handler.handleToolCall('validate_against_schema', {
            schema_id: schemaId,
            data: { title: 'Hello' },
        }, mockCtx) as any;

        expect(result.valid).toBe(true);
        expect(result.schema_id).toBe(schemaId);
        expect(result.schema_name).toBe('Test Schema');
    });
});
