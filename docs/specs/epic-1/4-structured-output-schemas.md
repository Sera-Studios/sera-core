# Spec 4: Structured Output Schemas

**Status:** Pending
**Epic:** 1 - Resource & Role Management
**Depends on:** Spec 1 (Resource Storage Tables)

## Overview

Define and store structured output schemas that govern inter-agent data contracts. When a hunter produces findings and a judge consumes them, both sides must agree on the data format. These schemas are stored as resources in sera-core (type: `schema`) and referenced by the agent-designer's output and communication channels.

## Problem

Currently, output formats are implicit:
- Hunters produce findings as JSON or markdown - the format is baked into the evaluator
- The markdown parser (`markdown-parser.ts`) and JSON collector in the benchmarker assume specific field names
- Judge agents (Designer Epic 6 Spec 2) need to consume hunter output - but there's no formal contract
- If a hunter's output structure drifts (e.g., renames `severity` to `risk_level`), downstream agents break silently
- The autonomous loop can't verify output compatibility between agents in a pair

## Schema as Resource

Output schemas are stored as resources with `type: 'schema'`:

```typescript
// Example: HunterFinding schema stored as a resource
{
  id: 'schema-hunter-finding',
  type: 'schema',
  language: 'any',
  name: 'Hunter Finding',
  slug: 'hunter-finding',
  tags: ['hunter', 'output', 'finding'],
  content: JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'HunterFinding',
    type: 'object',
    required: ['title', 'severity', 'description'],
    properties: {
      id: { type: 'string', description: 'Unique finding identifier' },
      title: { type: 'string', description: 'One-line finding title' },
      severity: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low', 'informational', 'gas'],
      },
      description: { type: 'string', description: 'Detailed vulnerability description' },
      impact: { type: 'string', description: 'What could go wrong' },
      recommendation: { type: 'string', description: 'How to fix it' },
      affectedFiles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
          },
          required: ['path'],
        },
      },
      codeSnippet: { type: 'string', description: 'Relevant code excerpt' },
      references: { type: 'array', items: { type: 'string' } },
    },
  }, null, 2),
  version: 1,
  metadata: {
    schemaVersion: 'draft/2020-12',
    agentType: 'hunter',
    direction: 'output',
  },
}
```

## Built-in Schemas

Seed these schemas on first boot alongside other resources:

### HunterFinding

The output format hunters must produce:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | No | Unique identifier (auto-generated if missing) |
| `title` | string | Yes | One-line summary |
| `severity` | enum | Yes | critical/high/medium/low/informational/gas |
| `description` | string | Yes | Detailed description |
| `impact` | string | No | Potential consequences |
| `recommendation` | string | No | Suggested fix |
| `affectedFiles` | array | No | File paths with line ranges |
| `codeSnippet` | string | No | Relevant code |
| `references` | array | No | Related resources or links |

### JudgeVerdict

The output format judges must produce:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `findingId` | string | Yes | ID of the finding being judged |
| `verdict` | enum | Yes | valid/invalid/needs-investigation |
| `confidence` | number | Yes | 0.0 to 1.0 |
| `reasoning` | string | Yes | Why this verdict was reached |
| `severityAdjustment` | object | No | If severity should change: { original, adjusted, reason } |

### AuditReport

The output format report writers must produce:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Report title |
| `summary` | string | Yes | Executive summary |
| `findings` | array | Yes | Ordered list of findings |
| `methodology` | string | No | Audit methodology description |
| `scope` | object | No | { files, contracts, linesOfCode } |
| `metadata` | object | No | { author, date, version, firm } |

## MCP Tool Extension

Extend the existing `list_resources` tool (Spec 2) to support schema-specific queries:

```typescript
// Existing list_resources already supports type filter
// Usage: list_resources({ type: 'schema', tags: ['hunter', 'output'] })
```

Add one new tool for schema validation:

### `validate_against_schema`

```typescript
{
  name: 'validate_against_schema',
  description: 'Validate a JSON object against a stored schema resource. Returns validation result with errors.',
  inputSchema: {
    type: 'object',
    properties: {
      schema_id: { type: 'string', description: 'Resource ID of the schema' },
      data: { type: 'object', description: 'JSON object to validate' }
    },
    required: ['schema_id', 'data']
  }
}
```

Returns:
```json
{
  "valid": false,
  "errors": [
    { "path": "$.severity", "message": "must be one of: critical, high, medium, low, informational, gas", "value": "Critical" }
  ]
}
```

Implementation: Parse the schema resource content as JSON Schema, validate the input data against it. Use a lightweight JSON Schema validator (or implement basic validation for the subset of JSON Schema features we use - required fields, type checks, enum values).

## Designer Integration

The agent-designer uses schemas in two places:

### Output Channel Config

When configuring an output channel (Epic 4 Spec 3), the form includes a schema selector:
- Fetch schemas from sera-core: `list_resources({ type: 'schema', tags: ['output'] })`
- Display as dropdown: "Hunter Finding", "Judge Verdict", "Audit Report", "Custom"
- Selected schema ID stored in channel config: `config.outputSchemaId`
- Compiler uses the schema to generate structured output instructions in the system prompt

### Communication Channel Config

When configuring a communication channel (Epic 4 Spec 4), the message schema can reference a stored schema:
- The existing `messageSchema` field in communication config can reference a schema by ID
- Or define an inline schema for custom communication formats
- The compiler validates that connected agents' output schemas are compatible

## Benchmarker Integration

The benchmarker uses schemas for output parsing:

### Finding Collection

When collecting agent output, the benchmarker can validate against the expected schema:
1. Look up the agent's registered output schema (from registration metadata or pipeline spec)
2. Parse each output file (JSON or markdown)
3. Validate against schema
4. Log schema violations as warnings (don't fail - gracefully handle partial compliance)

This replaces the current implicit format assumptions in `markdown-parser.ts` and the JSON collector.

### Quality Scoring

Schema compliance becomes a quality dimension (benchmarker Epic 2 Spec 2):
- Findings that match the schema perfectly score higher on "format" quality
- Missing required fields reduce quality score
- Extra fields are ignored (schemas are permissive by default)

## Seed Data

Add to the resource seed command (Spec 1):

```typescript
const BUILTIN_SCHEMAS = [
  {
    slug: 'hunter-finding',
    type: 'schema',
    language: 'any',
    name: 'Hunter Finding',
    tags: ['hunter', 'output', 'finding'],
    content: HUNTER_FINDING_SCHEMA_JSON,
    metadata: { agentType: 'hunter', direction: 'output' },
  },
  {
    slug: 'judge-verdict',
    type: 'schema',
    language: 'any',
    name: 'Judge Verdict',
    tags: ['judge', 'output', 'verdict'],
    content: JUDGE_VERDICT_SCHEMA_JSON,
    metadata: { agentType: 'judge', direction: 'output' },
  },
  {
    slug: 'audit-report',
    type: 'schema',
    language: 'any',
    name: 'Audit Report',
    tags: ['writer', 'output', 'report'],
    content: AUDIT_REPORT_SCHEMA_JSON,
    metadata: { agentType: 'writer', direction: 'output' },
  },
];
```

## Key Files

| File | Change |
|------|--------|
| `src/mcp/handlers/NotepadHandler.ts` | Add `validate_against_schema` tool (or create SchemaHandler) |
| `src/benchmark/seed-schemas.ts` | **New** - Built-in schema definitions |
| `packages/sera-types/src/schema.ts` | **New** - HunterFinding, JudgeVerdict, AuditReport TypeScript types |

## Validation Checklist

- [ ] HunterFinding, JudgeVerdict, AuditReport schemas stored as resources
- [ ] Schemas seeded on first boot
- [ ] `list_resources({ type: 'schema' })` returns all schemas
- [ ] `validate_against_schema` correctly validates conforming data
- [ ] `validate_against_schema` returns meaningful errors for non-conforming data
- [ ] Schema content is valid JSON Schema (parseable, well-formed)
- [ ] TypeScript types in `@sera/types` match JSON Schema definitions
- [ ] `npm run compile` and `npm test` pass
