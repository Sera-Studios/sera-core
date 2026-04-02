/**
 * @fileoverview Unit tests for DebugHandler
 */

import { describe, it, expect } from 'vitest';
import { DebugHandler } from './DebugHandler';
import { LogBuffer } from '../../debug/LogBuffer';
import { EventBridge } from '../../events/EventBridge';
import { HandlerContext } from '@sera/types';

const mockCtx: HandlerContext = {
    auditSlug: 'test',
    sessionId: 'sess-1',
    agentType: 'hunter',
    workspacePath: '/tmp',
    db: { write: async () => {}, query: async () => [], sql: async () => [], delete: async () => 0 },
    bridge: { emit: () => {}, broadcastStorageUpdate: () => {} },
};

function makeHandler() {
    const logBuffer = new LogBuffer(100);
    const bridge = new EventBridge();
    bridge.enableRecording();
    const sessions = [
        { sessionId: 's1', agentType: 'hunter', agentId: null, auditSlug: 'test', lastHeartbeat: new Date().toISOString() },
    ];
    return new DebugHandler(logBuffer, bridge, () => sessions);
}

describe('DebugHandler', () => {
    it('throws for unknown tool name', async () => {
        const handler = makeHandler();
        await expect(
            handler.handleToolCall('nonexistent', {}, mockCtx)
        ).rejects.toThrow('Unknown debug tool: nonexistent');
    });

    it('debug_get_event_log filters by type and applies limit', async () => {
        const logBuffer = new LogBuffer(100);
        const bridge = new EventBridge();
        bridge.enableRecording();

        // Record some events through broadcastStorageUpdate
        bridge.broadcastStorageUpdate('src', 'test', 'app', 'items', 'insert', { a: 1 });
        bridge.broadcastBridgeEvent({ event: 'client:connected', source: 'test', auditSlug: 'test', data: { b: 2 }, timestamp: new Date().toISOString() });
        bridge.broadcastStorageUpdate('src', 'test', 'app', 'items', 'update', { c: 3 });

        const handler = new DebugHandler(logBuffer, bridge, () => []);

        // Filter by type
        const filtered = await handler.handleToolCall('debug_get_event_log', { type: 'storage-update' }, mockCtx) as any[];
        expect(filtered).toHaveLength(2);
        expect(filtered.every((e: any) => e.type === 'storage-update')).toBe(true);

        // Apply limit
        const limited = await handler.handleToolCall('debug_get_event_log', { limit: 1 }, mockCtx) as any[];
        expect(limited).toHaveLength(1);
    });

    it('debug_get_logs filters by level', async () => {
        const logBuffer = new LogBuffer(100);
        logBuffer.capture('info', 'info msg');
        logBuffer.capture('error', 'error msg');
        logBuffer.capture('info', 'info msg 2');

        const bridge = new EventBridge();
        const handler = new DebugHandler(logBuffer, bridge, () => []);

        const errorLogs = await handler.handleToolCall('debug_get_logs', { level: 'error' }, mockCtx) as any[];
        expect(errorLogs).toHaveLength(1);
        expect(errorLogs[0].message).toBe('error msg');
    });

    it('debug_list_sessions returns session data', async () => {
        const handler = makeHandler();
        const result = await handler.handleToolCall('debug_list_sessions', {}, mockCtx) as any[];
        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('s1');
    });
});
