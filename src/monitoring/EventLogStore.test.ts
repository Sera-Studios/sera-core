/**
 * @fileoverview Unit tests for EventLogStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventLogStore } from './EventLogStore';

describe('EventLogStore', () => {
    let tmpDir: string;
    let store: EventLogStore;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-eventlog-test-'));
        store = new EventLogStore(tmpDir);
        await store.initialize();
    });

    afterEach(async () => {
        await store.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('log() inserts event with timestamp', () => {
        store.log('server_start', { port: 9800 });

        const events = store.query();
        expect(events).toHaveLength(1);
        expect(events[0].eventType).toBe('server_start');
        expect(events[0].timestamp).toBeDefined();
        expect(events[0].detail).toEqual({ port: 9800 });
    });

    it('log() records source IP when provided', () => {
        store.log('auth_success', { keyId: 'test-key' }, '192.168.1.1');

        const events = store.query();
        expect(events[0].sourceIp).toBe('192.168.1.1');
    });

    it('query() filters by eventType', () => {
        store.log('server_start');
        store.log('auth_success', { keyId: 'k1' });
        store.log('auth_failure', { reason: 'invalid key' });
        store.log('auth_success', { keyId: 'k2' });

        const authEvents = store.query({ eventType: 'auth_success' });
        expect(authEvents).toHaveLength(2);
        expect(authEvents.every(e => e.eventType === 'auth_success')).toBe(true);
    });

    it('query() filters by since timestamp', () => {
        store.log('server_start');

        // Create events with known ordering
        const cutoff = new Date().toISOString();

        store.log('auth_success', { keyId: 'after-cutoff' });

        const events = store.query({ since: cutoff });
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events.every(e => e.timestamp >= cutoff)).toBe(true);
    });

    it('query() respects limit', () => {
        store.log('server_start');
        store.log('auth_success');
        store.log('auth_failure');
        store.log('error');

        const events = store.query({ limit: 2 });
        expect(events).toHaveLength(2);
    });

    it('roundtrip: initialize, log, shutdown, re-initialize, query', async () => {
        store.log('server_start', { version: '0.1.0' });
        store.log('auth_success', { keyId: 'test' });
        await store.shutdown();

        // Re-open
        const store2 = new EventLogStore(tmpDir);
        await store2.initialize();

        const events = store2.query();
        expect(events).toHaveLength(2);
        expect(events[0].eventType).toBe('auth_success'); // DESC order
        expect(events[1].eventType).toBe('server_start');

        await store2.shutdown();

        // Prevent double-shutdown in afterEach
        store = new EventLogStore(tmpDir);
        await store.initialize();
    });

    it('log() without detail stores null detail', () => {
        store.log('server_stop');

        const events = store.query();
        expect(events[0].detail).toBeUndefined();
    });
});
