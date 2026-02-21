/**
 * @fileoverview Integration tests for WebSocket API
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

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

describe('WebSocket API', () => {
    let testnet: TestnetInstance;
    const openSockets: WebSocket[] = [];

    afterEach(async () => {
        for (const ws of openSockets) {
            if (ws.readyState === WebSocket.OPEN) { ws.close(); }
        }
        openSockets.length = 0;
        if (testnet) { await testnet.teardown(); }
    });

    it('accepts connection and responds to connect message', async () => {
        testnet = await createTestnet({ auditSlug: 'ws-test' });
        const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
        openSockets.push(ws);

        // The connect message sends the workspace path. Since the workspace
        // was registered via createAudit, the server should respond with
        // 'connected' (known workspace) or 'select-audit' (unknown workspace).
        // Our testnet creates the audit but the workspace may not be registered.
        sendWs(ws, {
            type: 'connect',
            clientId: 'test-client',
            clientType: 'test',
        });

        const response = await waitForMessage(ws);
        // Without a workspace path, the server sends select-audit
        expect(['connected', 'select-audit']).toContain(response.type);
    });

    it('responds with connected when workspace is registered', async () => {
        testnet = await createTestnet({ auditSlug: 'ws-conn-test' });
        const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
        openSockets.push(ws);

        // Send connect with the registered workspace path
        const workspacePath = testnet.seraHome + '/workspace';
        sendWs(ws, {
            type: 'connect',
            clientId: 'test-client',
            clientType: 'test',
            workspacePath,
        });

        const response = await waitForMessage(ws);
        expect(response.type).toBe('connected');
        expect(response.auditSlug).toBe('ws-conn-test');
    });

    it('delivers storage updates to subscribed clients', async () => {
        testnet = await createTestnet({ auditSlug: 'ws-sub-test' });

        // Connect WS client with known workspace
        const ws = await connectWs(`ws://localhost:${testnet.clientPort}`);
        openSockets.push(ws);

        const workspacePath = testnet.seraHome + '/workspace';
        sendWs(ws, {
            type: 'connect',
            clientId: 'ws-client',
            clientType: 'test',
            workspacePath,
        });
        const connResponse = await waitForMessage(ws);
        expect(connResponse.type).toBe('connected');

        // Select the audit so we're subscribed to it
        sendWs(ws, { type: 'subscribe', tables: ['*'] });

        // Use the WS storage:write path directly since MCP writes may not
        // broadcast to WS clients (different bridge source path)
        // First register tables
        sendWs(ws, {
            type: 'storage:register',
            appletId: 'test-applet',
            tables: [{
                name: 'items',
                version: '1',
                fields: [
                    { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                    { name: 'value', type: 'TEXT' },
                ],
            }],
        });

        // Wait for registration response
        const regResponse = await waitForMessage(ws);
        expect(regResponse.type).toBe('storage:registered');

        // Now connect a second WS client to observe the broadcast
        const ws2 = await connectWs(`ws://localhost:${testnet.clientPort}`);
        openSockets.push(ws2);
        sendWs(ws2, {
            type: 'connect',
            clientId: 'ws-observer',
            clientType: 'test',
            workspacePath,
        });
        await waitForMessage(ws2); // connected

        sendWs(ws2, { type: 'subscribe', tables: ['*'] });

        // Small delay to ensure subscribe is processed before write
        await new Promise(r => setTimeout(r, 100));

        // Write data from first client - second client should receive update
        sendWs(ws, {
            type: 'storage:write',
            appletId: 'test-applet',
            table: 'items',
            data: { id: '1', value: 'hello' },
        });

        // First client gets the write confirmation
        const writeResponse = await waitForMessage(ws);
        expect(writeResponse.type).toBe('storage:written');

        // Second client gets the broadcast
        const update = await waitForMessage(ws2, 5000);
        expect(update.type).toBe('storage:update');
        expect(update.appletId).toBe('test-applet');
        expect(update.table).toBe('items');
    });
});
