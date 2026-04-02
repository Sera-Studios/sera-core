# Epic 1: Resource & Role Management

## Vision

Audit knowledge - roles, primers, references, articles - currently lives as markdown files scattered across `resources/` in the mono-repo filesystem. This works for manual use but breaks down when the agent-designer and autonomous pipeline need to discover, reference, and modify these resources programmatically.

This epic moves resources into sera-core's database with full CRUD via REST and MCP. The designer references resources by ID instead of filesystem path. Claude Code can read, modify, and create resources during the autonomous iteration loop (e.g., "refine the hunter role to emphasize reentrancy patterns").

## Current State

```
resources/
├── roles/
│   ├── solidity/
│   │   ├── hunter.md
│   │   └── cartographer.md
│   └── (planned: rust-solana/, rust-offchain/, reverse-engineering/)
├── primers/
│   ├── amm.md
│   ├── lending.md
│   └── ...
├── references/
│   ├── reentrancy-patterns.md
│   └── ...
└── reports/
    └── ...
```

- Files are read by the VS Code extension and agent roles directly
- No API for discovery, search, or modification
- No tagging, versioning, or metadata
- Agent-designer can reference role files by path but has no MCP access to their content
- Adding Solana resources means adding more directories manually

## Target State

```
sera-core database (per-instance, not per-audit)
├── resources table
│   ├── type: role | primer | reference | article | report
│   ├── language: solidity | rust-solana | rust-offchain | any
│   ├── tags: ["reentrancy", "lending", "access-control", ...]
│   ├── content: markdown text
│   ├── metadata: { version, author, ... }
│   └── timestamps
│
├── REST API: /api/resources
│   ├── GET    /api/resources              (list, filter by type/language/tags)
│   ├── GET    /api/resources/:id          (get full content)
│   ├── POST   /api/resources              (create)
│   ├── PATCH  /api/resources/:id          (update content or metadata)
│   └── DELETE /api/resources/:id          (remove)
│
└── MCP Tools
    ├── list_resources      (discover available resources)
    ├── get_resource        (read full content)
    ├── create_resource     (add new resource)
    ├── update_resource     (modify content or metadata)
    └── delete_resource     (remove)
```

## Spec Index

| # | Spec | Description | Status | Dependencies |
|---|------|-------------|--------|--------------|
| 0 | Epic Overview | This document | Active | - |
| 0.5 | Agent Role Classification | Add `roles: AgentRole[]` to AgentRegistration | Complete | - |
| 1 | Resource Storage Tables | Database schema, migration from filesystem, seed data | Pending | - |
| 2 | Resource CRUD REST & MCP Tools | REST endpoints + MCP tools for resource management | Pending | 1 |
| 3 | Version Lineage & Experiment Tracking | Agent version history, experiment records, morning report data | Pending | - |
| 4 | Structured Output Schemas | Inter-agent data contracts (HunterFinding, JudgeVerdict, AuditReport) | Pending | 1 |

## Integration Points

### Agent Designer (Epic 5)
- `designer_get_node_catalog` includes resource-channel nodes that reference sera-core resources by ID
- Instruction-channel sources (role-file, context-document) resolve content from sera-core instead of filesystem
- Tool channel MCP discovery already queries sera-core; resource discovery follows the same pattern

### Benchmarker Dashboard
- Contest imports can auto-tag relevant primers and references
- Agent profiling can track which resources were used during a run

### VS Code Extension
- Extension reads resources from sera-core REST instead of filesystem
- Enables remote/cloud scenarios where the filesystem isn't local

### Autonomous Loop (Designer Epic 5)
- Claude Code uses `update_resource` to refine role content between iterations
- Claude Code uses `list_resources` to find relevant primers for a contest's domain
- Resources are versioned so changes can be tracked and reverted

## Migration Strategy

Filesystem resources aren't deleted. sera-core seeds its database from `resources/` on first boot (or via a CLI command). After that, the database is the source of truth. The filesystem copy remains for version control and manual editing, with a `sync` command to push filesystem changes into the database.

```
# One-time seed
sera-core seed-resources --source ./resources/

# Ongoing sync (optional)
sera-core sync-resources --source ./resources/ --direction fs-to-db
```
