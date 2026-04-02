/**
 * @fileoverview Configuration loading and defaults for sera-core
 * @module sera-core/config
 *
 * All paths are derived from the sera home directory, which defaults to
 * ~/.sera but can be overridden per-call (for test isolation) or globally
 * via the SERA_HOME environment variable.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { createLogger } from './logging/Logger';

const log = createLogger('config');

export interface SeraConfig {
    ports: {
        client: number;
        mcp: number;
    };
    logging: {
        level: 'debug' | 'info' | 'warn' | 'error';
        format: 'json' | 'text';
        file: string;
        maxSize: string;
        maxFiles: number;
    };
    database: {
        flushIntervalMs: number;
        backupOnMigrate: boolean;
    };
    auth?: {
        enabled: boolean;
        skipLocalhost: boolean;
    };
    monitoring?: {
        alerts?: {
            enabled: boolean;
            webhookUrl?: string;
            thresholds?: {
                errorRatePerMinute?: number;
                avgLatencyMs?: number;
                consecutiveFailedHealthChecks?: number;
            };
        };
    };
}

const DEFAULT_SERA_HOME = path.join(os.homedir(), '.sera');

function resolveSeraHome(override?: string): string {
    return override || process.env.SERA_HOME || DEFAULT_SERA_HOME;
}

function buildDefaultConfig(seraHome: string): SeraConfig {
    return {
        ports: {
            client: 9800,
            mcp: 9877,
        },
        logging: {
            level: 'info',
            format: 'text',
            file: path.join(seraHome, 'logs', 'sera-core.log'),
            maxSize: '10m',
            maxFiles: 5,
        },
        database: {
            flushIntervalMs: 30000,
            backupOnMigrate: true,
        },
        auth: {
            enabled: false,
            skipLocalhost: true,
        },
        monitoring: {
            alerts: {
                enabled: false,
                thresholds: {
                    errorRatePerMinute: 10,
                    avgLatencyMs: 5000,
                    consecutiveFailedHealthChecks: 3,
                },
            },
        },
    };
}

/**
 * Load configuration, merged with defaults
 * @param seraHomeOverride - Use this directory instead of ~/.sera
 * @returns Merged configuration
 */
export function loadConfig(seraHomeOverride?: string): SeraConfig {
    const seraHome = resolveSeraHome(seraHomeOverride);
    const defaults = buildDefaultConfig(seraHome);
    const configPath = path.join(seraHome, 'config.json');

    if (fs.existsSync(configPath)) {
        try {
            const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return deepMerge(defaults, userConfig);
        } catch (err) {
            log.warn('Failed to load config', { configPath, error: String(err) });
        }
    }

    return { ...defaults };
}

/**
 * Ensure the sera home directory structure exists
 * @param seraHomeOverride - Use this directory instead of ~/.sera
 */
export function ensureSeraHome(seraHomeOverride?: string): void {
    const seraHome = resolveSeraHome(seraHomeOverride);
    const dirs = [
        seraHome,
        path.join(seraHome, 'audits'),
        path.join(seraHome, 'logs'),
    ];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

/**
 * Get the sera home directory path
 * @param override - Use this directory instead of ~/.sera
 */
export function getSeraHome(override?: string): string {
    return resolveSeraHome(override);
}

/**
 * Patch the config file with partial updates (read-modify-write)
 * @param seraHomeOverride - Use this directory instead of ~/.sera
 * @param patch - Partial config to merge into existing config file
 */
export function patchConfig(seraHomeOverride?: string, patch?: Record<string, unknown>): void {
    if (!patch) return;
    const seraHome = resolveSeraHome(seraHomeOverride);
    const configPath = path.join(seraHome, 'config.json');

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch {
            // Start fresh if config is corrupted
        }
    }

    const merged = deepMerge(existing, patch);
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
}

function deepMerge(target: any, source: any): any {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}
