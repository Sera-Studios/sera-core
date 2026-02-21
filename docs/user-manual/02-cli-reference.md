# CLI Reference

The `sera-core` CLI controls the daemon lifecycle and provides management commands.

## Usage

```
sera-core <command> [options]
```

## Commands

### start

Start the sera-core daemon.

```bash
sera-core start          # Foreground mode
sera-core start -d       # Background/detached mode
sera-core start --detached
```

**Foreground mode**: The daemon runs in the current terminal. Stop with Ctrl+C.

**Detached mode**: The daemon runs as a background process. Output is redirected to `~/.sera/logs/sera-core.log`. A PID file is written to `~/.sera/sera-core.pid`.

If the daemon is already running (PID file exists and process is alive), `start -d` reports that and exits without starting a second instance.

### stop

Stop the running daemon.

```bash
sera-core stop
```

Sends SIGTERM to the daemon process identified by the PID file. Removes the PID file after stopping.

### status

Show the daemon's current state.

```bash
sera-core status
```

Output when running:

```
sera-core: running
  Version: 0.1.0
  Uptime: 1h 23m 45s
  Audits: 3
  Clients: 2
  Port: 9800
```

Output when stopped:

```
sera-core: not running
```

### list

List all registered audits with metadata.

```bash
sera-core list
```

Output:

```
3 audit(s):

  my-protocol
    Name: My Protocol
    Last accessed: 2026-02-21T10:30:00.000Z
    Workspaces: /home/user/projects/my-protocol

  another-audit
    Name: Another Audit
    Last accessed: 2026-02-20T15:00:00.000Z
    Workspaces: /home/user/projects/another
```

### health

Output the health check response as JSON.

```bash
sera-core health
```

Output:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 5025,
  "audits": 3,
  "clients": 2
}
```

Exits with code 1 if the daemon is not responding.

### migrate

Migrate a workspace's existing database from the old `.vscode/sera-studio.db` location to sera-core's centralized storage.

```bash
sera-core migrate /path/to/workspace
```

This command:

1. Locates `.vscode/sera-studio.db` in the workspace
2. Creates a new audit in `~/.sera/audits/` (slug derived from folder name)
3. Copies the database to the new location
4. Renames the original to `.vscode/sera-studio.db.migrated` as a backup
5. Registers the workspace path in the audit registry

Output:

```
Migrated successfully:
  Audit:    my-protocol
  From:     /path/to/workspace/.vscode/sera-studio.db
  To:       /home/user/.sera/audits/my-protocol/audit.db
  Backup:   /path/to/workspace/.vscode/sera-studio.db.migrated
```

## Files

| File | Purpose |
|------|---------|
| `~/.sera/sera-core.pid` | PID file for daemon management |
| `~/.sera/logs/sera-core.log` | Log output (detached mode) |
| `~/.sera/config.json` | Configuration overrides |
| `~/.sera/audits/registry.json` | Workspace-to-audit mappings |
