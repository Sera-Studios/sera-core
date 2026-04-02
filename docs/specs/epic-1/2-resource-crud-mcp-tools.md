# Spec 2: Resource CRUD REST & MCP Tools

**Status:** Pending
**Epic:** 1 - Resource & Role Management
**Depends on:** Spec 1 (Resource Storage Tables)

## Overview

Expose the ResourceStore via REST endpoints and MCP tools. REST is for the VS Code extension and web UIs. MCP is for Claude Code and the autonomous iteration loop, where modifying role content and attaching primers is a key part of agent improvement.

## REST API

### Endpoints

All under `/api/resources`:

| Method | Path | Purpose | Query Params |
|--------|------|---------|-------------|
| GET | `/api/resources` | List resources (summaries, no content) | `type`, `language`, `tags` (comma-separated), `search` |
| GET | `/api/resources/:id` | Get full resource with content | - |
| POST | `/api/resources` | Create new resource | - |
| PATCH | `/api/resources/:id` | Update resource (partial) | - |
| DELETE | `/api/resources/:id` | Delete resource | - |
| POST | `/api/resources/seed` | Re-seed from filesystem | `source` (path) |

### Request/Response Examples

**List resources:**
```
GET /api/resources?type=role&language=solidity
```
```json
{
  "resources": [
    {
      "id": "role-solidity-hunter",
      "type": "role",
      "language": "solidity",
      "name": "Hunter",
      "slug": "solidity-hunter",
      "tags": ["vulnerability-detection", "smart-contracts"],
      "version": 3,
      "contentLength": 4250,
      "updatedAt": 1709564400000
    }
  ],
  "total": 1
}
```

**Get resource:**
```
GET /api/resources/role-solidity-hunter
```
```json
{
  "id": "role-solidity-hunter",
  "type": "role",
  "language": "solidity",
  "name": "Hunter",
  "slug": "solidity-hunter",
  "tags": ["vulnerability-detection", "smart-contracts"],
  "content": "# Hunter Role\n\nYou are a security auditor...",
  "version": 3,
  "metadata": { "source": "roles/solidity/hunter.md" },
  "createdAt": 1709500000000,
  "updatedAt": 1709564400000
}
```

**Create resource:**
```
POST /api/resources
{
  "type": "primer",
  "language": "solidity",
  "name": "Lending Pool Primer",
  "tags": ["lending", "defi", "collateral"],
  "content": "# Lending Pool Architecture\n\n..."
}
```

**Update resource:**
```
PATCH /api/resources/role-solidity-hunter
{
  "content": "# Hunter Role\n\nYou are a security auditor specializing in reentrancy...",
  "tags": ["vulnerability-detection", "reentrancy", "smart-contracts"]
}
```

### Implementation

Add routes in `src/api/RestAPI.ts`:

```typescript
// Resource management
router.get('/api/resources', async (req, res) => {
  const { type, language, tags, search } = req.query;
  const resources = await resourceStore.list({
    type: type as string,
    language: language as string,
    tags: tags ? (tags as string).split(',') : undefined,
    search: search as string,
  });
  res.json({ resources, total: resources.length });
});

router.get('/api/resources/:id', async (req, res) => {
  const resource = await resourceStore.get(req.params.id);
  if (!resource) return res.status(404).json({ error: 'Resource not found' });
  res.json(resource);
});

router.post('/api/resources', async (req, res) => {
  const resource = await resourceStore.create(req.body);
  res.status(201).json(resource);
});

router.patch('/api/resources/:id', async (req, res) => {
  const resource = await resourceStore.update(req.params.id, req.body);
  if (!resource) return res.status(404).json({ error: 'Resource not found' });
  res.json(resource);
});

router.delete('/api/resources/:id', async (req, res) => {
  const deleted = await resourceStore.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Resource not found' });
  res.json({ deleted: true });
});
```

## MCP Tools

### ResourceHandler

Create a new MCP handler following the existing pattern (see NotepadHandler, TraceHandler):

```typescript
// src/mcp/handlers/ResourceHandler.ts
class ResourceHandler implements MCPHandler {
  readonly name = 'resource';

  declareTools(): ToolDeclaration[] {
    return [
      {
        name: 'list_resources',
        description: 'List available audit resources (roles, primers, references). Returns summaries without full content. Use get_resource to read content.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['role', 'primer', 'reference', 'article', 'report'],
              description: 'Filter by resource type'
            },
            language: {
              type: 'string',
              enum: ['solidity', 'rust-solana', 'rust-offchain', 'any'],
              description: 'Filter by target language'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by tags (matches ANY)'
            },
            search: {
              type: 'string',
              description: 'Search in name and content'
            }
          }
        }
      },
      {
        name: 'get_resource',
        description: 'Get the full content of a resource by ID. Returns the complete markdown text.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string', description: 'Resource ID' }
          },
          required: ['resource_id']
        }
      },
      {
        name: 'create_resource',
        description: 'Create a new audit resource (role, primer, reference, etc.).',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['role', 'primer', 'reference', 'article', 'report'],
              description: 'Resource type'
            },
            language: {
              type: 'string',
              enum: ['solidity', 'rust-solana', 'rust-offchain', 'any'],
              description: 'Target language'
            },
            name: { type: 'string', description: 'Resource name' },
            content: { type: 'string', description: 'Full markdown content' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags for categorization'
            }
          },
          required: ['type', 'name', 'content']
        }
      },
      {
        name: 'update_resource',
        description: 'Update an existing resource. Use to refine role prompts, add patterns to references, or improve primers during agent iteration.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string', description: 'Resource ID to update' },
            content: { type: 'string', description: 'New markdown content (replaces existing)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing)' },
            name: { type: 'string', description: 'New name' }
          },
          required: ['resource_id']
        }
      },
      {
        name: 'delete_resource',
        description: 'Delete a resource by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string', description: 'Resource ID to delete' }
          },
          required: ['resource_id']
        }
      }
    ];
  }
}
```

### Autonomous Loop Usage

During the iteration workflow (Designer Epic 5), Claude Code uses these tools:

```
Iteration 1: "Agent missed reentrancy - refine role"
  -> get_resource("role-solidity-hunter")
  -> Read current role content
  -> update_resource("role-solidity-hunter", {
       content: "...add explicit reentrancy detection patterns..."
     })
  -> Rebuild pipeline with updated role reference
  -> Re-benchmark

Iteration 2: "Agent missed lending-specific issues - add primer"
  -> list_resources({ type: "primer", tags: ["lending"] })
  -> Found: primer-solidity-lending
  -> Add resource-channel source referencing this primer to the pipeline spec
  -> Re-benchmark

Iteration 3: "No existing primer for flash loans - create one"
  -> create_resource({
       type: "primer",
       language: "solidity",
       name: "Flash Loan Mechanics",
       content: "# Flash Loan Mechanics\n\n...",
       tags: ["flash-loan", "defi", "lending"]
     })
  -> Reference new primer in pipeline
  -> Re-benchmark
```

## Designer Integration

The agent-designer's instruction-channel and resource-channel source nodes need to support referencing sera-core resources by ID instead of (or in addition to) filesystem paths.

This integration lives in the designer's codebase, not sera-core. The designer already proxies to sera-core for other data. Add:

```
GET /api/resources -> proxy to sera-core:9800/api/resources
```

In the designer's node config forms:
- `role-file` node: dropdown populated from `list_resources({ type: 'role' })`
- `context-document` node: dropdown from `list_resources({ type: 'primer' })` + `list_resources({ type: 'reference' })`
- `article` node: dropdown from `list_resources({ type: 'article' })`

The compiler reads resource content from sera-core at compile time and bundles it into the generated script.

## Key Files

| File | Change |
|------|--------|
| `src/mcp/handlers/ResourceHandler.ts` | **New** - MCP handler with 5 tools |
| `src/api/RestAPI.ts` | Add `/api/resources` routes |
| `src/mcp/MCPServer.ts` | Register ResourceHandler |
| `src/server.ts` | Initialize ResourceStore, pass to handlers and REST |
| `packages/sera-types/src/resource.ts` | Resource types (from Spec 1) |

## Validation Checklist

- [ ] REST: List resources with type/language/tag/search filters
- [ ] REST: Get resource returns full content
- [ ] REST: Create resource returns 201 with generated ID
- [ ] REST: Update resource increments version
- [ ] REST: Delete resource returns 200
- [ ] MCP: list_resources returns summaries (no content)
- [ ] MCP: get_resource returns full markdown content
- [ ] MCP: create_resource generates correct ID and slug
- [ ] MCP: update_resource preserves fields not in the patch
- [ ] MCP: delete_resource removes the resource
- [ ] Claude Code can read and modify role content via MCP
- [ ] Claude Code can find relevant primers by tag search
- [ ] All TypeScript compiles with zero warnings
- [ ] Integration tests cover CRUD lifecycle
