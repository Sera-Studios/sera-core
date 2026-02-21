/**
 * @fileoverview Unit tests for LogBuffer
 */

import { describe, it, expect } from 'vitest';
import { LogBuffer } from './LogBuffer';

describe('LogBuffer', () => {
    it('captures and retrieves entries', () => {
        const buf = new LogBuffer();
        buf.capture('info', 'hello');
        buf.capture('warn', 'caution');

        const entries = buf.getEntries();
        expect(entries).toHaveLength(2);
        expect(entries[0].level).toBe('info');
        expect(entries[0].message).toBe('hello');
        expect(entries[1].level).toBe('warn');
    });

    it('includes timestamp and optional meta', () => {
        const buf = new LogBuffer();
        buf.capture('error', 'fail', { code: 500 });

        const entry = buf.getEntries()[0];
        expect(entry.timestamp).toBeDefined();
        expect(entry.meta).toEqual({ code: 500 });
    });

    it('limits entries to maxEntries', () => {
        const buf = new LogBuffer(3);
        buf.capture('info', 'a');
        buf.capture('info', 'b');
        buf.capture('info', 'c');
        buf.capture('info', 'd');

        const entries = buf.getEntries();
        expect(entries).toHaveLength(3);
        // Oldest entry ('a') should be dropped
        expect(entries[0].message).toBe('b');
        expect(entries[2].message).toBe('d');
    });

    it('getEntries with limit returns most recent', () => {
        const buf = new LogBuffer();
        buf.capture('info', 'a');
        buf.capture('info', 'b');
        buf.capture('info', 'c');

        const entries = buf.getEntries(2);
        expect(entries).toHaveLength(2);
        expect(entries[0].message).toBe('b');
        expect(entries[1].message).toBe('c');
    });

    it('clear removes all entries', () => {
        const buf = new LogBuffer();
        buf.capture('info', 'a');
        buf.capture('info', 'b');
        expect(buf.size).toBe(2);

        buf.clear();
        expect(buf.size).toBe(0);
        expect(buf.getEntries()).toHaveLength(0);
    });

    it('returns copy of entries (not a reference)', () => {
        const buf = new LogBuffer();
        buf.capture('info', 'a');

        const entries = buf.getEntries();
        entries.push({ level: 'info', message: 'injected', timestamp: '' });

        expect(buf.getEntries()).toHaveLength(1);
    });
});
