/**
 * @fileoverview Unit tests for sera-core config module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, ensureSeraHome, getSeraHome } from './config';

describe('config', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-config-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('getSeraHome', () => {
        it('returns override when provided', () => {
            expect(getSeraHome('/custom/path')).toBe('/custom/path');
        });

        it('returns default ~/.sera when no override', () => {
            const result = getSeraHome();
            expect(result).toBe(path.join(os.homedir(), '.sera'));
        });

        it('respects SERA_HOME env var', () => {
            const original = process.env.SERA_HOME;
            try {
                process.env.SERA_HOME = '/env/sera';
                expect(getSeraHome()).toBe('/env/sera');
            } finally {
                if (original !== undefined) {
                    process.env.SERA_HOME = original;
                } else {
                    delete process.env.SERA_HOME;
                }
            }
        });

        it('override takes precedence over env var', () => {
            const original = process.env.SERA_HOME;
            try {
                process.env.SERA_HOME = '/env/sera';
                expect(getSeraHome('/override')).toBe('/override');
            } finally {
                if (original !== undefined) {
                    process.env.SERA_HOME = original;
                } else {
                    delete process.env.SERA_HOME;
                }
            }
        });
    });

    describe('ensureSeraHome', () => {
        it('creates directory structure', () => {
            const seraHome = path.join(tmpDir, 'sera');
            ensureSeraHome(seraHome);

            expect(fs.existsSync(seraHome)).toBe(true);
            expect(fs.existsSync(path.join(seraHome, 'audits'))).toBe(true);
            expect(fs.existsSync(path.join(seraHome, 'logs'))).toBe(true);
        });

        it('is idempotent', () => {
            const seraHome = path.join(tmpDir, 'sera');
            ensureSeraHome(seraHome);
            ensureSeraHome(seraHome);

            expect(fs.existsSync(seraHome)).toBe(true);
        });
    });

    describe('loadConfig', () => {
        it('returns defaults when no config file exists', () => {
            const config = loadConfig(tmpDir);

            expect(config.ports.client).toBe(9800);
            expect(config.ports.mcp).toBe(9877);
            expect(config.database.flushIntervalMs).toBe(30000);
            expect(config.logging.level).toBe('info');
        });

        it('merges user config with defaults', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'config.json'),
                JSON.stringify({ ports: { client: 1234 } })
            );

            const config = loadConfig(tmpDir);

            // Overridden value
            expect(config.ports.client).toBe(1234);
            // Default values preserved
            expect(config.ports.mcp).toBe(9877);
            expect(config.database.flushIntervalMs).toBe(30000);
        });

        it('handles malformed config file gracefully', () => {
            fs.writeFileSync(path.join(tmpDir, 'config.json'), 'not json');

            const config = loadConfig(tmpDir);
            expect(config.ports.client).toBe(9800);
        });

        it('resolves log file path relative to sera home', () => {
            const config = loadConfig(tmpDir);
            expect(config.logging.file).toContain(tmpDir);
        });
    });
});
