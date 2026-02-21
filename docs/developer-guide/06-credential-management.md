# Credential Management

sera-core includes an encrypted credential vault for storing API keys. Credentials are encrypted at rest using AES-256-GCM and can be injected into agent subprocesses as environment variables.

## Vault Architecture

```
CredentialStore
  ├── ~/.sera/vault.key              # 256-bit encryption key (mode 0600)
  └── ~/.sera/credentials.vault      # Encrypted binary vault
        └── [IV:12][authTag:16][ciphertext]
```

### Encryption

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key**: 256-bit random key generated on first use
- **IV**: 12-byte random initialization vector per encryption
- **Auth tag**: 16-byte authentication tag for integrity verification

### Binary Format

The vault file uses a compact binary format:

```
Offset  Length  Content
0       12      Initialization Vector (IV)
12      16      Authentication Tag
28      N       Encrypted JSON (credential array)
```

### Key Storage

The vault key is stored at `~/.sera/vault.key` with file permissions `0o600` (owner read/write only). This key is generated once and reused for all subsequent encrypt/decrypt operations.

## Credential Structure

```typescript
interface Credential {
  id: string;          // Unique identifier (UUID)
  provider: string;    // Provider name (e.g., "openai", "anthropic")
  name: string;        // Human-readable label
  apiKey: string;      // The actual API key value
  createdAt: string;   // ISO 8601 timestamp
}
```

## Operations

### Save Credential

```typescript
credentialStore.save({
  id: 'uuid-here',
  provider: 'openai',
  name: 'My OpenAI Key',
  apiKey: 'sk-...',
  createdAt: new Date().toISOString()
});
```

Encrypts the full credential array and writes to disk.

### Get Credential

```typescript
const cred = credentialStore.get('uuid-here');
```

Decrypts the vault, finds the credential by ID, returns it (or null).

### Get by Provider

```typescript
const creds = credentialStore.getByProvider('openai');
```

Returns all credentials for a given provider.

### Remove Credential

```typescript
credentialStore.remove('uuid-here');
```

Removes the credential from the array and re-encrypts.

### List Masked

```typescript
const masked = credentialStore.listMasked();
// Returns: [{ id, provider, name, apiKey: '...last4', createdAt }]
```

Returns credentials with API keys masked to show only the last 4 characters. Used for display in UIs.

## Agent Credential Injection

When the `AgentExecutor` spawns an agent subprocess, it can inject credentials as environment variables:

1. Agent registration specifies required credentials (by provider)
2. AgentExecutor queries CredentialStore for matching credentials
3. Credentials are injected as environment variables into the subprocess
4. Variable naming follows the pattern: `SERA_CRED_{PROVIDER}_{NAME}_API_KEY`

This ensures API keys are never written to disk in plaintext by agents and are only available in the subprocess environment.

## Migration

The CredentialStore supports automatic migration from an older plaintext format:

- If `~/.sera/credentials.json` exists (old format), it is:
  1. Read and parsed
  2. Encrypted into the new vault format
  3. The plaintext file is deleted

This migration happens transparently on first access.

## REST API

Credentials are managed via the REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/credentials` | List all credentials (masked) |
| POST | `/api/credentials` | Save a new credential |
| DELETE | `/api/credentials/:id` | Remove a credential |

The REST API never returns full API keys - only the masked versions via `listMasked()`.
