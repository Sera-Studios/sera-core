/**
 * @fileoverview Configuration loading and defaults for sera-core
 * @module sera-core/config
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SeraConfig {
    ports: {
        client: number;
        mcp: number;
    };
    logging: {
        level: 'debug' | 'info' | 'warn' | 'error';
        file: string;
        maxSize: string;
        maxFiles: number;
    };
    database: {
        flushIntervalMs: number;
        backupOnMigrate: boolean;
    };
}

const SERA_HOME = path.join(os.homedir(), '.sera');

const DEFAULT_CONFIG: SeraConfig = {
    ports: {
        client: 9800,
        mcp: 9877,
    },
    logging: {
        level: 'info',
        file: path.join(SERA_HOME, 'logs', 'sera-core.log'),
        maxSize: '10m',
        maxFiles: 5,
    },
    database: {
        flushIntervalMs: 30000,
        backupOnMigrate: true,
    },
};

/**
 * Load configuration from ~/.sera/config.json, merged with defaults
 * @returns Merged configuration
 */
export function loadConfig(): SeraConfig {
    const configPath = path.join(SERA_HOME, 'config.json');

    if (fs.existsSync(configPath)) {
        try {
            const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return deepMerge(DEFAULT_CONFIG, userConfig);
        } catch (err) {
            console.warn(`[sera-core] Failed to load config from ${configPath}: ${err}`);
        }
    }

    return { ...DEFAULT_CONFIG };
}

/**
 * Ensure the ~/.sera directory structure exists
 */
export function ensureSeraHome(): void {
    const dirs = [
        SERA_HOME,
        path.join(SERA_HOME, 'audits'),
        path.join(SERA_HOME, 'logs'),
    ];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

/**
 * Get the sera home directory path
 */
export function getSeraHome(): string {
    return SERA_HOME;
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
