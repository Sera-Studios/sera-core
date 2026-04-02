# Spec 3: Agent Version Lineage & Experiment Tracking

**Status:** Pending
**Epic:** 1 - Resource & Role Management
**Depends on:** None (uses existing AgentRegistrationStore, extends BenchmarkStore)

## Overview

Track agent version lineage and experiment history. When the autonomous loop modifies an agent (role refinement, tool change, primer attachment), the system records what changed, why, and whether it improved performance. This is the data source for Phase D's morning report and for human review of automated agent evolution.

## Problem

Current state:
- Agent registrations are JSON files in `~/.sera/agents/{id}.json` with a `version` string
- `benchmark_results` stores `agent_version` but has no concept of "version N derived from version N-1"
- No record of what changed between versions
- No hypothesis tracking ("added reentrancy primer to improve recall on reentrancy findings")
- No way to query "show me all experiments that improved recall by >5%"

The autonomous loop (Designer Epic 5) needs this data to:
1. Know which version to start from (best-performing)
2. Record what modification was applied
3. Compare before/after results
4. Decide whether to keep or revert
5. Generate human-readable experiment summaries

## Database Schema

### Table: `agent_versions`

Stored in `benchmarks.db` (global, not per-audit):

```typescript
const agentVersionsSchema: TableSchema = {
  name: 'agent_versions',
  version: '1',
  fields: [
    { name: 'id', type: 'TEXT', required: true, primaryKey: true },          // uuid
    { name: 'agent_id', type: 'TEXT', required: true },                      // e.g., "hunter-trace-v3"
    { name: 'version', type: 'TEXT', required: true },                       // semver, e.g., "0.3.0"
    { name: 'parent_version_id', type: 'TEXT' },                             // FK to agent_versions.id (null for root)
    { name: 'created_at', type: 'TEXT', required: true },                    // ISO timestamp
    { name: 'created_by', type: 'TEXT', required: true },                    // "human" | "autonomous-loop" | "claude-code"
    { name: 'registration_snapshot', type: 'JSON' },                         // full AgentRegistration at this version
    { name: 'resources_snapshot', type: 'JSON' },                            // { roleId, primerIds[], referenceIds[] }
  ],
  indexes: [
    { fields: ['agent_id'] },
    { fields: ['parent_version_id'] },
    { fields: ['agent_id', 'version'], unique: true },
  ],
};
```

### Table: `experiments`

Tracks individual modification attempts:

```typescript
const experimentsSchema: TableSchema = {
  name: 'experiments',
  version: '1',
  fields: [
    { name: 'id', type: 'TEXT', required: true, primaryKey: true },          // uuid
    { name: 'agent_id', type: 'TEXT', required: true },
    { name: 'base_version_id', type: 'TEXT', required: true },               // FK to agent_versions.id
    { name: 'result_version_id', type: 'TEXT' },                             // FK to agent_versions.id (set after creation)
    { name: 'hypothesis', type: 'TEXT', required: true },                    // what we expect to improve
    { name: 'modification_type', type: 'TEXT', required: true },             // see Modification Types below
    { name: 'modification_detail', type: 'JSON', required: true },           // type-specific change description
    { name: 'status', type: 'TEXT', required: true },                        // pending | running | improved | regressed | neutral | reverted
    { name: 'started_at', type: 'TEXT', required: true },
    { name: 'completed_at', type: 'TEXT' },
    { name: 'benchmark_run_ids', type: 'JSON' },                            // array of run IDs used to evaluate
    { name: 'before_metrics', type: 'JSON' },                               // { score, recall, precision, f1 }
    { name: 'after_metrics', type: 'JSON' },                                // { score, recall, precision, f1 }
    { name: 'delta', type: 'JSON' },                                        // { score: +3.2, recall: +0.04, ... }
    { name: 'verdict', type: 'TEXT' },                                       // human or auto: "keep" | "revert" | "investigate"
    { name: 'notes', type: 'TEXT' },                                         // human notes or auto-generated summary
  ],
  indexes: [
    { fields: ['agent_id'] },
    { fields: ['base_version_id'] },
    { fields: ['status'] },
    { fields: ['modification_type'] },
  ],
};
```

### Modification Types

| Type | modification_detail Example |
|------|---------------------------|
| `role-refinement` | `{ "field": "content", "diff": "Added: 'Always check access control on external calls'" }` |
| `primer-attachment` | `{ "primerId": "lending-v2", "action": "add" }` |
| `primer-removal` | `{ "primerId": "amm-v1", "action": "remove" }` |
| `tool-addition` | `{ "toolName": "trace_read_slot", "server": "sera-core" }` |
| `tool-removal` | `{ "toolName": "trace_calls_from" }` |
| `model-change` | `{ "from": "claude-sonnet-4-6", "to": "claude-opus-4-6" }` |
| `resource-update` | `{ "resourceId": "ref-reentrancy", "field": "content", "summary": "Added flash loan variant" }` |
| `pipeline-restructure` | `{ "change": "Added second LLM for triage", "nodesDiff": {...} }` |
| `custom` | `{ "description": "..." }` |

## VersionStore

```typescript
// src/benchmark/VersionStore.ts

class VersionStore {
  constructor(private db: Database) {}

  // Version CRUD
  createVersion(params: {
    agentId: string;
    version: string;
    parentVersionId?: string;
    createdBy: string;
    registrationSnapshot: AgentRegistration;
    resourcesSnapshot?: ResourceSnapshot;
  }): string;  // returns version id

  getVersion(id: string): AgentVersion | null;
  getVersionsByAgent(agentId: string): AgentVersion[];
  getLatestVersion(agentId: string): AgentVersion | null;
  getLineage(versionId: string): AgentVersion[];  // walk parent chain to root

  // Experiment CRUD
  createExperiment(params: {
    agentId: string;
    baseVersionId: string;
    hypothesis: string;
    modificationType: string;
    modificationDetail: Record<string, unknown>;
  }): string;  // returns experiment id

  updateExperiment(id: string, update: Partial<Experiment>): void;
  getExperiment(id: string): Experiment | null;
  getExperimentsByAgent(agentId: string, opts?: { status?: string; limit?: number }): Experiment[];

  // Query helpers
  getBestVersion(agentId: string, metric?: string): AgentVersion | null;
  getExperimentSummary(agentId: string, since?: string): ExperimentSummary;
}
```

## MCP Tools

### `version_create_snapshot`

Called when a new agent version is created (by designer compile+register or autonomous loop):

```typescript
{
  name: 'version_create_snapshot',
  description: 'Record a new agent version with its parent lineage.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      version: { type: 'string' },
      parent_version_id: { type: 'string', description: 'Previous version this derives from' },
      created_by: { type: 'string', enum: ['human', 'autonomous-loop', 'claude-code'] },
    },
    required: ['agent_id', 'version', 'created_by']
  }
}
```

The tool auto-captures the current `AgentRegistration` from disk as `registration_snapshot`.

### `version_get_lineage`

```typescript
{
  name: 'version_get_lineage',
  description: 'Get the full version history for an agent, from latest to root.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      limit: { type: 'number', description: 'Max versions to return (default: 20)' }
    },
    required: ['agent_id']
  }
}
```

Returns:
```json
{
  "agentId": "hunter-trace",
  "versions": [
    {
      "id": "v-abc123",
      "version": "0.3.0",
      "parentVersionId": "v-xyz789",
      "createdAt": "2026-03-04T08:30:00Z",
      "createdBy": "autonomous-loop",
      "experimentId": "exp-456"
    }
  ]
}
```

### `experiment_create`

```typescript
{
  name: 'experiment_create',
  description: 'Start a new experiment: record hypothesis and modification before benchmarking.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      base_version_id: { type: 'string' },
      hypothesis: { type: 'string', description: 'What improvement is expected' },
      modification_type: { type: 'string', enum: ['role-refinement', 'primer-attachment', 'primer-removal', 'tool-addition', 'tool-removal', 'model-change', 'resource-update', 'pipeline-restructure', 'custom'] },
      modification_detail: { type: 'object', description: 'Type-specific change details' }
    },
    required: ['agent_id', 'base_version_id', 'hypothesis', 'modification_type', 'modification_detail']
  }
}
```

### `experiment_complete`

```typescript
{
  name: 'experiment_complete',
  description: 'Record experiment results after benchmarking. Compares before/after metrics and sets verdict.',
  inputSchema: {
    type: 'object',
    properties: {
      experiment_id: { type: 'string' },
      result_version_id: { type: 'string', description: 'The new version created for this experiment' },
      benchmark_run_ids: { type: 'array', items: { type: 'string' } },
      before_metrics: { type: 'object' },
      after_metrics: { type: 'object' },
      verdict: { type: 'string', enum: ['keep', 'revert', 'investigate'] },
      notes: { type: 'string' }
    },
    required: ['experiment_id', 'benchmark_run_ids', 'before_metrics', 'after_metrics', 'verdict']
  }
}
```

The tool auto-calculates `delta` from before/after metrics.

### `experiment_list`

```typescript
{
  name: 'experiment_list',
  description: 'List experiments for an agent with optional filters.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'running', 'improved', 'regressed', 'neutral', 'reverted'] },
      modification_type: { type: 'string' },
      limit: { type: 'number', description: 'Max results (default: 50)' }
    },
    required: ['agent_id']
  }
}
```

### `experiment_summary`

```typescript
{
  name: 'experiment_summary',
  description: 'Get a summary of experiments for an agent: total, success rate, top improvements, top regressions.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      since: { type: 'string', description: 'ISO date - only experiments after this date' }
    },
    required: ['agent_id']
  }
}
```

Returns:
```json
{
  "agentId": "hunter-trace",
  "period": { "since": "2026-03-03T00:00:00Z", "until": "2026-03-04T12:00:00Z" },
  "totalExperiments": 47,
  "improved": 12,
  "regressed": 8,
  "neutral": 22,
  "reverted": 5,
  "successRate": 0.255,
  "topImprovements": [
    { "id": "exp-123", "type": "tool-addition", "detail": "Added trace_read_slot", "delta": { "recall": 0.042 } },
    { "id": "exp-456", "type": "primer-attachment", "detail": "Added lending primer", "delta": { "recall": 0.031 } }
  ],
  "topRegressions": [
    { "id": "exp-789", "type": "model-change", "detail": "Switched to claude-haiku", "delta": { "score": -12.0 } }
  ],
  "netScoreChange": 6.2,
  "currentBestVersion": "0.23.0"
}
```

## MCP Handler

```typescript
// src/mcp/handlers/VersionHandler.ts

class VersionHandler implements PortableMcpHandler {
  readonly prefix = 'version';

  getToolDefinitions(): ToolDefinition[] {
    return [
      // version_create_snapshot, version_get_lineage,
      // experiment_create, experiment_complete, experiment_list, experiment_summary
    ];
  }

  getRequiredTableSchemas(): TableSchema[] {
    // These tables go in benchmarks.db, not per-audit
    // Handler needs access to BenchmarkStore's db instance
    return [agentVersionsSchema, experimentsSchema];
  }
}
```

Note: Since `benchmarks.db` is a global database (not per-audit), the handler either needs direct access to `BenchmarkStore`'s db instance, or the tables are initialized separately in `BenchmarkStore`. Follow the existing pattern where `BenchmarkStore` manages its own tables.

## Integration with Autonomous Loop

The autonomous loop (Designer Epic 5 Spec 2) uses these tools in sequence:

```
1. experiment_create(agent_id, base_version_id, hypothesis, modification)
2. [apply modification via designer MCP]
3. version_create_snapshot(agent_id, new_version, parent=base_version_id)
4. benchmarker_start_run(agent_id, contest_id)
5. [wait for completion]
6. experiment_complete(experiment_id, run_ids, before_metrics, after_metrics, verdict)
7. If verdict="revert": restore previous agent registration
8. experiment_summary(agent_id, since=today) -> morning report data
```

## Key Files

| File | Change |
|------|--------|
| `src/benchmark/VersionStore.ts` | **New** - Version and experiment persistence |
| `src/benchmark/BenchmarkStore.ts` | Add `agent_versions` and `experiments` tables |
| `src/mcp/handlers/VersionHandler.ts` | **New** - 6 MCP tools for version/experiment management |
| `src/server.ts` | Register VersionHandler |

## Validation Checklist

- [ ] `agent_versions` table created in benchmarks.db
- [ ] `experiments` table created in benchmarks.db
- [ ] Version lineage tracks parent chain correctly
- [ ] Experiment records hypothesis, modification type, and detail
- [ ] `experiment_complete` auto-calculates delta from before/after metrics
- [ ] `experiment_summary` returns correct aggregates
- [ ] `version_get_lineage` walks parent chain to root
- [ ] MCP tools registered and accessible
- [ ] Existing benchmark functionality unaffected
- [ ] `npm run compile` and `npm test` pass
