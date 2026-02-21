# sera-core - Development Configuration

## 1. Overview

| Field | Value |
|-------|-------|
| **Package** | `@sera/core` |
| **Version** | `0.1.0` |
| **Language** | TypeScript (strict mode) |
| **Runtime** | Node.js (ES2020) |
| **Purpose** | Persistent daemon for audit data management, MCP hosting, and cross-client event distribution |

## 2. Build & Test

| Task | Command |
|------|---------|
| Compile | `npm run compile` |
| Watch | `npm run watch` |
| Start | `npm start` |
| Dev (compile + start) | `npm run dev` |
| Test | `npm test` |
| Test (watch) | `npm run test:watch` |
| Test (coverage) | `npm run test:coverage` |

**Build verification**: Run `npm run compile` before every commit. The build must succeed with zero errors and zero warnings.

## 3. Architecture

```
src/
├── server.ts                    # Daemon entry point (SeraCore class)
├── cli.ts                       # CLI for daemon control (sera-core command)
├── config.ts                    # Configuration loading from ~/.sera/config.json
├── api/
│   ├── RestAPI.ts               # Express REST endpoints (port 9800)
│   └── WebSocketAPI.ts          # WebSocket client connections (port 9800)
├── mcp/
│   ├── MCPServer.ts             # MCP HTTP JSON-RPC dispatcher (port 9877)
│   └── handlers/                # Pluggable MCP tool handlers
│       ├── CoreHandler.ts       # Session, visualization, prompt tracking
│       ├── AgentHandler.ts      # Agent registration queries
│       ├── NotepadHandler.ts    # POI, issue, comment, question management
│       ├── QuizHandler.ts       # Quiz submission and grading
│       ├── StatsHandler.ts      # Session statistics and gamification
│       ├── TestCoverageHandler.ts # Test mapping and coverage
│       ├── TraceHandler.ts      # Call graph and state variable analysis
│       └── DebugHandler.ts      # Debug tools (testnet mode only)
├── database/
│   ├── AuditRegistry.ts         # Workspace-to-audit mapping (registry.json)
│   ├── StorageEngine.ts         # sql.js SQLite wrapper (per-audit)
│   └── DatabaseManager.ts       # Lazy engine lifecycle management
├── events/
│   └── EventBridge.ts           # Pub/sub for cross-client event distribution
├── credentials/
│   └── CredentialStore.ts       # AES-256-GCM encrypted API key vault
├── agents/
│   └── AgentRegistrationStore.ts # Load/manage agent definitions from disk
├── execution/
│   └── AgentExecutor.ts         # Spawn agent subprocesses
├── benchmark/
│   ├── BenchmarkStore.ts        # Contest and finding storage (sql.js)
│   └── importSherlock.ts        # Sherlock audit data importer
└── debug/
    └── LogBuffer.ts             # Circular log buffer (testnet mode)
```

### Ports

| Port | Service | Protocol |
|------|---------|----------|
| 9800 | Client server | HTTP REST + WebSocket |
| 9877 | MCP server | HTTP JSON-RPC |
| 9878 | Debug MCP (testnet only) | HTTP JSON-RPC |

### Data Flow

1. Claude Code agents call MCP tools via HTTP POST to `:9877/mcp/:slug`
2. MCPServer resolves session and audit context, delegates to handler
3. Handler writes to StorageEngine via HandlerContext
4. EventBridge broadcasts storage update to WebSocket-subscribed UI clients
5. VS Code extension, dashboards receive real-time updates

## 4. Dependencies

| Dependency | Purpose |
|------------|---------|
| `@sera/types` | Shared type definitions (monorepo local) |
| `express` | HTTP REST API |
| `sql.js` | SQLite in WebAssembly (per-audit databases) |
| `ws` | WebSocket server |

Do not add dependencies without justification. Each dependency is attack surface and maintenance burden.

## 5. Conventions

### TypeScript

- **Strict mode** is mandatory (`"strict": true` in tsconfig.json)
- **No `any`** unless documented with a justification comment
- Use `@sera/types` for all shared interfaces - do not duplicate type definitions
- All source files include a `@fileoverview` JSDoc header

### Code Style

- Clarity over cleverness - prefer explicit, readable code
- No phantom features - do not document or validate features that are not implemented
- Replace, don't deprecate - when replacing an implementation, remove the old one entirely
- No backward-compatible shims or dual config formats
- Handler methods follow a consistent pattern: validate args, query/write database, return result

### Error Handling

- Never swallow errors silently - log with context using `console.error('[module] message:', error)`
- Module prefixes in log messages: `[sera-core]`, `[MCP]`, `[WS]`, etc.
- Return structured error results from MCP handlers via `errorResult(message)`
- Non-fatal errors (e.g., session persistence) log a warning and continue

### File Organization

- One class per file, file named after the class
- Handlers go in `src/mcp/handlers/`
- Tests go alongside source files as `FileName.test.ts`
- Integration and e2e tests go in `src/__test__/`

### Import Order

1. Node.js built-in modules (`http`, `path`, `fs`, `crypto`)
2. External dependencies (`express`, `ws`, `sql.js`)
3. `@sera/types` imports
4. Local imports (relative paths)

Blank line between each group.

## 6. Commit Strategy

Use Conventional Commits. One logical change per commit.

### Format

```
<type>(<scope>): <subject>

<body>
```

### Types

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `docs` | Documentation changes |
| `chore` | Build, CI, tooling changes |

### Scope

Always use `sera-core` as the scope:

```
feat(sera-core): add credential injection to agent executor
fix(sera-core): handle stale PID file on startup
test(sera-core): add StorageEngine flush cycle tests
docs(sera-core): add developer guide for MCP protocol
```

### Rules

- Present tense ("add feature" not "added feature")
- No period at end of subject line
- Subject line under 72 characters
- Never include co-author footers or attribution
- Never commit code that does not compile
- Commit after each logical unit of work completes

## 7. Testing

### Test Runner

Vitest with the following configuration:

- Root: project directory
- Include: `src/**/*.test.ts`
- Timeout: 30 seconds
- Single fork mode (serial execution)

### Test Standards

- **Test behavior, not implementation** - tests verify what code does, not how
- **Test edges and errors** - empty inputs, boundaries, malformed data, missing files
- **Mock boundaries, not logic** - only mock network, filesystem, time, or external services
- **Verify tests catch failures** - break the code, confirm the test fails, then fix

### What to Test

| Module | Test Focus |
|--------|-----------|
| StorageEngine | Table creation, write/query/delete, flush cycle, schema versioning |
| EventBridge | Subscription matching, pattern filtering, source exclusion, recording |
| CredentialStore | Encryption roundtrip, migration, key storage permissions |
| AuditRegistry | Workspace mapping, slug generation, metadata persistence |
| AgentExecutor | Process spawning, credential injection, timeout, output capture |
| MCP Handlers | Tool call processing, database writes, error cases |
| Config | Default values, file loading, deep merge, environment overrides |
| LogBuffer | Circular buffer behavior, capacity limits |

### Test File Location

- Unit tests: `src/module/FileName.test.ts` (next to source)
- Integration tests: `src/__test__/`

### Running Tests

```bash
npm test                    # Run all tests once
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
```

## 8. Documentation

### Structure

```
docs/
├── todo.md                           # Documentation and spec tracker
├── developer-guide/
│   ├── 01-architecture-overview.md   # System design and module layout
│   ├── 02-integration-points.md      # How sera-core connects to IDE, dashboards, agents
│   ├── 03-event-bridge.md            # Pub/sub event distribution
│   ├── 04-mcp-protocol.md            # MCP server, handlers, tool dispatch
│   ├── 05-storage-engine.md          # Database layer and schema system
│   ├── 06-credential-management.md   # Encrypted vault and credential injection
│   └── 07-agent-execution.md         # Agent spawning and lifecycle
├── user-manual/
│   ├── 01-installation.md            # Setup and first run
│   ├── 02-cli-reference.md           # CLI commands
│   └── 03-deployment.md              # Deployment and IDE connection
└── specs/                            # Feature specifications (added as needed)
```

### Documentation Maintenance

- **Update docs when behavior changes** - if you modify a module's behavior, update the corresponding developer guide entry
- **Keep todo.md current** - mark completed items, add new specs when planned
- **Numbered prefixes** - files are numbered for reading order (high-level first, then detailed)
- **Specs follow the pattern** from agent-designer and benchmarker-dashboard: numbered, with status, dependencies, and verification steps

### Adding a New Spec

Create `docs/specs/NN-slug-name.md` with:

```markdown
# Spec NN: Title

**Status**: Pending
**Depends on**: Spec XX (if applicable)

## Problem

What needs to change and why.

## Solution

High-level approach.

## Design

Technical details.

## Files to Create/Modify

### File: src/path/to/file.ts
- What changes

### File: src/path/to/file.test.ts
1. Test case description
2. Test case description

## Verification

- `npm run compile` succeeds
- `npm test` passes
- Specific behavior verified
```

## 9. MCP Handler Development

### Adding a New Handler

1. Create `src/mcp/handlers/MyHandler.ts` implementing `PortableMcpHandler`
2. Define tool schemas via `getToolDefinitions()`
3. Declare required tables via `getRequiredTableSchemas()`
4. Implement `handleToolCall()` with the tool dispatch logic
5. Register in `server.ts` via `this.mcpServer.registerHandler(new MyHandler())`
6. Add tests in `src/mcp/handlers/MyHandler.test.ts`
7. Update `docs/developer-guide/04-mcp-protocol.md` handler table

### Handler Checklist

- [ ] Implements `PortableMcpHandler` interface from `@sera/types`
- [ ] All tools have descriptive `name`, `description`, and complete `inputSchema`
- [ ] Required tables declared with versioned schemas
- [ ] Error cases return structured error results
- [ ] Tests cover happy path, validation errors, and edge cases
- [ ] Registered in `server.ts`
- [ ] Documentation updated

## 10. Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | This file - project development configuration |
| `package.json` | Dependencies and npm scripts |
| `tsconfig.json` | TypeScript compiler configuration |
| `vitest.config.ts` | Test runner configuration |
| `src/server.ts` | Daemon entry point |
| `src/cli.ts` | CLI entry point |
| `src/config.ts` | Configuration loading |
| `src/mcp/MCPServer.ts` | MCP protocol dispatcher |
| `src/database/StorageEngine.ts` | Per-audit SQLite database |
| `src/events/EventBridge.ts` | Cross-client event distribution |
| `docs/todo.md` | Documentation and spec tracker |
