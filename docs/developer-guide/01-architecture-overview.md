# Architecture Overview

sera-core is a persistent Node.js daemon that serves as the central backend for the Sera Audit Labs platform. It manages audit data, hosts MCP tools for Claude Code agents, and distributes real-time events across connected clients.

## Design Principles

1. **Persistent daemon** - runs as a long-lived background process, surviving IDE restarts
2. **Per-audit isolation** - each audit gets its own SQLite database and event scope
3. **Pluggable handlers** - MCP tool handlers register independently, each declaring their own table schemas
4. **Real-time sync** - storage changes propagate instantly to all subscribed clients via WebSocket

## System Diagram

```
                    +-----------------------+
                    |     Claude Code       |
                    |   (Hunter, Tester,    |
                    |    Cartographer...)    |
                    +-----------+-----------+
                                |
                         HTTP JSON-RPC
                          POST /mcp/:slug
                                |
+----------------+    +---------v---------+    +------------------+
|   VS Code      |    |                   |    |  Benchmark       |
|   Extension    +<-->+    sera-core      +<-->+  Dashboard       |
|  (WebSocket)   |    |                   |    |  (WebSocket)     |
+----------------+    +---+----+----+-----+    +------------------+
                          |    |    |
              +-----------+    |    +-----------+
              |                |                |
     +--------v-----+  +------v------+  +------v------+
     | StorageEngine |  | EventBridge |  | Credential  |
     | (sql.js)      |  | (pub/sub)   |  | Store       |
     +--------+------+  +-------------+  | (AES-256)   |
              |                           +-------------+
     ~/.sera/audits/{slug}/audit.db
```

## Server Architecture

sera-core runs two HTTP servers on separate ports:

| Server | Default Port | Protocol | Purpose |
|--------|-------------|----------|---------|
| Client server | 9800 | HTTP + WebSocket | REST API for management, WebSocket for real-time client connections |
| MCP server | 9877 | HTTP JSON-RPC | Tool calls from Claude Code agents |
| Debug MCP server | 9878 | HTTP JSON-RPC | Debug tools (testnet mode only) |

## Module Overview

```
src/
├── server.ts                    # Daemon orchestrator (SeraCore class)
├── cli.ts                       # CLI for daemon control
├── config.ts                    # Configuration loading
├── api/
│   ├── RestAPI.ts               # Express REST endpoints
│   └── WebSocketAPI.ts          # WebSocket client management
├── mcp/
│   ├── MCPServer.ts             # JSON-RPC dispatcher + session tracking
│   └── handlers/                # Pluggable MCP tool handlers
│       ├── CoreHandler.ts       # Session tracking, visualizations, prompts
│       ├── AgentHandler.ts      # Agent registration queries
│       ├── NotepadHandler.ts    # POI, issue, comment, question management
│       ├── QuizHandler.ts       # Quiz submission and grading
│       ├── StatsHandler.ts      # Session statistics
│       ├── TestCoverageHandler.ts # Test mapping and coverage tracking
│       ├── TraceHandler.ts      # Call graph and state variable analysis
│       └── DebugHandler.ts      # Event recording, log access (testnet only)
├── database/
│   ├── AuditRegistry.ts         # Workspace-to-audit mapping
│   ├── StorageEngine.ts         # sql.js SQLite wrapper per audit
│   └── DatabaseManager.ts       # Lazy engine lifecycle management
├── events/
│   └── EventBridge.ts           # Pub/sub for cross-client event distribution
├── credentials/
│   └── CredentialStore.ts       # AES-256-GCM encrypted API key vault
├── agents/
│   └── AgentRegistrationStore.ts # Load and manage agent definitions
├── execution/
│   └── AgentExecutor.ts         # Spawn agent subprocesses with credential injection
├── benchmark/
│   ├── BenchmarkStore.ts        # Contest and finding storage
│   └── importSherlock.ts        # Sherlock audit data importer
└── debug/
    └── LogBuffer.ts             # Circular log buffer for testnet mode
```

## Startup Sequence

1. `SeraCore` constructor initializes all subsystems:
   - `ensureSeraHome()` creates `~/.sera/` directory structure
   - `loadConfig()` reads `~/.sera/config.json` (or uses defaults)
   - `AuditRegistry` loads workspace-to-audit mappings
   - `DatabaseManager` wraps lazy access to per-audit `StorageEngine` instances
   - `EventBridge` is created (no initial subscriptions)
   - `AgentRegistrationStore` loads agent definitions from disk
   - `CredentialStore` manages the encrypted vault
   - `AgentExecutor` is initialized with credential store and registration store
   - `BenchmarkStore` prepares contest/finding storage

2. `start()` brings servers online:
   - Express app with CORS middleware and REST router
   - HTTP server with WebSocket upgrade on port 9800
   - MCP server on port 9877
   - (Testnet) Debug MCP server on port 9878
   - Session cleanup timer (every 30s, 90s timeout)

3. Shutdown (`stop()`) is graceful:
   - Clear cleanup timer
   - Stop MCP servers
   - Close WebSocket connections
   - Flush and close all database engines
   - Close HTTP server

## Data Flow

### Agent Tool Call

```
Agent POST /mcp/:slug -> MCPServer.handleMCPRequest()
  -> Parse JSON-RPC -> handleToolCall()
    -> Resolve session from agent_id
    -> Resolve audit slug (URL > session > default)
    -> Ensure handler table schemas registered
    -> Build HandlerContext (scoped db + bridge ops)
    -> Handler processes tool call
    -> Handler writes to StorageEngine via context.db.write()
    -> EventBridge broadcasts storage update to WebSocket clients
    -> Return JSON-RPC result to agent
```

### Client Subscription

```
VS Code connects via WebSocket -> WebSocketAPI handles 'connect' message
  -> Client sends 'subscribe' with audit slug + table patterns
  -> EventBridge.subscribe() registers the subscription
  -> On storage updates, EventBridge filters by audit + pattern
  -> Matching clients receive StorageUpdatePushMessage
```

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | Node.js (ES2020) | Server execution |
| Language | TypeScript (strict mode) | Type safety |
| HTTP | Express 4 | REST API |
| WebSocket | ws 8 | Real-time client connections |
| Database | sql.js (SQLite in WASM) | Per-audit data storage |
| Encryption | Node crypto (AES-256-GCM) | Credential vault |
| Types | @sera/types (monorepo) | Shared type definitions |
| Testing | Vitest | Unit and integration tests |
