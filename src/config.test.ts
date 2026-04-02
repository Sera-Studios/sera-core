/**
 * @fileoverview Unit tests for sera-core config module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, ensureSeraHome, getSeraHome, patchConfig } from './config';

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

        it('default config has auth disabled with localhost bypass', () => {
            const config = loadConfig(tmpDir);
            expect(config.auth).toEqual({ enabled: false, skipLocalhost: true });
        });

        it('user config merges auth overrides correctly', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'config.json'),
                JSON.stringify({ auth: { enabled: true, skipLocalhost: false } }),
            );
            const config = loadConfig(tmpDir);
            expect(config.auth).toEqual({ enabled: true, skipLocalhost: false });
        });

        it('partial auth config merges with defaults', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'config.json'),
                JSON.stringify({ auth: { enabled: true } }),
            );
            const config = loadConfig(tmpDir);
            expect(config.auth!.enabled).toBe(true);
            expect(config.auth!.skipLocalhost).toBe(true);
        });

        it('default config has logging.format = text', () => {
            const config = loadConfig(tmpDir);
            expect(config.logging.format).toBe('text');
        });

        it('default config has monitoring.alerts.enabled = false', () => {
            const config = loadConfig(tmpDir);
            expect(config.monitoring?.alerts?.enabled).toBe(false);
            expect(config.monitoring?.alerts?.thresholds?.errorRatePerMinute).toBe(10);
            expect(config.monitoring?.alerts?.thresholds?.avgLatencyMs).toBe(5000);
            expect(config.monitoring?.alerts?.thresholds?.consecutiveFailedHealthChecks).toBe(3);
        });

        it('user config merges monitoring overrides correctly', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'config.json'),
                JSON.stringify({
                    monitoring: {
                        alerts: {
                            enabled: true,
                            webhookUrl: 'https://hooks.slack.com/test',
                            thresholds: { errorRatePerMinute: 5 },
                        },
                    },
                }),
            );
            const config = loadConfig(tmpDir);
            expect(config.monitoring?.alerts?.enabled).toBe(true);
            expect(config.monitoring?.alerts?.webhookUrl).toBe('https://hooks.slack.com/test');
            expect(config.monitoring?.alerts?.thresholds?.errorRatePerMinute).toBe(5);
            // Default thresholds preserved
            expect(config.monitoring?.alerts?.thresholds?.avgLatencyMs).toBe(5000);
        });
    });

    describe('patchConfig', () => {
        it('writes config when no file exists', () => {
            patchConfig(tmpDir, { auth: { enabled: true, skipLocalhost: true } });
            const configPath = path.join(tmpDir, 'config.json');
            expect(fs.existsSync(configPath)).toBe(true);
            const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            expect(written.auth.enabled).toBe(true);
        });

        it('preserves existing fields when patching', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'config.json'),
                JSON.stringify({ ports: { client: 9999 } }),
            );
            patchConfig(tmpDir, { auth: { enabled: true, skipLocalhost: false } });
            const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
            expect(written.ports.client).toBe(9999);
            expect(written.auth.enabled).toBe(true);
        });

        it('merges nested auth fields', () => {
            fs.writeFileSync(
                path.join(tmpDir, 'config.json'),
                JSON.stringify({ auth: { enabled: false, skipLocalhost: true } }),
            );
            patchConfig(tmpDir, { auth: { enabled: true } });
            const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
            expect(written.auth.enabled).toBe(true);
            expect(written.auth.skipLocalhost).toBe(true);
        });

        it('does nothing when patch is undefined', () => {
            patchConfig(tmpDir, undefined);
            expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(false);
        });
    });
});
