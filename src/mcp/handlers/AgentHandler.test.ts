/**
 * @fileoverview Unit tests for AgentHandler
 */

import { describe, it, expect } from 'vitest';
import { AgentHandler } from './AgentHandler';
import { AgentRegistrationStore } from '../../agents/AgentRegistrationStore';
import { HandlerContext } from '@sera/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeStore(): AgentRegistrationStore {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-ah-test-'));
    const store = new AgentRegistrationStore(tmpDir);
    // Clean up on process exit
    process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
    return store;
}

const mockCtx: HandlerContext = {
    auditSlug: 'test',
    sessionId: 'sess-1',
    agentType: 'hunter',
    workspacePath: '/tmp',
    db: { write: async () => {}, query: async () => [], sql: async () => [], delete: async () => 0 },
    bridge: { emit: () => {}, broadcastStorageUpdate: () => {} },
};

describe('AgentHandler', () => {
    it('throws for unknown tool name', async () => {
        const store = makeStore();
        const handler = new AgentHandler(store);
        await expect(
            handler.handleToolCall('nonexistent_tool', {}, mockCtx)
        ).rejects.toThrow('Unknown agent tool: nonexistent_tool');
    });

    it('lists registrations with role filter', async () => {
        const store = makeStore();
        store.register({
            id: 'h1', name: 'Hunter', version: '1.0', description: 'Find vulns',
            roles: ['hunter' as any], execution: { type: 'subprocess', command: 'node' },
            interface: { inputs: [], outputs: [] }, defaultTimeout: 30000,
        } as any);

        const handler = new AgentHandler(store);
        const result = await handler.handleToolCall('list_agent_registrations', { role: 'hunter' }, mockCtx) as any;
        expect(result.total).toBe(1);
        expect(result.registrations[0].id).toBe('h1');
    });
});
