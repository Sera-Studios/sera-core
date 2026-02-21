# Deployment & IDE Connection

This guide covers how to deploy sera-core and connect it with the VS Code extension and Claude Code agents.

## Deployment

### Local Development

For development, run sera-core in the foreground:

```bash
cd services/sera-core
npm run dev
```

### Background Daemon

For regular use, run sera-core as a background daemon:

```bash
sera-core start -d
```

The daemon persists across terminal sessions and IDE restarts. Stop it with `sera-core stop`.

### Verify It's Running

```bash
sera-core status
```

Or directly via HTTP:

```bash
curl http://localhost:9800/api/health
```

## Connecting VS Code Extension

The sera-studio-code VS Code extension connects to sera-core automatically when both are running on the same machine.

### Automatic Connection

The extension attempts to connect to `ws://localhost:9800` on activation. If sera-core is running, the connection is established automatically.

### Manual Configuration

If you're running sera-core on a non-default port, configure it in VS Code settings:

```json
{
  "sera.corePort": 9800
}
```

### Workspace Registration

When you open a workspace in VS Code with the extension active:

1. The extension connects to sera-core via WebSocket
2. It sends an `audit-selected` message with the workspace path
3. sera-core looks up (or creates) the audit for that workspace
4. The extension subscribes to real-time updates for that audit

## Connecting Claude Code Agents

Claude Code agents connect to sera-core's MCP server via HTTP JSON-RPC.

### Step 1: Create an Audit

If you haven't already, create an audit for your workspace. The easiest way is through the VS Code extension (it creates audits automatically). Alternatively, use the REST API:

```bash
curl -X POST http://localhost:9800/api/audits \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Protocol", "workspacePath": "/path/to/workspace"}'
```

Note the `slug` in the response.

### Step 2: Configure MCP

Create or update `.mcp.json` in your workspace root:

```json
{
  "mcpServers": {
    "sessionbridge": {
      "type": "http",
      "url": "http://localhost:9877/mcp/my-audit-slug"
    }
  }
}
```

Replace `my-audit-slug` with the audit slug from Step 1. You can find it with:

```bash
sera-core list
```

### Step 3: Verify Connection

Start a Claude Code session in the workspace. The agent should be able to call `register_agent` and receive an `agent_id`. Check sera-core's logs for:

```
[MCP] Agent registered: hunter-a1b2c3 (hunter v0.0.1) audit=my-audit-slug
```

## Testnet Mode

Testnet mode enables additional debugging capabilities:

```bash
sera-core start --testnet
```

In testnet mode:

- A separate debug MCP server starts on port 9878
- All events are recorded for later inspection
- A circular log buffer captures recent log entries
- Debug tools are available via the debug MCP server

### Debug MCP Configuration

To connect debug tools in testnet mode:

```json
{
  "mcpServers": {
    "sera-debug": {
      "type": "http",
      "url": "http://localhost:9878/mcp"
    }
  }
}
```

## Connecting agent-designer

The agent-designer connects to sera-core's WebSocket and REST APIs.

### Configuration

The agent-designer reads the sera-core URL from its own configuration. By default, it connects to `http://localhost:9800`.

### What It Accesses

- **REST API** (`/api/agents`) - agent registration management
- **REST API** (`/api/agents/:id/execute`) - agent execution
- **WebSocket** - real-time execution status updates

## Connecting benchmarker-dashboard

The benchmarker dashboard connects to sera-core for contest data and evaluation results.

### Configuration

By default, the dashboard connects to `http://localhost:9800`.

### What It Accesses

- **REST API** (`/api/benchmarks/*`) - contest and finding management
- **WebSocket** - real-time evaluation updates

## Port Summary

| Port | Service | Protocol |
|------|---------|----------|
| 9800 | Client server | HTTP REST + WebSocket |
| 9877 | MCP server | HTTP JSON-RPC |
| 9878 | Debug MCP server (testnet only) | HTTP JSON-RPC |

All ports are configurable via `~/.sera/config.json` or constructor options.

## Troubleshooting

### sera-core won't start

**Port in use**: Check if another process is using port 9800 or 9877:

```bash
lsof -i :9800
lsof -i :9877
```

**Stale PID file**: If sera-core crashed, the PID file may be stale:

```bash
sera-core stop    # Cleans up PID file
sera-core start -d
```

### Extension can't connect

1. Verify sera-core is running: `sera-core status`
2. Check the port matches: `curl http://localhost:9800/api/health`
3. Check VS Code output panel for connection errors

### Agents can't call tools

1. Verify the MCP server is running: `curl http://localhost:9877/health`
2. Check the audit slug in `.mcp.json` matches an existing audit: `sera-core list`
3. Check sera-core logs for error messages
