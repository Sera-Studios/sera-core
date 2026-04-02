/**
 * @fileoverview Extended WebSocket API tests
 *
 * Tests message handlers not covered by websocket.test.ts:
 * audit-selected, audit-create, storage:query, storage:delete,
 * close/error handling, and edge cases.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createTestnet, TestnetInstance } from '../TestHarness';

function connectWs(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
        ws.once('message', (data) => {
            clearTimeout(timer);
            resolve(JSON.parse(data.toString()));
        });
    });
}

function sendWs(ws: WebSocket, msg: any): void {
    ws.send(JSON.stringify(msg));
}

/**
 * Connect a WS client to a known audit workspace and wait for 'connected' response.
 */
async function connectToAudit(
    ws: WebSocket,
    clientId: string,
    workspacePath: string
): Promise<void> {
    sendWs(ws, {
        type: 'connect',
        clientId,
        clientType: 'test',
        workspacePath,
    });
    const response = await waitForMessage(ws);
    expect(response.type).toBe('connected');
}

describe('WebSocket API (extended)', () => {
    let testnet: TestnetInstance;
    const openSockets: WebSocket[] = [];

    afterEach(async () => {
        for (const ws of openSockets) {
            if (ws.readyState === WebSocket.OPEN) { ws.close(); }
        }
        openSockets.length = 0;
        if (testnet) { await testnet.teardown(); }
    });

    // ========================================================================
    // audit-selected
    // ========================================================================

    describe('audit-selected', () => {
        it('selects an existing audit', async () => {
            testnet = await createTestnet({ auditSlug: 'ws-select-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws);

            // Connect without workspace path (triggers select-audit)
            sendWs(ws, {
                type: 'connect',
                clientId: 'select-client',
                clientType: 'test',
            });
            const selectMsg = await waitForMessage(ws);
            expect(selectMsg.type).toBe('select-audit');

            // Select the audit
            sendWs(ws, {
                type: 'audit-selected',
                slug: 'ws-select-test',
                workspacePath: '/tmp/workspace',
            });
            const connected = await waitForMessage(ws);
            expect(connected.type).toBe('connected');
            expect(connected.auditSlug).toBe('ws-select-test');
        });

        it('returns error for nonexistent audit', async () => {
            testnet = await createTestnet({ auditSlug: 'ws-err-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws);

            // Connect first
            sendWs(ws, {
                type: 'connect',
                clientId: 'err-client',
                clientType: 'test',
            });
            await waitForMessage(ws); // select-audit

            // Select nonexistent audit
            sendWs(ws, {
                type: 'audit-selected',
                slug: 'nonexistent-audit',
            });
            const error = await waitForMessage(ws);
            expect(error.type).toBe('error');
            expect(error.error).toContain('not found');
        });
    });

    // ========================================================================
    // audit-create
    // ========================================================================

    describe('audit-create', () => {
        it('creates a new audit', async () => {
            testnet = await createTestnet({ auditSlug: 'ws-create-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws);

            // Connect
            sendWs(ws, {
                type: 'connect',
                clientId: 'create-client',
                clientType: 'test',
            });
            await waitForMessage(ws);

            // Create new audit
            sendWs(ws, {
                type: 'audit-create',
                name: 'New Test Audit',
                workspacePath: '/tmp/new-workspace',
            });
            const response = await waitForMessage(ws);
            expect(response.type).toBe('connected');
            expect(response.auditSlug).toBe('new-test-audit');
            expect(response.auditName).toBe('New Test Audit');
        });

        it('returns error for duplicate audit', async () => {
            testnet = await createTestnet({ auditSlug: 'duplicate-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws);

            sendWs(ws, {
                type: 'connect',
                clientId: 'dup-client',
                clientType: 'test',
            });
            await waitForMessage(ws);

            // Try to create audit with same slug as existing
            sendWs(ws, {
                type: 'audit-create',
                name: 'Duplicate Test',
                workspacePath: '/tmp/dup',
            });
            const response = await waitForMessage(ws);
            expect(response.type).toBe('error');
            expect(response.error).toContain('already exists');
        });
    });

    // ========================================================================
    // storage:query
    // ========================================================================

    describe('storage:query', () => {
        it('queries table data', async () => {
            testnet = await createTestnet({ auditSlug: 'ws-query-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws);

            const workspacePath = testnet.seraHome + '/workspace';
            await connectToAudit(ws, 'query-client', workspacePath);

            // Register a table
            sendWs(ws, {
                type: 'storage:register',
                appletId: 'test',
                tables: [{
                    name: 'items',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'value', type: 'TEXT' },
                    ],
                }],
            });
            await waitForMessage(ws); // storage:registered

            // Write data
            sendWs(ws, {
                type: 'storage:write',
                appletId: 'test',
                table: 'items',
                data: { id: '1', value: 'hello' },
            });
            await waitForMessage(ws); // storage:written

            // Query with appletId/table
            sendWs(ws, {
                type: 'storage:query',
                nonce: 'q1',
                appletId: 'test',
                table: 'items',
            });
            const result = await waitForMessage(ws);
            expect(result.type).toBe('storage:result');
            expect(result.nonce).toBe('q1');
            expect(result.results.length).toBeGreaterThan(0);
        });

        it('queries with raw SQL', async () => {
            testnet = await createTestnet({ auditSlug: 'ws-sql-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws);

            const workspacePath = testnet.seraHome + '/workspace';
            await connectToAudit(ws, 'sql-client', workspacePath);

            // Register and write
            sendWs(ws, {
                type: 'storage:register',
                appletId: 'test',
                tables: [{
                    name: 'items',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'value', type: 'TEXT' },
                    ],
                }],
            });
            await waitForMessage(ws);

            sendWs(ws, {
                type: 'storage:write',
                appletId: 'test',
                table: 'items',
                data: { id: '1', value: 'world' },
            });
            await waitForMessage(ws);

            // Query with raw SQL
            sendWs(ws, {
                type: 'storage:query',
                nonce: 'sq1',
                sql: 'SELECT * FROM test_items WHERE id = ?',
                params: ['1'],
            });
            const result = await waitForMessage(ws);
            expect(result.type).toBe('storage:result');
            expect(result.results.length).toBe(1);
            expect(result.results[0].value).toBe('world');
        });
    });

    // ========================================================================
    // storage:delete
    // ========================================================================

    describe('storage:delete', () => {
        it('deletes data and broadcasts to subscribers', async () => {
            testnet = await createTestnet({ auditSlug: 'ws-delete-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws);

            const workspacePath = testnet.seraHome + '/workspace';
            await connectToAudit(ws, 'delete-client', workspacePath);

            // Register table
            sendWs(ws, {
                type: 'storage:register',
                appletId: 'test',
                tables: [{
                    name: 'items',
                    version: '1',
                    fields: [
                        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                        { name: 'value', type: 'TEXT' },
                    ],
                }],
            });
            await waitForMessage(ws); // registered

            // Write data
            sendWs(ws, {
                type: 'storage:write',
                appletId: 'test',
                table: 'items',
                data: { id: 'del-1', value: 'to-delete' },
            });
            await waitForMessage(ws); // written

            // Connect observer
            const ws2 = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws2);
            await connectToAudit(ws2, 'delete-observer', workspacePath);
            sendWs(ws2, { type: 'subscribe', tables: ['*'] });
            await new Promise(r => setTimeout(r, 100));

            // Delete data
            sendWs(ws, {
                type: 'storage:delete',
                nonce: 'd1',
                appletId: 'test',
                table: 'items',
                key: { id: 'del-1' },
            });

            const deleteResponse = await waitForMessage(ws);
            expect(deleteResponse.type).toBe('storage:deleted');
            expect(deleteResponse.nonce).toBe('d1');
            expect(deleteResponse.count).toBe(1);

            // Observer should receive broadcast
            const broadcast = await waitForMessage(ws2, 5000);
            expect(broadcast.type).toBe('storage:update');
            expect(broadcast.action).toBe('delete');
        });
    });

    // ========================================================================
    // Error handling
    // ========================================================================

    describe('error handling', () => {
        it('returns error for malformed JSON', async () => {
            testnet = await createTestnet({ auditSlug: 'ws-error-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
            openSockets.push(ws);

            // Send invalid JSON
            ws.send('not valid json');

            const response = await waitForMessage(ws);
            expect(response.type).toBe('error');
        });
    });

    // ========================================================================
    // Client disconnect
    // ========================================================================

    describe('client lifecycle', () => {
        it('cleans up on disconnect', async () => {
            testnet = await createTestnet({ auditSlug: 'ws-disconnect-test' });
            const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);

            const workspacePath = testnet.seraHome + '/workspace';
            await connectToAudit(ws, 'disconnect-client', workspacePath);

            // Close connection
            ws.close();

            // Wait for close to process
            await new Promise(r => setTimeout(r, 100));

            // Server should have removed the client - no errors, no crash
        });
    });
});
