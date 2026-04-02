/**
 * @fileoverview Unit tests for API key authentication middleware
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SeraConfig } from '../config';
import { CredentialStore } from '../credentials/CredentialStore';
import {
    generateApiKey,
    hashApiKey,
    isLocalhost,
    validateBearerAuth,
} from './authMiddleware';

// ============================================================================
// HELPERS
// ============================================================================

function makeConfig(overrides?: Partial<SeraConfig['auth']>): SeraConfig {
    return {
        ports: { client: 9800, mcp: 9877 },
        logging: { level: 'info', format: 'text', file: '/tmp/test.log', maxSize: '10m', maxFiles: 5 },
        database: { flushIntervalMs: 30000, backupOnMigrate: true },
        auth: { enabled: false, skipLocalhost: true, ...overrides },
    };
}

// ============================================================================
// generateApiKey
// ============================================================================

describe('generateApiKey', () => {
    it('produces correct format (sk-sera- prefix, 38 chars total)', () => {
        const key = generateApiKey();
        expect(key).toMatch(/^sk-sera-[0-9a-f]{32}$/);
        expect(key.length).toBe(40); // "sk-sera-" (8) + 32 hex chars
    });

    it('produces unique keys', () => {
        const keys = new Set(Array.from({ length: 10 }, () => generateApiKey()));
        expect(keys.size).toBe(10);
    });
});

// ============================================================================
// hashApiKey
// ============================================================================

describe('hashApiKey', () => {
    it('is deterministic', () => {
        const key = 'sk-sera-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
        expect(hashApiKey(key)).toBe(hashApiKey(key));
    });

    it('returns 64-char hex string (SHA-256)', () => {
        const hash = hashApiKey('test-key');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('different keys produce different hashes', () => {
        expect(hashApiKey('key-1')).not.toBe(hashApiKey('key-2'));
    });
});

// ============================================================================
// isLocalhost
// ============================================================================

describe('isLocalhost', () => {
    it('detects 127.0.0.1', () => {
        expect(isLocalhost('127.0.0.1')).toBe(true);
    });

    it('detects ::1', () => {
        expect(isLocalhost('::1')).toBe(true);
    });

    it('detects ::ffff:127.0.0.1', () => {
        expect(isLocalhost('::ffff:127.0.0.1')).toBe(true);
    });

    it('rejects other IPs', () => {
        expect(isLocalhost('192.168.1.1')).toBe(false);
        expect(isLocalhost('10.0.0.1')).toBe(false);
        expect(isLocalhost('')).toBe(false);
    });
});

// ============================================================================
// validateBearerAuth
// ============================================================================

describe('validateBearerAuth', () => {
    let tmpDir: string;
    let credentialStore: CredentialStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-auth-test-'));
        credentialStore = new CredentialStore(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('auth disabled - always valid', () => {
        const config = makeConfig({ enabled: false });
        const result = validateBearerAuth({
            authHeader: undefined,
            config,
            credentialStore,
            remoteAddress: '10.0.0.1',
        });
        expect(result.valid).toBe(true);
    });

    it('localhost bypass when skipLocalhost=true', () => {
        const config = makeConfig({ enabled: true, skipLocalhost: true });
        const result = validateBearerAuth({
            authHeader: undefined,
            config,
            credentialStore,
            remoteAddress: '127.0.0.1',
        });
        expect(result.valid).toBe(true);
    });

    it('no bypass when skipLocalhost=false', () => {
        const config = makeConfig({ enabled: true, skipLocalhost: false });
        const result = validateBearerAuth({
            authHeader: undefined,
            config,
            credentialStore,
            remoteAddress: '127.0.0.1',
        });
        expect(result.valid).toBe(false);
        expect(result.statusCode).toBe(401);
    });

    it('missing header returns 401', () => {
        const config = makeConfig({ enabled: true, skipLocalhost: false });
        const result = validateBearerAuth({
            authHeader: undefined,
            config,
            credentialStore,
            remoteAddress: '10.0.0.1',
        });
        expect(result.valid).toBe(false);
        expect(result.statusCode).toBe(401);
        expect(result.error).toContain('Missing API key');
    });

    it('non-Bearer header returns 401', () => {
        const config = makeConfig({ enabled: true, skipLocalhost: false });
        const result = validateBearerAuth({
            authHeader: 'Basic abc123',
            config,
            credentialStore,
            remoteAddress: '10.0.0.1',
        });
        expect(result.valid).toBe(false);
        expect(result.statusCode).toBe(401);
    });

    it('invalid key returns 403', () => {
        const config = makeConfig({ enabled: true, skipLocalhost: false });
        const result = validateBearerAuth({
            authHeader: 'Bearer sk-sera-invalid',
            config,
            credentialStore,
            remoteAddress: '10.0.0.1',
        });
        expect(result.valid).toBe(false);
        expect(result.statusCode).toBe(403);
        expect(result.error).toContain('Invalid API key');
    });

    it('valid key returns valid with keyId', () => {
        const config = makeConfig({ enabled: true, skipLocalhost: false });
        const key = generateApiKey();
        const hash = hashApiKey(key);
        credentialStore.saveWithId('dev-laptop', 'sera-auth', 'Dev Laptop', hash);

        const result = validateBearerAuth({
            authHeader: `Bearer ${key}`,
            config,
            credentialStore,
            remoteAddress: '10.0.0.1',
        });
        expect(result.valid).toBe(true);
        expect(result.keyId).toBe('dev-laptop');
    });

    it('updates lastUsedAt on successful auth', () => {
        const config = makeConfig({ enabled: true, skipLocalhost: false });
        const key = generateApiKey();
        const hash = hashApiKey(key);
        credentialStore.saveWithId('dev-laptop', 'sera-auth', 'Dev Laptop', hash);

        validateBearerAuth({
            authHeader: `Bearer ${key}`,
            config,
            credentialStore,
            remoteAddress: '10.0.0.1',
        });

        const cred = credentialStore.get('dev-laptop');
        expect(cred!.lastUsedAt).toBeDefined();
    });
});
