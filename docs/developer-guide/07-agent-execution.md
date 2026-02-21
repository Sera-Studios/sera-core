# Agent Execution

The AgentExecutor manages spawning agent subprocesses with credential injection, timeout enforcement, and output capture.

## Overview

```
AgentExecutor
  ├── CredentialStore  (decrypts API keys for injection)
  ├── AgentRegistrationStore  (loads agent definitions)
  └── Spawned Processes
       ├── stdout capture
       ├── stderr capture
       └── timeout enforcement
```

## Agent Registration

Agent definitions are JSON files stored in `~/.sera/agents/` (or a custom resources directory). Each file describes an agent's execution requirements:

```json
{
  "id": "my-hunter-agent",
  "name": "Custom Hunter",
  "execution": {
    "type": "script",
    "interpreter": "python3",
    "scriptPath": "/path/to/agent.py",
    "args": ["--mode", "hunt"],
    "timeout": 300,
    "credentials": ["openai"]
  }
}
```

### Registration Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique agent identifier |
| `name` | Yes | Human-readable name |
| `execution.type` | Yes | Execution type (currently `script` only) |
| `execution.interpreter` | Yes | Command to run the script (e.g., `python3`, `node`) |
| `execution.scriptPath` | Yes | Path to the agent script |
| `execution.args` | No | Additional command-line arguments |
| `execution.timeout` | No | Timeout in seconds (overridable at launch) |
| `execution.credentials` | No | Provider names for credential injection |

### AgentRegistrationStore Operations

| Method | Description |
|--------|-------------|
| `loadFromDisk()` | Scan `~/.sera/agents/` for `.json` files and load them |
| `register(registration, persist?)` | Add to memory, optionally write to disk |
| `get(id)` | Get registration by ID |
| `getAll()` | Get all registrations |
| `listIds()` | Get all registered IDs |
| `unregister(id)` | Remove from memory (does not delete file) |
| `reload()` | Clear and reload from disk |

## Launching an Agent

### launch() Method

```typescript
const handle = await agentExecutor.launch(agentId, {
  workspacePath: '/path/to/workspace',
  timeout: 600,           // Override registration timeout
  args: ['--verbose'],    // Additional args appended to registration args
});
```

### Launch Process

1. **Validate** - Look up registration by ID, verify it exists
2. **Build arguments** - `[scriptPath, --workspace, workspacePath, ...registrationArgs, ...overrideArgs]`
3. **Inject credentials** - Decrypt requested credentials from vault, set as environment variables
4. **Spawn process** - Use `child_process.spawn()` with the interpreter
5. **Capture output** - Collect stdout and stderr into buffers
6. **Enforce timeout** - Send SIGTERM after timeout expires
7. **Track execution** - Store handle in internal map by instance ID

### AgentHandle

The returned handle provides a snapshot of the execution state:

```typescript
interface AgentHandle {
  instanceId: string;     // Unique execution instance ID
  agentId: string;        // Agent registration ID
  status: 'running' | 'completed' | 'failed' | 'timeout';
  pid?: number;           // Process ID
  startedAt: Date;
  completedAt?: Date;
  exitCode?: number;
}
```

## Managing Running Agents

### Get Status

```typescript
const handle = agentExecutor.get(instanceId);
```

Returns the current handle snapshot or undefined.

### Get Output

```typescript
const output = agentExecutor.getOutput(instanceId);
// { stdout: string, stderr: string }
```

Returns captured stdout and stderr.

### Stop Agent

```typescript
agentExecutor.stop(instanceId);
```

Sends SIGTERM to the agent process.

### List All

```typescript
const handles = agentExecutor.listAll();
```

Returns all tracked handles (running and completed).

## Credential Injection

When an agent registration specifies required credentials, the executor:

1. Queries `CredentialStore.getByProvider(provider)` for each provider
2. For each matching credential, sets an environment variable:
   - Variable name: derived from provider and credential name
   - Variable value: the decrypted API key
3. The subprocess inherits these variables in its environment

Credentials are only available in the subprocess environment and are not written to disk or logs.

## REST API

Agent execution is managed via the REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all registered agents |
| GET | `/api/agents/:id` | Get agent registration |
| POST | `/api/agents` | Register a new agent |
| POST | `/api/agents/:id/execute` | Launch an agent |
| GET | `/api/agents/:id/executions` | List executions for an agent |
| GET | `/api/executions/:instanceId` | Get execution status |
| GET | `/api/executions/:instanceId/output` | Get execution output |
| POST | `/api/executions/:instanceId/stop` | Stop a running execution |
