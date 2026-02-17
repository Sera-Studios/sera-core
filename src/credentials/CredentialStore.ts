/**
 * @fileoverview Credential storage for API keys
 * @module sera-core/credentials/CredentialStore
 *
 * Stores API keys in ~/.sera/credentials.json with file permissions
 * restricted to owner-only (0o600). Keys are stored in plaintext -
 * file permissions are the security boundary.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSeraHome } from '../config';

export interface StoredCredential {
    id: string;
    provider: string;
    name: string;
    apiKey: string;
    createdAt: string;
}

export interface MaskedCredential {
    id: string;
    provider: string;
    name: string;
    maskedKey: string;
    createdAt: string;
}

/**
 * Manages API credentials stored in ~/.sera/credentials.json
 */
export class CredentialStore {
    private filePath: string;
    private credentials: StoredCredential[] = [];

    constructor() {
        this.filePath = path.join(getSeraHome(), 'credentials.json');
        this.load();
    }

    /** Load credentials from disk */
    load(): void {
        if (fs.existsSync(this.filePath)) {
            try {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                this.credentials = JSON.parse(raw);
            } catch {
                console.warn('[CredentialStore] Failed to load credentials, starting fresh');
                this.credentials = [];
            }
        }
    }

    /** Save a new credential. Returns the stored credential. */
    save(provider: string, name: string, apiKey: string): StoredCredential {
        const id = `${provider}-${Date.now().toString(36)}`;
        const credential: StoredCredential = {
            id,
            provider,
            name,
            apiKey,
            createdAt: new Date().toISOString(),
        };
        this.credentials.push(credential);
        this.flush();
        return credential;
    }

    /** Remove a credential by ID */
    remove(id: string): boolean {
        const before = this.credentials.length;
        this.credentials = this.credentials.filter(c => c.id !== id);
        if (this.credentials.length < before) {
            this.flush();
            return true;
        }
        return false;
    }

    /** Get all credentials for a provider (full keys - for internal use) */
    getByProvider(provider: string): StoredCredential[] {
        return this.credentials.filter(c => c.provider === provider);
    }

    /** Get a single credential by ID (full key - for internal use) */
    get(id: string): StoredCredential | null {
        return this.credentials.find(c => c.id === id) ?? null;
    }

    /** List all credentials with masked keys (safe for API responses) */
    list(provider?: string): MaskedCredential[] {
        const filtered = provider
            ? this.credentials.filter(c => c.provider === provider)
            : this.credentials;
        return filtered.map(c => ({
            id: c.id,
            provider: c.provider,
            name: c.name,
            maskedKey: maskKey(c.apiKey),
            createdAt: c.createdAt,
        }));
    }

    /** Write credentials to disk with restricted permissions */
    private flush(): void {
        const data = JSON.stringify(this.credentials, null, 2);
        fs.writeFileSync(this.filePath, data, { encoding: 'utf-8', mode: 0o600 });
    }
}

/** Mask an API key, showing only the last 4 characters */
function maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return '****' + key.slice(-4);
}
