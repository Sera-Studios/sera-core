/**
 * @fileoverview Encrypted credential storage for API keys
 * @module sera-core/credentials/CredentialStore
 *
 * Stores API keys in ~/.sera/credentials.vault encrypted with AES-256-GCM.
 * The vault key is stored at ~/.sera/vault.key with 0o600 permissions.
 *
 * Binary vault format: [IV:12 bytes][authTag:16 bytes][ciphertext]
 *
 * On first load, if an old plaintext credentials.json exists it is
 * automatically migrated to the encrypted vault and the plaintext file
 * is deleted.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { getSeraHome } from '../config';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

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
 * Manages API credentials stored in an AES-256-GCM encrypted vault.
 */
export class CredentialStore {
    private vaultPath: string;
    private vaultKeyPath: string;
    private legacyPath: string;
    private credentials: StoredCredential[] = [];

    constructor(seraHome?: string) {
        const home = getSeraHome(seraHome);
        this.vaultPath = path.join(home, 'credentials.vault');
        this.vaultKeyPath = path.join(home, 'vault.key');
        this.legacyPath = path.join(home, 'credentials.json');
        this.load();
    }

    /** Load credentials from encrypted vault (or migrate from plaintext) */
    load(): void {
        // Migration: old plaintext credentials.json -> encrypted vault
        if (fs.existsSync(this.legacyPath)) {
            try {
                const raw = fs.readFileSync(this.legacyPath, 'utf-8');
                this.credentials = JSON.parse(raw);
                this.flush();
                fs.unlinkSync(this.legacyPath);
                return;
            } catch {
                console.warn('[CredentialStore] Failed to migrate legacy credentials.json');
            }
        }

        // Load from encrypted vault
        if (fs.existsSync(this.vaultPath)) {
            try {
                const encrypted = fs.readFileSync(this.vaultPath);
                const json = this.decrypt(encrypted);
                this.credentials = JSON.parse(json);
            } catch {
                console.warn('[CredentialStore] Failed to decrypt vault, starting fresh');
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

    /** Encrypt and write credentials to disk */
    private flush(): void {
        const json = JSON.stringify(this.credentials, null, 2);
        const encrypted = this.encrypt(json);
        fs.writeFileSync(this.vaultPath, encrypted, { mode: 0o600 });
    }

    /** Get or create the 32-byte vault key */
    private getOrCreateVaultKey(): Buffer {
        if (fs.existsSync(this.vaultKeyPath)) {
            return fs.readFileSync(this.vaultKeyPath);
        }
        const key = crypto.randomBytes(KEY_LENGTH);
        // Ensure parent directory exists
        const dir = path.dirname(this.vaultKeyPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.vaultKeyPath, key, { mode: 0o600 });
        return key;
    }

    /** Encrypt plaintext to binary: [IV:12][authTag:16][ciphertext] */
    private encrypt(plaintext: string): Buffer {
        const key = this.getOrCreateVaultKey();
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return Buffer.concat([iv, authTag, encrypted]);
    }

    /** Decrypt binary vault data back to plaintext */
    private decrypt(data: Buffer): string {
        const key = this.getOrCreateVaultKey();
        const iv = data.subarray(0, IV_LENGTH);
        const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(ciphertext) + decipher.final('utf-8');
    }
}

/** Mask an API key, showing only the last 4 characters */
function maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return '****' + key.slice(-4);
}
