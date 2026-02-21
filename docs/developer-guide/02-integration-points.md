# Integration Points

sera-core is the persistent backend that connects the Sera Audit Labs ecosystem. This document explains how it integrates with each service and package.

## Ecosystem Overview

```
+---------------------+     +---------------------+     +---------------------+
|  sera-studio-code   |     |   agent-designer    |     | benchmarker-dashboard|
|  (VS Code ext)      |     |   (Pipeline UI)     |     | (Evaluation UI)     |
+----------+----------+     +----------+----------+     +----------+----------+
           |                           |                            |
      WebSocket :9800            WebSocket :9800              WebSocket :9800
           |                           |                            |
           +-----------+---------------+----------------------------+
                       |
              +--------v--------+
              |    sera-core    |
              |   (daemon)      |
              +--------+--------+
                       |
              MCP HTTP :9877
                       |
              +--------v--------+
              |  Claude Code    |
              |  (agents)       |
              +-----------------+
```

## sera-studio-code (VS Code Extension)

**Location**: `../../packages/sera-studio-code/`

**Connection**: WebSocket on port 9800

The VS Code extension is the primary UI client. It connects to sera-core over WebSocket for real-time audit data synchronization.

### How It Connects

1. Extension activates and connects to `ws://localhost:9800`
2. Sends a `connect` message with a client identifier
3. Sends `audit-selected` or `audit-create` when the user opens a workspace
4. Subscribes to table patterns (e.g., `sessionbridge:*`, `notepad:*`)
5. Receives `storage:update` push messages when agents write data

### What It Gets From sera-core

| Data | Source Handler | Tables |
|------|---------------|--------|
| Agent sessions | CoreHandler | `claude_sessions`, `heartbeats` |
| POIs, issues, comments | NotepadHandler | `notepad_pois`, `notepad_issues`, `notepad_comments` |
| Contract maps, flow diagrams | CoreHandler | `visualizations` |
| Quiz questions and grades | QuizHandler | `quiz_questions`, `quiz_grades` |
| Test mappings and coverage | TestCoverageHandler | `test_mappings`, `test_requests` |
| Call graph traces | TraceHandler | `cartography_repos`, `cartography_nodes`, `cartography_edges` |
| Session statistics | StatsHandler | `aggregate_stats`, `session_records` |

### What It Sends To sera-core

| Operation | Message Type | Purpose |
|-----------|-------------|---------|
| Create audit | `audit-create` | Register a new audit workspace |
| Select audit | `audit-selected` | Switch active audit context |
| Storage operations | `storage:write`, `storage:query` | Read/write applet data |
| Subscribe | `subscribe` | Register for real-time table updates |

### MCP Configuration

The extension configures Claude Code agents to connect to sera-core's MCP server. This is done via `.mcp.json` in the workspace root:

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

The audit slug in the URL scopes all agent tool calls to the correct audit database.

## agent-designer (Pipeline Designer)

**Location**: `../agent-designer/`

**Connection**: WebSocket on port 9800

The agent-designer is a React-based visual pipeline editor. It connects to sera-core for agent registration data and pipeline execution status.

### How It Connects

1. Connects via WebSocket to `ws://localhost:9800`
2. Queries agent registrations via REST API (`GET /api/agents`)
3. Subscribes to execution status updates

### What It Gets From sera-core

| Data | Source | Purpose |
|------|--------|---------|
| Agent registrations | AgentRegistrationStore via REST | Available agent definitions for pipeline nodes |
| Execution results | AgentExecutor via REST | Status of spawned agent processes |
| Credential providers | CredentialStore via REST | Available API keys for agent configuration |

### What It Sends To sera-core

| Operation | Endpoint | Purpose |
|-----------|----------|---------|
| Register agent | `POST /api/agents` | Save new agent definitions |
| Launch agent | `POST /api/agents/:id/execute` | Spawn agent subprocess |
| Stop agent | `POST /api/agents/:id/stop` | Terminate running agent |

## benchmarker-dashboard (Evaluation Dashboard)

**Location**: `../benchmarker-dashboard/`

**Connection**: WebSocket on port 9800

The benchmarker dashboard displays audit contest evaluations and agent performance metrics.

### How It Connects

1. Connects via WebSocket to `ws://localhost:9800`
2. Queries contest and finding data via REST API
3. Subscribes to evaluation result updates

### What It Gets From sera-core

| Data | Source | Purpose |
|------|--------|---------|
| Contests | BenchmarkStore via REST | List of audit contests with metadata |
| Known findings | BenchmarkStore via REST | Ground-truth vulnerabilities for evaluation |
| Benchmark runs | BenchmarkStore via REST | Execution results per agent per contest |
| Evaluation scores | BenchmarkStore via REST | Scoring against known findings |

### What It Sends To sera-core

| Operation | Endpoint | Purpose |
|-----------|----------|---------|
| Import contest | `POST /api/benchmarks/import` | Import Sherlock contest data |
| Run benchmark | `POST /api/benchmarks/run` | Execute agent against contest |
| Evaluate | `POST /api/benchmarks/evaluate` | Score agent findings |

## Claude Code Agents

**Connection**: HTTP JSON-RPC on port 9877

Claude Code agents (Hunter, Tester, Cartographer, Visualizer) connect via the MCP protocol to submit audit findings and track session state.

### Agent Lifecycle

1. Agent calls `register_agent` with name and version
2. Receives `agent_id` for session tracking
3. Uses `agent_id` on all subsequent tool calls
4. Tools write to the per-audit database
5. EventBridge pushes updates to subscribed UI clients

### Available Tool Categories

| Category | Tools | Handler |
|----------|-------|---------|
| Session | `register_agent`, `heartbeat`, `log_conversation_summary`, `log_prompt` | CoreHandler |
| Notepad | `submit_poi`, `submit_notepad_issue`, `submit_comment`, `reply_to_note`, `answer_question` | NotepadHandler |
| Visualization | `submit_contract_map`, `submit_flow_diagram` | CoreHandler |
| Quiz | `submit_quiz_question`, `get_pending_grades`, `grade_quiz_answer` | QuizHandler |
| Testing | `submit_test_mapping`, `get_test_mappings`, `update_test_mapping`, `clear_test_mappings`, `mark_test_complete`, `report_test_failure` | TestCoverageHandler |
| Statistics | `save_stats`, `get_stats`, `save_session`, `get_sessions`, `save_intervention` | StatsHandler |
| Tracing | `trace_calls_to`, `trace_calls_from`, `trace_interacting_functions`, `trace_read_slot`, `trace_write_slot` | TraceHandler |
| Agents | `list_agent_registrations` | AgentHandler |
| Debug | `get_debug_log`, `list_debug_sessions`, `get_recorded_events`, `clear_recorded_events` | DebugHandler |

## Shared Types

All services share type definitions from `@sera/types` (`../../packages/sera-types/`). Key interfaces include:

| Type | Used By | Purpose |
|------|---------|---------|
| `McpToolDefinition` | MCPServer, all handlers | Tool schema for MCP protocol |
| `McpToolResult` | MCPServer, all handlers | Tool response format |
| `PortableMcpHandler` | All handlers | Handler interface contract |
| `HandlerContext` | All handlers | Per-call scoped database and bridge access |
| `BridgeEvent` | EventBridge, WebSocketAPI | Custom event payload |
| `StorageUpdatePushMessage` | EventBridge, WebSocketAPI | Real-time data sync message |

## Port Summary

| Port | Service | Protocol | Consumer |
|------|---------|----------|----------|
| 9800 | Client server | HTTP + WebSocket | VS Code, agent-designer, benchmarker-dashboard |
| 9877 | MCP server | HTTP JSON-RPC | Claude Code agents |
| 9878 | Debug MCP server | HTTP JSON-RPC | Debug tools (testnet mode only) |
