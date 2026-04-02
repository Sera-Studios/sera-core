# Spec 2: Service Monitoring & Observability

**Status:** Pending
**Epic:** 2 - Infrastructure & Access
**Depends on:** None

## Overview

Add structured logging, request metrics, enhanced health checks, and alerting hooks to sera-core. This provides the observability layer needed for cloud deployment (Phase D) and day-to-day operational visibility.

## Structured Logging

### Current State

Logs use `console.log` / `console.error` with module prefixes:
```
[sera-core] Starting on port 9800
[MCP] Tool call: submit_finding (session: abc123)
[WS] Client connected from 127.0.0.1
```

### Target State

Replace `console.*` with a structured logger that outputs JSON in production and formatted text in development:

```typescript
// src/logging/Logger.ts

interface LogEntry {
  timestamp: string;    // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;       // sera-core, mcp, ws, rest, benchmark
  message: string;
  data?: Record<string, unknown>;  // structured context
}

class Logger {
  constructor(
    private module: string,
    private format: 'json' | 'text' = 'text',
    private minLevel: string = 'info',
  ) {}

  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;

  child(module: string): Logger;  // create sub-logger with inherited config
}
```

**JSON output** (production):
```json
{"timestamp":"2026-03-04T08:30:00.123Z","level":"info","module":"mcp","message":"Tool call","data":{"tool":"submit_finding","session":"abc123","durationMs":45}}
```

**Text output** (development):
```
08:30:00.123 [mcp] INFO  Tool call tool=submit_finding session=abc123 durationMs=45
```

Format is controlled by config: `{ "logging": { "format": "json", "level": "info" } }`.

No external dependencies - this is a simple wrapper around `process.stdout.write`.

## Request Metrics

### Metrics Collector

Track per-request metrics in memory with periodic aggregation:

```typescript
// src/monitoring/MetricsCollector.ts

interface RequestMetric {
  timestamp: number;
  method: string;       // GET, POST
  path: string;         // /api/resources, /mcp
  statusCode: number;
  durationMs: number;
  toolName?: string;    // for MCP tool calls
}

class MetricsCollector {
  private metrics: RequestMetric[] = [];
  private readonly maxEntries = 10000;  // circular buffer

  record(metric: RequestMetric): void;

  // Aggregation queries
  getRecentErrors(minutes: number): RequestMetric[];
  getAverageLatency(path: string, minutes: number): number;
  getToolCallCounts(minutes: number): Record<string, number>;
  getStatusCodeDistribution(minutes: number): Record<number, number>;
  getSummary(minutes: number): MetricsSummary;
}
```

### Express Middleware

```typescript
// src/api/metricsMiddleware.ts

function createMetricsMiddleware(collector: MetricsCollector) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      collector.record({
        timestamp: start,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  };
}
```

### MCP Tool Call Tracking

In `MCPServer.ts`, record tool name alongside the request metric:

```typescript
// After tool call completes
metricsCollector.record({
  timestamp: Date.now(),
  method: 'POST',
  path: '/mcp',
  statusCode: 200,
  durationMs: elapsed,
  toolName: toolName,
});
```

## Enhanced Health Check

### Current

`GET /health` returns `{ status: 'ok' }`.

### Enhanced

`GET /health` returns dependency-level health:

```json
{
  "status": "healthy",
  "uptime": 86400,
  "version": "0.1.0",
  "checks": {
    "database": { "status": "healthy", "activeAudits": 3 },
    "credentialStore": { "status": "healthy" },
    "agentStore": { "status": "healthy", "agentsLoaded": 5 },
    "benchmarkDb": { "status": "healthy", "contests": 12 }
  },
  "metrics": {
    "requestsLastHour": 1247,
    "errorsLastHour": 3,
    "avgLatencyMs": 12.4,
    "topTools": [
      { "name": "submit_finding", "calls": 89 },
      { "name": "list_findings", "calls": 67 }
    ]
  }
}
```

Status is `"degraded"` if any check fails non-critically, `"unhealthy"` if a critical dependency (database) is down.

### Detailed Metrics Endpoint

`GET /health/metrics` returns full metrics summary (separate from the lightweight health check):

```json
{
  "period": { "minutes": 60 },
  "requests": {
    "total": 1247,
    "byStatus": { "200": 1230, "400": 14, "500": 3 },
    "byPath": {
      "/mcp": { "count": 890, "avgLatencyMs": 15.2 },
      "/api/resources": { "count": 234, "avgLatencyMs": 8.1 }
    }
  },
  "toolCalls": {
    "total": 890,
    "byTool": {
      "submit_finding": { "count": 89, "avgLatencyMs": 22.3 },
      "list_findings": { "count": 67, "avgLatencyMs": 8.1 }
    }
  },
  "errors": [
    { "timestamp": "2026-03-04T08:15:00Z", "path": "/mcp", "tool": "submit_finding", "statusCode": 500 }
  ]
}
```

## Event Audit Log

Track significant system events in a log table for security and debugging:

```typescript
const eventLogSchema: TableSchema = {
  name: 'event_log',
  version: '1',
  fields: [
    { name: 'id', type: 'INTEGER', required: true, primaryKey: true },
    { name: 'timestamp', type: 'TEXT', required: true },
    { name: 'event_type', type: 'TEXT', required: true },   // auth, tool_call, error, config_change, agent_register
    { name: 'source_ip', type: 'TEXT' },
    { name: 'detail', type: 'JSON' },
  ],
  indexes: [
    { fields: ['event_type'] },
    { fields: ['timestamp'] },
  ],
};
```

Events to log:
- Authentication attempts (success/failure)
- Agent registration/unregistration
- Configuration changes
- Server start/stop
- Error occurrences (500s)
- Benchmark run start/complete

This table lives in a global database (not per-audit), similar to `benchmarks.db`. Could be a new `system.db` or added to `benchmarks.db`.

## Alerting Hooks

Simple webhook-based alerting for critical events:

```typescript
// Configuration
{
  "monitoring": {
    "alerts": {
      "enabled": false,
      "webhookUrl": "https://hooks.slack.com/services/...",
      "thresholds": {
        "errorRatePerMinute": 10,
        "avgLatencyMs": 5000,
        "consecutiveFailedHealthChecks": 3
      }
    }
  }
}
```

When a threshold is breached, POST a JSON payload to the webhook URL:

```json
{
  "service": "sera-core",
  "alert": "error_rate_exceeded",
  "threshold": 10,
  "actual": 15,
  "timestamp": "2026-03-04T08:30:00Z",
  "message": "Error rate exceeded threshold: 15 errors/min (threshold: 10)"
}
```

Implementation: A `MonitoringService` runs a check loop every 60 seconds, compares metrics against thresholds, and fires webhooks when breached. Includes a cooldown period (5 minutes) to prevent alert storms.

## MCP Tools

### `system_health`

```typescript
{
  name: 'system_health',
  description: 'Get sera-core health status including dependency checks and recent metrics.',
  inputSchema: { type: 'object', properties: {} }
}
```

Returns the same data as `GET /health` - useful for Claude Code to check system status during autonomous operation.

### `system_metrics`

```typescript
{
  name: 'system_metrics',
  description: 'Get detailed request metrics for a time period.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: 'Lookback period in minutes (default: 60)' }
    }
  }
}
```

## Key Files

| File | Change |
|------|--------|
| `src/logging/Logger.ts` | **New** - Structured logger |
| `src/monitoring/MetricsCollector.ts` | **New** - Request metrics collector |
| `src/monitoring/MonitoringService.ts` | **New** - Health checks, alert evaluation loop |
| `src/api/metricsMiddleware.ts` | **New** - Express metrics recording middleware |
| `src/server.ts` | Initialize Logger, MetricsCollector, MonitoringService; mount middleware |
| `src/mcp/MCPServer.ts` | Add tool call metrics recording |
| `src/config.ts` | Add `logging` and `monitoring` config sections |
| `src/api/RestAPI.ts` | Enhanced `/health` and new `/health/metrics` endpoints |
| `src/mcp/handlers/SystemHandler.ts` | **New** - system_health, system_metrics tools |

## Validation Checklist

- [ ] Logger outputs JSON in json mode, formatted text in text mode
- [ ] Log level filtering works (debug messages not shown at info level)
- [ ] Request metrics recorded for REST and MCP endpoints
- [ ] Tool call names tracked in MCP metrics
- [ ] `/health` returns dependency status and basic metrics
- [ ] `/health/metrics` returns detailed request/tool metrics
- [ ] Event audit log records auth attempts and errors
- [ ] Alert webhooks fire when thresholds breached
- [ ] Alert cooldown prevents storms
- [ ] `system_health` and `system_metrics` MCP tools work
- [ ] Config changes for logging/monitoring respected
- [ ] Existing functionality unaffected
- [ ] `npm run compile` and `npm test` pass
