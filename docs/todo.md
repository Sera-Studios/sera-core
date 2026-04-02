# sera-core - Tracker

## Documentation

- [x] Developer Guide: Architecture Overview
- [x] Developer Guide: Integration Points
- [x] Developer Guide: Event Bridge
- [x] Developer Guide: MCP Protocol
- [x] Developer Guide: Storage Engine
- [x] Developer Guide: Credential Management
- [x] Developer Guide: Agent Execution
- [x] User Manual: Installation & Setup
- [x] User Manual: CLI Reference
- [x] User Manual: Deployment & IDE Connection

## Epic 1: Resource & Role Management

Move audit knowledge (roles, primers, references) from filesystem into sera-core database with CRUD via REST and MCP. Specs in `docs/specs/epic-1/`.

- [x] Spec 0.5 - Agent role classification (add `roles: AgentRole[]` to AgentRegistration)
- [x] Spec 01 - Resource storage tables (database schema, filesystem seed, tag extraction)
- [x] Spec 02 - Resource CRUD REST & MCP tools (list, get, create, update, delete)
- [x] Spec 03 - Agent version lineage & experiment tracking (version history, experiment records)
- [x] Spec 04 - Structured output schemas (HunterFinding, JudgeVerdict, AuditReport contracts)

## Epic 2: Infrastructure & Access

Authentication for remote access and monitoring/observability for production operation. Specs in `docs/specs/epic-2/`.

- [x] Spec 01 - Authentication & remote access (API key auth, key management CLI, localhost bypass)
- [x] Spec 02 - Service monitoring & observability (structured logging, metrics, health checks, alerts)
