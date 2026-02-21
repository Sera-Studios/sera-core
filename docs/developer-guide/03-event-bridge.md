# Event Bridge

The EventBridge is sera-core's pub/sub system for distributing real-time updates across connected clients. It ensures that when an agent writes data via MCP, all subscribed UI clients (VS Code, dashboards) receive the update immediately.

## Core Concepts

### Subscriptions

Clients subscribe to specific table patterns on a specific audit. A subscription consists of:

| Field | Type | Description |
|-------|------|-------------|
| `ws` | WebSocket | Client's WebSocket connection |
| `clientId` | string | Unique identifier for the client |
| `auditSlug` | string | Which audit this subscription covers |
| `tablePatterns` | string[] | Glob patterns for table matching |

### Table Patterns

Table keys use the format `appletId:tableName`. Clients subscribe using glob patterns:

| Pattern | Matches |
|---------|---------|
| `*` | All tables on the subscribed audit |
| `sessionbridge:*` | All tables under the `sessionbridge` applet |
| `sessionbridge:claude_sessions` | Exact match for one table |
| `notepad:notepad_*` | All notepad tables starting with `notepad_` |

### Event Types

The bridge handles two types of events:

1. **Storage updates** - triggered when data is written to a StorageEngine table
2. **Bridge events** - custom-structured events emitted by handlers for non-storage notifications

## Storage Update Flow

```
Agent calls MCP tool (e.g., submit_poi)
  -> Handler writes via context.db.write()
    -> StorageEngine.write() persists data
    -> MCPServer calls bridge.broadcastStorageUpdate()
      -> EventBridge iterates subscriptions
        -> Filter: same audit slug
        -> Filter: table pattern matches
        -> Filter: exclude source client
        -> Send StorageUpdatePushMessage to matching clients
```

### StorageUpdatePushMessage Format

```typescript
{
  type: 'storage:update',
  source: 'sera-core-mcp',       // Client that caused the change
  appletId: 'sessionbridge',     // Applet that owns the table
  table: 'notepad_pois',         // Table name
  action: 'insert',              // 'insert' | 'update' | 'delete'
  data: { ... }                  // The changed record(s)
}
```

## Bridge Event Flow

```
Handler calls context.bridge.emit(event, data)
  -> MCPServer wraps in BridgeEvent
    -> EventBridge.broadcastBridgeEvent()
      -> Broadcast to all clients on the same audit
      -> Exclude the source client
```

### BridgeEvent Format

```typescript
{
  type: 'bridge:event',
  auditSlug: 'my-audit',
  event: 'agent-registered',     // Custom event name
  data: { ... },                 // Custom payload
  source: 'sera-core-mcp',
  timestamp: '2026-02-21T12:00:00.000Z'
}
```

## Subscription API

### Subscribing

Clients send a WebSocket message to subscribe:

```json
{
  "type": "subscribe",
  "auditSlug": "my-audit",
  "tables": ["sessionbridge:*", "notepad:*"]
}
```

The WebSocketAPI calls `EventBridge.subscribe()` with the client's WebSocket, ID, audit slug, and patterns.

### Unsubscribing

Clients are automatically unsubscribed when their WebSocket connection closes. The WebSocketAPI calls `EventBridge.unsubscribeClient()` on disconnect.

## Source Exclusion

The bridge never sends an update back to the client that caused it. This prevents echo loops:

- For storage updates: the `sourceClientId` parameter identifies the originator
- For bridge events: the `event.source` field identifies the originator

When sera-core's MCP server causes an update (via agent tool calls), the source is `'sera-core-mcp'`. Since MCP agents connect over HTTP (not WebSocket), they never have WebSocket subscriptions and the exclusion is transparent.

## Recording Mode (Testnet)

In testnet mode, the EventBridge records all events for debugging:

```typescript
bridge.enableRecording();

// ... events happen ...

const events = bridge.getRecordedEvents();
// Returns: RecordedEvent[]

bridge.clearRecordedEvents();
```

Each `RecordedEvent` contains:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'storage-update'` or `'bridge-event'` | Event category |
| `timestamp` | string (ISO 8601) | When the event was recorded |
| `data` | object | Full event payload |

The DebugHandler exposes recorded events via MCP tools (`get_recorded_events`, `clear_recorded_events`).

## Pattern Matching Implementation

The bridge converts glob patterns to regular expressions for matching:

- `*` becomes `.*` (match any sequence)
- `?` becomes `.` (match any single character)
- Pattern is anchored with `^...$` for exact matching

Example: `sessionbridge:quiz_*` matches `sessionbridge:quiz_questions` and `sessionbridge:quiz_grades` but not `notepad:quiz_questions`.

## Usage in Handlers

Handlers interact with the bridge through `HandlerContext`:

```typescript
// Write data (automatically broadcasts storage update)
await context.db.write('sessionbridge', 'notepad_pois', poiData);

// Emit a custom bridge event
context.bridge.emit('finding-submitted', { severity: 'high', title: '...' });

// Broadcast a manual storage update (rare - use context.db.write instead)
context.bridge.broadcastStorageUpdate('applet', 'table', 'insert', data);
```

The `context.db.write()` method automatically triggers `broadcastStorageUpdate()`, so handlers rarely need to call the bridge directly. Custom bridge events via `context.bridge.emit()` are for notifications that aren't tied to a specific table change.
