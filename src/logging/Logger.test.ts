/**
 * @fileoverview Unit tests for structured Logger
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'stream';
import {
    Logger,
    configureLogging,
    createLogger,
    setCaptureCallback,
    setOutputStream,
    resetOutputStream,
    LogEntry,
} from './Logger';

/** Writable stream that captures output to a string buffer */
function createCapture(): { stream: Writable; getOutput: () => string } {
    let buffer = '';
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            buffer += chunk.toString();
            callback();
        },
    });
    return { stream, getOutput: () => buffer };
}

describe('Logger', () => {
    let stdout: ReturnType<typeof createCapture>;
    let stderr: ReturnType<typeof createCapture>;

    beforeEach(() => {
        stdout = createCapture();
        stderr = createCapture();
        setOutputStream(stdout.stream, stderr.stream);
        configureLogging({ format: 'text', level: 'info' });
        setCaptureCallback(undefined);
    });

    afterEach(() => {
        resetOutputStream();
    });

    // ====================================================================
    // JSON FORMAT
    // ====================================================================

    describe('JSON format', () => {
        it('outputs valid JSON with all fields', () => {
            const log = new Logger('mcp', { format: 'json', level: 'info' });
            log.info('Tool call', { tool: 'submit_finding', durationMs: 45 });

            const output = stdout.getOutput();
            const parsed = JSON.parse(output.trim());
            expect(parsed.timestamp).toBeDefined();
            expect(parsed.level).toBe('info');
            expect(parsed.module).toBe('mcp');
            expect(parsed.message).toBe('Tool call');
            expect(parsed.data.tool).toBe('submit_finding');
            expect(parsed.data.durationMs).toBe(45);
        });

        it('omits data field when no data provided', () => {
            const log = new Logger('core', { format: 'json', level: 'info' });
            log.info('Starting server');

            const parsed = JSON.parse(stdout.getOutput().trim());
            expect(parsed.data).toBeUndefined();
        });

        it('error-level goes to stdout in JSON mode', () => {
            const log = new Logger('core', { format: 'json', level: 'info' });
            log.error('Something failed');

            expect(stdout.getOutput()).toContain('Something failed');
            expect(stderr.getOutput()).toBe('');
        });
    });

    // ====================================================================
    // TEXT FORMAT
    // ====================================================================

    describe('Text format', () => {
        it('outputs human-readable line with timestamp, module, level, and data', () => {
            const log = new Logger('mcp', { format: 'text', level: 'info' });
            log.info('Tool call', { tool: 'submit_finding', session: 'abc123' });

            const output = stdout.getOutput();
            // Should contain time pattern HH:MM:SS.mmm
            expect(output).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
            expect(output).toContain('[mcp]');
            expect(output).toContain('INFO');
            expect(output).toContain('Tool call');
            expect(output).toContain('tool=submit_finding');
            expect(output).toContain('session=abc123');
        });

        it('error-level goes to stderr in text mode', () => {
            const log = new Logger('core', { format: 'text', level: 'info' });
            log.error('Something failed');

            expect(stderr.getOutput()).toContain('Something failed');
            expect(stderr.getOutput()).toContain('ERROR');
            expect(stdout.getOutput()).toBe('');
        });
    });

    // ====================================================================
    // LEVEL FILTERING
    // ====================================================================

    describe('Level filtering', () => {
        it('debug not output at info level', () => {
            const log = new Logger('test', { format: 'text', level: 'info' });
            log.debug('Debug message');

            expect(stdout.getOutput()).toBe('');
            expect(stderr.getOutput()).toBe('');
        });

        it('warn output at info level', () => {
            const log = new Logger('test', { format: 'text', level: 'info' });
            log.warn('Warning message');

            expect(stdout.getOutput()).toContain('Warning message');
        });

        it('info output at debug level', () => {
            const log = new Logger('test', { format: 'text', level: 'debug' });
            log.info('Info message');

            expect(stdout.getOutput()).toContain('Info message');
        });

        it('only error output at error level', () => {
            const log = new Logger('test', { format: 'text', level: 'error' });
            log.info('Info message');
            log.warn('Warn message');
            log.error('Error message');

            expect(stdout.getOutput()).toBe('');
            expect(stderr.getOutput()).toContain('Error message');
            expect(stderr.getOutput()).not.toContain('Info message');
        });
    });

    // ====================================================================
    // CHILD LOGGERS
    // ====================================================================

    describe('child()', () => {
        it('inherits options and uses new module name', () => {
            const parent = new Logger('sera-core', { format: 'json', level: 'info' });
            const child = parent.child('mcp');

            child.info('Child log');

            const parsed = JSON.parse(stdout.getOutput().trim());
            expect(parsed.module).toBe('mcp');
            expect(parsed.level).toBe('info');
        });

        it('inherits level filtering', () => {
            const parent = new Logger('sera-core', { format: 'text', level: 'warn' });
            const child = parent.child('mcp');

            child.info('Should not appear');
            child.warn('Should appear');

            expect(stdout.getOutput()).toContain('Should appear');
            expect(stdout.getOutput()).not.toContain('Should not appear');
        });
    });

    // ====================================================================
    // GLOBAL API
    // ====================================================================

    describe('configureLogging + createLogger', () => {
        it('configureLogging affects subsequently created loggers', () => {
            configureLogging({ format: 'json', level: 'debug' });
            const log = createLogger('test');

            log.debug('Debug message');

            const parsed = JSON.parse(stdout.getOutput().trim());
            expect(parsed.level).toBe('debug');
            expect(parsed.module).toBe('test');
        });
    });

    // ====================================================================
    // CAPTURE CALLBACK
    // ====================================================================

    describe('setCaptureCallback', () => {
        it('receives all log entries', () => {
            const captured: LogEntry[] = [];
            setCaptureCallback((entry) => captured.push(entry));

            const log = new Logger('test', { format: 'text', level: 'info' });
            log.info('First');
            log.warn('Second', { key: 'value' });

            expect(captured).toHaveLength(2);
            expect(captured[0].message).toBe('First');
            expect(captured[0].level).toBe('info');
            expect(captured[1].message).toBe('Second');
            expect(captured[1].data).toEqual({ key: 'value' });
        });

        it('does not capture filtered-out entries', () => {
            const captured: LogEntry[] = [];
            setCaptureCallback((entry) => captured.push(entry));

            const log = new Logger('test', { format: 'text', level: 'warn' });
            log.debug('Should not be captured');
            log.info('Should not be captured');
            log.warn('Should be captured');

            expect(captured).toHaveLength(1);
            expect(captured[0].level).toBe('warn');
        });
    });
});
