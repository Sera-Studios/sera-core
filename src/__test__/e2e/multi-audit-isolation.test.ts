/**
 * @fileoverview E2E test: Cross-audit isolation
 *
 * Verifies that data submitted to one audit does not leak into another,
 * and that WebSocket clients on different audits are properly isolated.
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

describe('Multi-Audit Isolation E2E', () => {
    let testnet: TestnetInstance;
    const openSockets: WebSocket[] = [];

    afterEach(async () => {
        for (const ws of openSockets) {
            if (ws.readyState === WebSocket.OPEN) { ws.close(); }
        }
        openSockets.length = 0;
        if (testnet) { await testnet.teardown(); }
    });

    function parse(result: any): any {
        return JSON.parse(result.content[0].text);
    }

    it('findings submitted to audit-A do not appear in audit-B', async () => {
        testnet = await createTestnet({ auditSlug: 'audit-a', auditName: 'Audit A' });

        // Create a second audit
        await testnet.createAudit('audit-b', 'Audit B', testnet.seraHome + '/workspace-b');

        // Agent on audit-a
        const agentA = new McpTestClient(`${testnet.mcpUrl}/audit-a`);
        await agentA.initialize();
        const regA = parse(await agentA.callTool('register_agent', {
            agent_name: 'hunter',
            agent_version: '1.0.0',
        }));

        // Agent on audit-b
        const agentB = new McpTestClient(`${testnet.mcpUrl}/audit-b`);
        await agentB.initialize();
        const regB = parse(await agentB.callTool('register_agent', {
            agent_name: 'hunter',
            agent_version: '1.0.0',
        }));

        // Submit finding to audit-a
        const issueA = await agentA.callTool('submit_finding', {
            agent_id: regA.agent_id,
            file: 'contracts/VaultA.sol',
            start_line: 10,
            end_line: 20,
            title: 'Bug in Audit A',
            severity: 'high',
            description: 'This belongs to audit A only',
            recommendation: 'Fix it in A',
        });
        expect(issueA.isError).not.toBe(true);

        // Submit finding to audit-b
        const issueB = await agentB.callTool('submit_finding', {
            agent_id: regB.agent_id,
            file: 'contracts/VaultB.sol',
            start_line: 30,
            end_line: 40,
            title: 'Bug in Audit B',
            severity: 'medium',
            description: 'This belongs to audit B only',
            recommendation: 'Fix it in B',
        });
        expect(issueB.isError).not.toBe(true);

        // Query audit-a DB via debug tools
        const debugA = new McpTestClient(`${testnet.debugMcpUrl}/audit-a`);
        await debugA.initialize();
        const notesA = parse(await debugA.callTool('debug_query_audit', {
            sql: 'SELECT * FROM notepad_notes',
        }));

        // Query audit-b DB
        const debugB = new McpTestClient(`${testnet.debugMcpUrl}/audit-b`);
        await debugB.initialize();
        const notesB = parse(await debugB.callTool('debug_query_audit', {
            sql: 'SELECT * FROM notepad_notes',
        }));

        // Audit A should only have its own finding
        expect(notesA).toHaveLength(1);
        expect(notesA[0].title).toBe('Bug in Audit A');

        // Audit B should only have its own finding
        expect(notesB).toHaveLength(1);
        expect(notesB[0].title).toBe('Bug in Audit B');
    });

    it('WebSocket clients on different audits are isolated', async () => {
        testnet = await createTestnet({ auditSlug: 'ws-audit-a', auditName: 'WS Audit A' });
        await testnet.createAudit('ws-audit-b', 'WS Audit B', testnet.seraHome + '/workspace-b');

        const wsUrl = `ws://localhost:${testnet.clientPort}`;

        // Connect client to audit-a
        const wsA = await connectWs(wsUrl);
        openSockets.push(wsA);
        sendWs(wsA, {
            type: 'connect',
            clientId: 'client-a',
            clientType: 'test',
            workspacePath: testnet.seraHome + '/workspace',
        });
        const connA = await waitForMessage(wsA);
        expect(connA.type).toBe('connected');
        expect(connA.auditSlug).toBe('ws-audit-a');

        sendWs(wsA, { type: 'subscribe', tables: ['*'] });

        // Connect client to audit-b
        const wsB = await connectWs(wsUrl);
        openSockets.push(wsB);
        sendWs(wsB, {
            type: 'connect',
            clientId: 'client-b',
            clientType: 'test',
            workspacePath: testnet.seraHome + '/workspace-b',
        });
        const connB = await waitForMessage(wsB);
        expect(connB.type).toBe('connected');
        expect(connB.auditSlug).toBe('ws-audit-b');

        sendWs(wsB, { type: 'subscribe', tables: ['*'] });

        // Register tables on audit-a
        sendWs(wsA, {
            type: 'storage:register',
            appletId: 'test-applet',
            tables: [{
                name: 'items',
                version: '1',
                fields: [
                    { name: 'id', type: 'TEXT', primaryKey: true, required: true },
                    { name: 'value', type: 'TEXT', required: false },
                ],
            }],
        });
        await waitForMessage(wsA); // storage:registered

        await new Promise(r => setTimeout(r, 100));

        // Write data to audit-a
        sendWs(wsA, {
            type: 'storage:write',
            appletId: 'test-applet',
            table: 'items',
            data: { id: '1', value: 'audit-a-data' },
        });

        // Client A gets write confirmation
        const writeConfirm = await waitForMessage(wsA);
        expect(writeConfirm.type).toBe('storage:written');

        // Client B should NOT receive any broadcast (different audit)
        const noMessage = await Promise.race([
            waitForMessage(wsB, 1000).then(() => 'received').catch(() => 'timeout'),
            new Promise(r => setTimeout(r, 1000)).then(() => 'timeout'),
        ]);
        expect(noMessage).toBe('timeout');
    });
});
