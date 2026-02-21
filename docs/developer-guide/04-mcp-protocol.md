# MCP Protocol

sera-core hosts an MCP (Model Context Protocol) server that exposes tools for Claude Code agents. The server uses HTTP JSON-RPC on a dedicated port (default 9877), separate from the client WebSocket server.

## Protocol Overview

The MCP server implements a subset of the Model Context Protocol specification:

| Method | Description |
|--------|-------------|
| `initialize` | Protocol handshake, returns server capabilities |
| `notifications/initialized` | Client acknowledgment |
| `tools/list` | List all available tools with schemas |
| `tools/call` | Execute a specific tool |

All requests use JSON-RPC 2.0 over HTTP POST.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | Tool calls without audit scope (uses default audit) |
| POST | `/mcp/:slug` | Tool calls scoped to a specific audit |
| GET | `/mcp/tools` | List available tools (convenience endpoint) |
| GET | `/health` | MCP server health check |

## Agent Registration

Every agent session begins with a `register_agent` call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "register_agent",
    "arguments": {
      "agent_name": "hunter",
      "agent_version": "0.0.1"
    }
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"agent_id\": \"hunter-a1b2c3\", \"audit_slug\": \"my-audit\", \"message\": \"Registered. Include agent_id in all subsequent tool calls.\"}"
    }]
  }
}
```

The `agent_id` is a combination of agent name and a random hex suffix. It must be included in all subsequent tool calls for session tracking.

## Audit Context Resolution

When a tool is called, the MCP server resolves the audit context in priority order:

1. **URL path** - `/mcp/my-audit-slug` takes highest priority
2. **Session audit** - Audit slug stored when the agent registered
3. **Default audit** - First (or only) audit in the registry

If no audit context can be resolved, the tool call returns an error.

## Session Management

### Session State

Each registered agent has a `SessionState`:

| Field | Description |
|-------|-------------|
| `sessionId` | Unique session identifier (format: `agent_{agentId}`) |
| `agentType` | Agent role name (e.g., `hunter`) |
| `auditSlug` | Resolved audit scope |
| `workspacePath` | Workspace path (if provided) |
| `lastHeartbeat` | Last activity timestamp |
| `agentId` | Generated agent ID |
| `agentName` | Agent name from registration |
| `agentVersion` | Agent version from registration |
| `registeredAt` | Registration timestamp |

### Session Cleanup

Stale sessions are cleaned up every 30 seconds. A session is considered stale after 90 seconds of inactivity (no tool calls with its `agent_id`).

## Handler System

### PortableMcpHandler Interface

All MCP tool handlers implement the `PortableMcpHandler` interface from `@sera/types`:

```typescript
interface PortableMcpHandler {
  getToolDefinitions(): McpToolDefinition[];
  handleToolCall(name: string, args: Record<string, unknown>, context: HandlerContext): Promise<unknown>;
  getRequiredTableSchemas?(): Array<{ appletId: string; schemas: TableSchema[] }>;
}
```

### HandlerContext

Every tool call receives a `HandlerContext` with scoped access:

```typescript
interface HandlerContext {
  auditSlug: string;          // Active audit
  sessionId: string;          // Agent session ID
  agentType: string;          // Agent role (hunter, tester, etc.)
  workspacePath: string;      // Workspace path
  db: HandlerDatabaseOps;     // Scoped database operations
  bridge: HandlerBridgeOps;   // Event distribution operations
  agentId?: string;           // Agent ID from registration
  agentName?: string;         // Agent name
  agentVersion?: string;      // Agent version
}
```

### Database Operations (HandlerDatabaseOps)

| Method | Signature | Description |
|--------|-----------|-------------|
| `write` | `(appletId, table, data) => Promise<void>` | Upsert by primary key, broadcasts storage update |
| `query` | `(appletId, table, filter?) => Promise<Record[]>` | Query with optional field filters |
| `sql` | `(query, params?) => Promise<any[]>` | Raw SQL query |
| `delete` | `(appletId, table, filter) => Promise<number>` | Delete matching records, broadcasts storage update |

### Bridge Operations (HandlerBridgeOps)

| Method | Signature | Description |
|--------|-----------|-------------|
| `emit` | `(event, data) => void` | Emit a custom bridge event |
| `broadcastStorageUpdate` | `(appletId, table, action, data) => void` | Manual storage update broadcast |

## Registered Handlers

| Handler | Tools | Description |
|---------|-------|-------------|
| CoreHandler | 7 | Session tracking, visualizations, prompt logging |
| NotepadHandler | 5 | POI, issue, comment, question management |
| QuizHandler | 3 | Quiz submission and grading |
| TestCoverageHandler | 6 | Test mapping and coverage tracking |
| StatsHandler | 5 | Session statistics and gamification |
| TraceHandler | 5 | Call graph traversal and state analysis |
| AgentHandler | 1 | Agent registration queries |
| DebugHandler | 4 | Log access, event recording (testnet only) |

## Table Schema Registration

Handlers declare their required table schemas via `getRequiredTableSchemas()`. When a tool is called, the MCP server ensures all required tables exist in the target audit's StorageEngine before delegating to the handler.

```typescript
getRequiredTableSchemas() {
  return [{
    appletId: 'sessionbridge',
    schemas: [{
      name: 'notepad_pois',
      version: 1,
      primaryKey: 'id',
      fields: [
        { name: 'id', type: 'TEXT' },
        { name: 'file', type: 'TEXT' },
        { name: 'start_line', type: 'INTEGER' },
        { name: 'end_line', type: 'INTEGER' },
        { name: 'text', type: 'TEXT' },
        { name: 'created_at', type: 'TEXT' },
      ],
    }],
  }];
}
```

If a table's schema version changes, the StorageEngine drops and recreates it.

## Tool Schema Augmentation

The MCP server automatically injects an `agent_id` property into every handler tool's input schema. This allows agents to include their session identifier without handlers needing to declare it themselves.

## Claude Code Configuration

To connect Claude Code to sera-core, add an `.mcp.json` file to the workspace:

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

Replace `my-audit-slug` with the audit identifier shown by `sera-core list`.
