/**
 * @fileoverview Unit tests for EventBridge
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBridge } from './EventBridge';

/** Create a mock WebSocket with a send spy and configurable readyState */
function createMockWs(readyState = 1 /* OPEN */): any {
    return {
        readyState,
        send: vi.fn(),
    };
}

describe('EventBridge', () => {
    let bridge: EventBridge;

    beforeEach(() => {
        bridge = new EventBridge();
    });

    describe('subscribe and broadcast', () => {
        it('delivers storage updates to subscribed clients', () => {
            const ws = createMockWs();
            bridge.subscribe(ws, 'client-1', 'audit-a', ['*']);

            bridge.broadcastStorageUpdate('mcp-source', 'audit-a', 'notepad', 'issues', 'insert', { id: '1' });

            expect(ws.send).toHaveBeenCalledOnce();
            const payload = JSON.parse(ws.send.mock.calls[0][0]);
            expect(payload.type).toBe('storage:update');
            expect(payload.appletId).toBe('notepad');
            expect(payload.table).toBe('issues');
            expect(payload.action).toBe('insert');
        });

        it('excludes the source client from broadcast', () => {
            const ws = createMockWs();
            bridge.subscribe(ws, 'client-1', 'audit-a', ['*']);

            bridge.broadcastStorageUpdate('client-1', 'audit-a', 'notepad', 'issues', 'insert', { id: '1' });

            expect(ws.send).not.toHaveBeenCalled();
        });

        it('isolates broadcasts by audit slug', () => {
            const wsA = createMockWs();
            const wsB = createMockWs();
            bridge.subscribe(wsA, 'client-a', 'audit-a', ['*']);
            bridge.subscribe(wsB, 'client-b', 'audit-b', ['*']);

            bridge.broadcastStorageUpdate('source', 'audit-a', 'notepad', 'issues', 'insert', { id: '1' });

            expect(wsA.send).toHaveBeenCalledOnce();
            expect(wsB.send).not.toHaveBeenCalled();
        });
    });

    describe('pattern matching', () => {
        it('matches exact table patterns', () => {
            const ws = createMockWs();
            bridge.subscribe(ws, 'client-1', 'audit-a', ['notepad:issues']);

            bridge.broadcastStorageUpdate('source', 'audit-a', 'notepad', 'issues', 'insert', { id: '1' });
            expect(ws.send).toHaveBeenCalledOnce();

            ws.send.mockClear();
            bridge.broadcastStorageUpdate('source', 'audit-a', 'notepad', 'comments', 'insert', { id: '2' });
            expect(ws.send).not.toHaveBeenCalled();
        });

        it('matches wildcard patterns', () => {
            const ws = createMockWs();
            bridge.subscribe(ws, 'client-1', 'audit-a', ['notepad:*']);

            bridge.broadcastStorageUpdate('source', 'audit-a', 'notepad', 'issues', 'insert', { id: '1' });
            expect(ws.send).toHaveBeenCalledOnce();

            ws.send.mockClear();
            bridge.broadcastStorageUpdate('source', 'audit-a', 'notepad', 'comments', 'insert', { id: '2' });
            expect(ws.send).toHaveBeenCalledOnce();
        });

        it('skips closed connections', () => {
            const ws = createMockWs(3 /* CLOSED */);
            bridge.subscribe(ws, 'client-1', 'audit-a', ['*']);

            bridge.broadcastStorageUpdate('source', 'audit-a', 'notepad', 'issues', 'insert', { id: '1' });
            expect(ws.send).not.toHaveBeenCalled();
        });
    });

    describe('unsubscribeClient', () => {
        it('removes client subscriptions', () => {
            const ws = createMockWs();
            bridge.subscribe(ws, 'client-1', 'audit-a', ['*']);

            bridge.unsubscribeClient('client-1');
            bridge.broadcastStorageUpdate('source', 'audit-a', 'notepad', 'issues', 'insert', { id: '1' });

            expect(ws.send).not.toHaveBeenCalled();
        });
    });

    describe('broadcastBridgeEvent', () => {
        it('delivers bridge events to audit clients', () => {
            const ws = createMockWs();
            bridge.subscribe(ws, 'client-1', 'audit-a', ['*']);

            bridge.broadcastBridgeEvent({
                auditSlug: 'audit-a',
                source: 'system',
                event: 'test-event',
                data: { msg: 'hello' },
                timestamp: new Date().toISOString(),
            });

            expect(ws.send).toHaveBeenCalledOnce();
            const payload = JSON.parse(ws.send.mock.calls[0][0]);
            expect(payload.type).toBe('bridge:event');
            expect(payload.event).toBe('test-event');
        });

        it('excludes the source from bridge events', () => {
            const ws = createMockWs();
            bridge.subscribe(ws, 'client-1', 'audit-a', ['*']);

            bridge.broadcastBridgeEvent({
                auditSlug: 'audit-a',
                source: 'client-1',
                event: 'test-event',
                data: {},
                timestamp: new Date().toISOString(),
            });

            expect(ws.send).not.toHaveBeenCalled();
        });
    });

    describe('client counts', () => {
        it('counts clients per audit', () => {
            bridge.subscribe(createMockWs(), 'c1', 'audit-a', ['*']);
            bridge.subscribe(createMockWs(), 'c2', 'audit-a', ['*']);
            bridge.subscribe(createMockWs(), 'c3', 'audit-b', ['*']);

            expect(bridge.getClientCount('audit-a')).toBe(2);
            expect(bridge.getClientCount('audit-b')).toBe(1);
            expect(bridge.getTotalClientCount()).toBe(3);
        });
    });
});
