/**
 * @fileoverview API key authentication middleware for sera-core
 * @module sera-core/api/authMiddleware
 *
 * Provides Bearer token authentication for both the Express REST API
 * and the raw HTTP MCP server. Keys follow the format sk-sera-{32 hex chars}
 * and are stored as SHA-256 hashes in the CredentialStore.
 */

import * as crypto from 'node:crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { SeraConfig } from '../config';
import { CredentialStore } from '../credentials/CredentialStore';

const API_KEY_PROVIDER = 'sera-auth';

export interface AuthValidationResult {
    valid: boolean;
    keyId?: string;
    statusCode?: number;
    error?: string;
}

/**
 * Generate a new API key in the format sk-sera-{32 hex chars}
 */
export function generateApiKey(): string {
    const hex = crypto.randomBytes(16).toString('hex');
    return `sk-sera-${hex}`;
}

/**
 * Hash an API key using SHA-256 (hex digest)
 */
export function hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Check if a remote address is localhost
 */
export function isLocalhost(remoteAddress: string): boolean {
    return remoteAddress === '127.0.0.1'
        || remoteAddress === '::1'
        || remoteAddress === '::ffff:127.0.0.1';
}

/**
 * Validate a Bearer token against the credential store.
 * Shared logic used by both Express middleware and MCPServer.
 */
export function validateBearerAuth(params: {
    authHeader?: string;
    config: SeraConfig;
    credentialStore: CredentialStore;
    remoteAddress: string;
}): AuthValidationResult {
    const { authHeader, config, credentialStore, remoteAddress } = params;

    // Auth disabled - allow all
    if (!config.auth?.enabled) {
        return { valid: true };
    }

    // Localhost bypass
    if (config.auth.skipLocalhost && isLocalhost(remoteAddress)) {
        return { valid: true };
    }

    // Check Authorization header
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return {
            valid: false,
            statusCode: 401,
            error: 'Missing API key. Use: Authorization: Bearer sk-sera-...',
        };
    }

    const key = authHeader.slice(7);
    const keyHash = hashApiKey(key);
    const credential = credentialStore.findByProviderAndValue(API_KEY_PROVIDER, keyHash);

    if (!credential) {
        return {
            valid: false,
            statusCode: 403,
            error: 'Invalid API key',
        };
    }

    // Update last used timestamp (fire-and-forget)
    credentialStore.updateField(credential.id, 'lastUsedAt', new Date().toISOString());

    return { valid: true, keyId: credential.id };
}

/**
 * Create Express middleware for API key authentication.
 * Skips auth for health endpoints.
 */
export function createAuthMiddleware(
    config: SeraConfig,
    credentialStore: CredentialStore,
): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        // Health endpoint is always accessible
        if (req.path === '/api/health') {
            next();
            return;
        }

        const result = validateBearerAuth({
            authHeader: req.headers.authorization,
            config,
            credentialStore,
            remoteAddress: req.ip || req.socket.remoteAddress || '',
        });

        if (!result.valid) {
            res.status(result.statusCode || 401).json({ error: result.error });
            return;
        }

        next();
    };
}
