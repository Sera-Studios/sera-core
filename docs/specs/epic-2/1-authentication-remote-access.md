# Spec 1: Authentication & Remote Access

**Status:** Pending
**Epic:** 2 - Infrastructure & Access
**Depends on:** None

## Overview

Add API key authentication to sera-core's REST and MCP endpoints. Keys are managed via CLI commands and stored in the existing `CredentialStore`. Localhost connections can optionally bypass auth for local development convenience.

## Authentication Model

### API Key Flow

```
Client                                   sera-core
  |                                         |
  |  GET /api/resources                     |
  |  Authorization: Bearer sk-sera-abc123   |
  |  ────────────────────────────────────>  |
  |                                         |
  |                          Validate key   |
  |                          against store  |
  |                                         |
  |  200 OK                                 |
  |  <────────────────────────────────────  |
```

### Key Format

Keys follow the pattern: `sk-sera-{32 hex chars}`

Example: `sk-sera-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`

### Key Storage

Keys are stored in `CredentialStore` (AES-256-GCM encrypted vault at `~/.sera/credentials.enc`):

```typescript
interface ApiKey {
  id: string;          // short identifier, e.g., "dev-laptop"
  keyHash: string;     // SHA-256 hash of the full key (never store plaintext)
  createdAt: string;   // ISO timestamp
  lastUsedAt?: string; // updated on each successful auth
  label?: string;      // optional human-readable description
}
```

The full key is only shown once at creation time. Only the hash is stored.

## Express Middleware

```typescript
// src/api/authMiddleware.ts

function createAuthMiddleware(config: SeraConfig, credentialStore: CredentialStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth if disabled in config
    if (!config.auth?.enabled) return next();

    // Skip auth for localhost if configured
    if (config.auth?.skipLocalhost && isLocalhost(req)) return next();

    // Skip auth for health endpoint
    if (req.path === '/health') return next();

    // Extract key from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing API key. Use: Authorization: Bearer sk-sera-...' });
    }

    const key = authHeader.slice(7);
    if (!validateApiKey(key, credentialStore)) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    // Update last used timestamp
    updateKeyLastUsed(key, credentialStore);
    next();
  };
}

function isLocalhost(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
```

### MCP Server Auth

The MCP server (`MCPServer.ts`) also needs auth. Apply the same middleware to the `/mcp` route:

```typescript
// In server.ts
const authMiddleware = createAuthMiddleware(config, credentialStore);
app.use('/api', authMiddleware);
app.use('/mcp', authMiddleware);
```

## Configuration

Add auth config to `~/.sera/config.json`:

```json
{
  "auth": {
    "enabled": false,
    "skipLocalhost": true
  }
}
```

- `enabled: false` by default - no breaking change for existing users
- `skipLocalhost: true` by default - local development works without keys even when auth is enabled
- When deploying remotely, set `enabled: true` and `skipLocalhost: false`

## CLI Commands

Extend `src/cli.ts` with key management:

### `sera-core auth generate`

```bash
$ sera-core auth generate --label "dev-laptop"
Generated API key for "dev-laptop":

  sk-sera-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4

Save this key - it cannot be retrieved later.
Auth is currently disabled. Enable with: sera-core auth enable
```

### `sera-core auth list`

```bash
$ sera-core auth list
ID            Label        Created              Last Used
dev-laptop    Dev laptop   2026-03-04 08:30:00  2026-03-04 12:15:00
ci-server     CI pipeline  2026-03-01 10:00:00  never
```

### `sera-core auth revoke`

```bash
$ sera-core auth revoke dev-laptop
Revoked API key "dev-laptop".
```

### `sera-core auth enable` / `sera-core auth disable`

```bash
$ sera-core auth enable
Authentication enabled. Remote connections now require an API key.
Localhost connections are bypassed (change with: sera-core auth no-skip-localhost).

$ sera-core auth disable
Authentication disabled. All connections are accepted.
```

## Client Updates

### Designer SeraClient

`services/agent-designer/src/SeraClient.ts` needs to pass the API key:

```typescript
class SeraClient {
  constructor(private baseUrl: string, private apiKey?: string) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }
}
```

The API key can come from:
1. Environment variable: `SERA_API_KEY`
2. Config file: designer reads from its own config
3. CLI flag: `--sera-api-key`

### Benchmarker

Same pattern - `runner.ts` fetch calls to sera-core include the API key header.

### MCP Clients (.mcp.json)

MCP HTTP clients need to send the key. The `.mcp.json` format supports headers:

```json
{
  "mcpServers": {
    "sessionbridge": {
      "type": "http",
      "url": "http://localhost:9877/mcp",
      "headers": {
        "Authorization": "Bearer sk-sera-..."
      }
    }
  }
}
```

## SSH Tunnel Usage

For remote access, the recommended approach is SSH tunnel + API key:

```bash
# On local machine: tunnel sera-core ports
ssh -L 9800:localhost:9800 -L 9877:localhost:9877 user@remote-server

# Configure .mcp.json to use localhost (tunnel handles encryption)
# API key handles authentication
```

This keeps the auth simple (no TLS cert management) while SSH handles transport security.

## Key Files

| File | Change |
|------|--------|
| `src/api/authMiddleware.ts` | **New** - Express auth middleware |
| `src/server.ts` | Mount auth middleware on REST and MCP routes |
| `src/cli.ts` | Add `auth` subcommand (generate, list, revoke, enable, disable) |
| `src/config.ts` | Add `auth` config section |
| `src/credentials/CredentialStore.ts` | Add API key storage methods |

## Validation Checklist

- [ ] API key generation produces correctly formatted keys
- [ ] Key hash stored in CredentialStore (not plaintext)
- [ ] Valid key passes authentication
- [ ] Invalid key returns 403
- [ ] Missing key returns 401 with helpful message
- [ ] Localhost bypass works when configured
- [ ] `/health` endpoint accessible without auth
- [ ] Auth disabled by default (no breaking change)
- [ ] CLI commands work: generate, list, revoke, enable, disable
- [ ] MCP endpoints authenticated when auth is enabled
- [ ] Last-used timestamp updated on successful auth
- [ ] `npm run compile` and `npm test` pass
