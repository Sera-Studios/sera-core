# Epic 2: Infrastructure & Access

## Vision

sera-core currently runs as a local daemon accessed only from the same machine. As the platform moves toward cloud execution (Phase D) and multi-device workflows, sera-core needs authentication for remote access and proper monitoring/observability for production operation.

This epic adds the infrastructure layer that enables sera-core to run as a persistent service accessible from anywhere - not just `localhost`.

## Current State

- No authentication - any process on localhost can call REST and MCP endpoints
- No health monitoring beyond the basic `/health` endpoint
- Logs go to stdout/stderr with no structured format
- No metrics collection (request latency, error rates, tool call frequency)
- No alerting on service degradation
- Dev stack script (`scripts/dev-stack.sh`) writes logs to `/tmp/` files

## Target State

```
sera-core (port 9800/9877)
├── Authentication
│   ├── API key authentication for REST + MCP endpoints
│   ├── Key management CLI (generate, list, revoke)
│   ├── Skip auth for localhost (opt-in)
│   └── SSH tunnel friendly (no complex auth flows)
│
└── Monitoring & Observability
    ├── Structured JSON logging with levels
    ├── Request metrics (latency, status, tool name)
    ├── Health check with dependency status
    ├── Event log for audit trail
    └── Alerting hooks (webhook on error threshold)
```

## Spec Index

| # | Spec | Description | Status | Dependencies |
|---|------|-------------|--------|--------------|
| 0 | Epic Overview | This document | Active | - |
| 1 | Authentication & Remote Access | API key auth, key management, localhost bypass | Pending | - |
| 2 | Service Monitoring & Observability | Structured logging, metrics, health checks, alerts | Pending | - |

## Design Decisions

### Why API Keys (Not OAuth/JWT)

- sera-core is a developer tool, not a multi-user SaaS
- One user, one key - no need for token refresh, scopes, or user management
- SSH tunnels are the primary remote access method - API key in header is sufficient
- Keys are stored in sera-core's existing encrypted credential vault (`CredentialStore`)
- Simple to implement, simple to use, simple to debug

### Why Not Skip Auth Entirely

- Cloud execution (Phase D) requires remote access
- Even on a local network, unsecured HTTP endpoints are a risk
- Audit data is sensitive - findings, vulnerabilities, source code references
- API keys are the minimum viable auth that enables remote access safely

## Cross-Epic Dependencies

- **Phase D (Cloud Execution)**: Cloud adapter needs authenticated access to sera-core
- **Designer / Benchmarker**: Will need to pass API keys when calling sera-core REST endpoints
- **VS Code Extension**: Will need to include API key in requests to sera-core
