/**
 * @fileoverview Unit tests for CredentialStore (encrypted vault)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CredentialStore } from './CredentialStore';

describe('CredentialStore', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-cred-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves and retrieves a credential', () => {
        const store = new CredentialStore(tmpDir);
        const cred = store.save('anthropic', 'My Key', 'sk-ant-abc123');

        expect(cred.id).toContain('anthropic');
        expect(cred.provider).toBe('anthropic');
        expect(cred.name).toBe('My Key');
        expect(cred.apiKey).toBe('sk-ant-abc123');

        const retrieved = store.get(cred.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.apiKey).toBe('sk-ant-abc123');
    });

    it('lists credentials with masked keys', () => {
        const store = new CredentialStore(tmpDir);
        store.save('anthropic', 'Key 1', 'sk-ant-abc123');
        store.save('openai', 'Key 2', 'sk-openai-xyz789');

        const all = store.list();
        expect(all).toHaveLength(2);
        expect(all[0].maskedKey).toBe('****c123');
        expect(all[1].maskedKey).toBe('****z789');
    });

    it('filters by provider', () => {
        const store = new CredentialStore(tmpDir);
        store.save('anthropic', 'A1', 'key1');
        store.save('openai', 'O1', 'key2');
        store.save('anthropic', 'A2', 'key3');

        const anthropicCreds = store.getByProvider('anthropic');
        expect(anthropicCreds).toHaveLength(2);

        const openaiList = store.list('openai');
        expect(openaiList).toHaveLength(1);
    });

    it('removes a credential', () => {
        const store = new CredentialStore(tmpDir);
        const cred = store.save('anthropic', 'Delete Me', 'key');

        expect(store.remove(cred.id)).toBe(true);
        expect(store.get(cred.id)).toBeNull();
        expect(store.remove(cred.id)).toBe(false);
    });

    it('persists to disk and reloads', () => {
        const store1 = new CredentialStore(tmpDir);
        store1.save('anthropic', 'Persistent', 'sk-persist');

        const store2 = new CredentialStore(tmpDir);
        const creds = store2.list();
        expect(creds).toHaveLength(1);
        expect(creds[0].name).toBe('Persistent');
    });

    it('handles missing vault file gracefully', () => {
        const store = new CredentialStore(tmpDir);
        expect(store.list()).toHaveLength(0);
    });

    it('masks short keys safely', () => {
        const store = new CredentialStore(tmpDir);
        store.save('test', 'Short', 'abc');

        const list = store.list();
        expect(list[0].maskedKey).toBe('****');
    });

    // --- Encryption-specific tests ---

    it('writes encrypted data to disk (not valid JSON)', () => {
        const store = new CredentialStore(tmpDir);
        store.save('anthropic', 'Encrypted', 'sk-secret');

        const vaultPath = path.join(tmpDir, 'credentials.vault');
        expect(fs.existsSync(vaultPath)).toBe(true);

        const raw = fs.readFileSync(vaultPath);
        // Encrypted binary should not parse as JSON
        expect(() => JSON.parse(raw.toString('utf-8'))).toThrow();
    });

    it('writes vault file with 0o600 permissions', () => {
        const store = new CredentialStore(tmpDir);
        store.save('test', 'Perms', 'key');

        const vaultPath = path.join(tmpDir, 'credentials.vault');
        const stat = fs.statSync(vaultPath);
        expect(stat.mode & 0o777).toBe(0o600);
    });

    it('creates vault.key with 0o600 permissions and 32 bytes', () => {
        const store = new CredentialStore(tmpDir);
        store.save('test', 'Trigger key creation', 'key');

        const keyPath = path.join(tmpDir, 'vault.key');
        expect(fs.existsSync(keyPath)).toBe(true);

        const key = fs.readFileSync(keyPath);
        expect(key.length).toBe(32);

        const stat = fs.statSync(keyPath);
        expect(stat.mode & 0o777).toBe(0o600);
    });

    it('round-trips multiple credentials through encrypt/decrypt', () => {
        const store1 = new CredentialStore(tmpDir);
        store1.save('anthropic', 'Key A', 'sk-ant-aaaa');
        store1.save('openai', 'Key B', 'sk-oai-bbbb');
        store1.save('custom', 'Key C', 'custom-secret-cccc');

        const store2 = new CredentialStore(tmpDir);
        expect(store2.get(store1.list()[0].id)).not.toBeNull();

        const allCreds = store2.getByProvider('anthropic');
        expect(allCreds).toHaveLength(1);
        expect(allCreds[0].apiKey).toBe('sk-ant-aaaa');

        const openai = store2.getByProvider('openai');
        expect(openai[0].apiKey).toBe('sk-oai-bbbb');

        const custom = store2.getByProvider('custom');
        expect(custom[0].apiKey).toBe('custom-secret-cccc');
    });

    it('auto-migrates plaintext credentials.json to encrypted vault', () => {
        // Write a legacy plaintext file
        const legacyPath = path.join(tmpDir, 'credentials.json');
        const legacyData = [
            { id: 'anthropic-legacy', provider: 'anthropic', name: 'Old Key', apiKey: 'sk-old-key', createdAt: '2024-01-01T00:00:00Z' },
        ];
        fs.writeFileSync(legacyPath, JSON.stringify(legacyData), { encoding: 'utf-8' });

        // Load store - should migrate
        const store = new CredentialStore(tmpDir);

        // Legacy file should be deleted
        expect(fs.existsSync(legacyPath)).toBe(false);

        // Encrypted vault should exist
        expect(fs.existsSync(path.join(tmpDir, 'credentials.vault'))).toBe(true);

        // Data should be accessible
        const cred = store.get('anthropic-legacy');
        expect(cred).not.toBeNull();
        expect(cred!.apiKey).toBe('sk-old-key');
    });

    it('handles corrupted vault file gracefully', () => {
        // Create a valid vault first (to generate the key)
        const store1 = new CredentialStore(tmpDir);
        store1.save('test', 'Valid', 'key');

        // Corrupt the vault file
        const vaultPath = path.join(tmpDir, 'credentials.vault');
        fs.writeFileSync(vaultPath, 'corrupted garbage data');

        // Should not throw, should start with empty credentials
        const store2 = new CredentialStore(tmpDir);
        expect(store2.list()).toHaveLength(0);
    });

    it('handles corrupted vault key gracefully', () => {
        // Create a valid vault
        const store1 = new CredentialStore(tmpDir);
        store1.save('test', 'Valid', 'key');

        // Replace vault key with wrong key
        const keyPath = path.join(tmpDir, 'vault.key');
        const wrongKey = Buffer.alloc(32, 0xff);
        fs.writeFileSync(keyPath, wrongKey);

        // Should not throw, should start fresh (can't decrypt with wrong key)
        const store2 = new CredentialStore(tmpDir);
        expect(store2.list()).toHaveLength(0);
    });

    it('reuses existing vault key across store instances', () => {
        const store1 = new CredentialStore(tmpDir);
        store1.save('test', 'Key 1', 'secret1');

        const keyPath = path.join(tmpDir, 'vault.key');
        const key1 = fs.readFileSync(keyPath);

        // Second instance should reuse the same key
        const store2 = new CredentialStore(tmpDir);
        store2.save('test', 'Key 2', 'secret2');

        const key2 = fs.readFileSync(keyPath);
        expect(Buffer.compare(key1, key2)).toBe(0);

        // Both credentials should be readable
        expect(store2.list()).toHaveLength(2);
    });

    // --- API key methods ---

    it('saveWithId uses the provided ID', () => {
        const store = new CredentialStore(tmpDir);
        const cred = store.saveWithId('my-custom-id', 'sera-auth', 'Dev Laptop', 'hash123');

        expect(cred.id).toBe('my-custom-id');
        expect(cred.provider).toBe('sera-auth');
        expect(cred.name).toBe('Dev Laptop');
        expect(store.get('my-custom-id')).not.toBeNull();
    });

    it('findByProviderAndValue returns matching credential', () => {
        const store = new CredentialStore(tmpDir);
        store.saveWithId('key-1', 'sera-auth', 'Key 1', 'hash-aaa');
        store.saveWithId('key-2', 'sera-auth', 'Key 2', 'hash-bbb');
        store.save('anthropic', 'Other', 'hash-aaa'); // same value, different provider

        const found = store.findByProviderAndValue('sera-auth', 'hash-aaa');
        expect(found).not.toBeNull();
        expect(found!.id).toBe('key-1');
    });

    it('findByProviderAndValue returns null on no match', () => {
        const store = new CredentialStore(tmpDir);
        store.saveWithId('key-1', 'sera-auth', 'Key 1', 'hash-aaa');

        expect(store.findByProviderAndValue('sera-auth', 'nonexistent')).toBeNull();
        expect(store.findByProviderAndValue('other-provider', 'hash-aaa')).toBeNull();
    });

    it('updateField updates the field and persists', () => {
        const store1 = new CredentialStore(tmpDir);
        store1.saveWithId('key-1', 'sera-auth', 'Key 1', 'hash-aaa');

        const updated = store1.updateField('key-1', 'lastUsedAt', '2026-03-04T12:00:00Z');
        expect(updated).toBe(true);

        // Reload and verify
        const store2 = new CredentialStore(tmpDir);
        const cred = store2.get('key-1');
        expect(cred!.lastUsedAt).toBe('2026-03-04T12:00:00Z');
    });

    it('updateField returns false for nonexistent ID', () => {
        const store = new CredentialStore(tmpDir);
        expect(store.updateField('nonexistent', 'lastUsedAt', 'now')).toBe(false);
    });

    it('lastUsedAt survives save/load roundtrip', () => {
        const store1 = new CredentialStore(tmpDir);
        store1.saveWithId('key-1', 'sera-auth', 'Key 1', 'hash');
        store1.updateField('key-1', 'lastUsedAt', '2026-01-01T00:00:00Z');

        const store2 = new CredentialStore(tmpDir);
        const cred = store2.get('key-1');
        expect(cred!.lastUsedAt).toBe('2026-01-01T00:00:00Z');
    });
});
