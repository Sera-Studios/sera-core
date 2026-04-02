# Spec 1: Resource Storage Tables

**Status:** Pending
**Epic:** 1 - Resource & Role Management
**Depends on:** None

## Overview

Add a `resources` table to sera-core's database for storing audit knowledge (roles, primers, references, articles). Seed it from the existing `resources/` filesystem directory. This table is instance-level (not per-audit) since resources are shared across all audits.

## Database Schema

sera-core uses sql.js (SQLite in-memory with persistence). The resources table is added to the instance-level database (not per-audit StorageEngine).

### Table: `resources`

```sql
CREATE TABLE resources (
  id          TEXT PRIMARY KEY,           -- slugified: "solidity-hunter-v1"
  type        TEXT NOT NULL,              -- 'role' | 'primer' | 'reference' | 'article' | 'report'
  language    TEXT NOT NULL DEFAULT 'any', -- 'solidity' | 'rust-solana' | 'rust-offchain' | 'any'
  name        TEXT NOT NULL,              -- "Solidity Hunter"
  slug        TEXT NOT NULL UNIQUE,       -- URL-safe identifier
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON array: ["reentrancy", "lending"]
  content     TEXT NOT NULL,              -- Full markdown content
  version     INTEGER NOT NULL DEFAULT 1, -- Incremented on update
  metadata    TEXT NOT NULL DEFAULT '{}', -- JSON: { author, description, ... }
  createdAt   INTEGER NOT NULL,           -- Unix ms
  updatedAt   INTEGER NOT NULL            -- Unix ms
);

CREATE INDEX idx_resources_type ON resources(type);
CREATE INDEX idx_resources_language ON resources(language);
CREATE INDEX idx_resources_slug ON resources(slug);
```

### ID Generation

IDs are generated from type, language, and name:
```
{type}-{language}-{slugify(name)}
```
Examples:
- `role-solidity-hunter`
- `primer-solidity-lending`
- `reference-any-reentrancy-patterns`
- `role-rust-solana-hunter`

### Type Definitions

```typescript
interface Resource {
  id: string;
  type: 'role' | 'primer' | 'reference' | 'article' | 'report';
  language: 'solidity' | 'rust-solana' | 'rust-offchain' | 'any';
  name: string;
  slug: string;
  tags: string[];
  content: string;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface ResourceSummary {
  id: string;
  type: Resource['type'];
  language: Resource['language'];
  name: string;
  slug: string;
  tags: string[];
  version: number;
  contentLength: number;  // character count (don't send full content in listings)
  updatedAt: number;
}
```

## Filesystem Seed

### Seed Command

```typescript
// src/cli.ts - add 'seed-resources' command
async function seedResources(sourcePath: string): Promise<void> {
  const mapping = [
    { dir: 'roles/solidity',    type: 'role',      language: 'solidity' },
    { dir: 'roles/rust-solana', type: 'role',      language: 'rust-solana' },
    { dir: 'primers',           type: 'primer',    language: 'solidity' },
    { dir: 'references',        type: 'reference', language: 'any' },
    { dir: 'reports',           type: 'report',    language: 'any' },
  ];

  for (const { dir, type, language } of mapping) {
    const fullDir = path.join(sourcePath, dir);
    if (!fs.existsSync(fullDir)) continue;

    for (const file of fs.readdirSync(fullDir).filter(f => f.endsWith('.md'))) {
      const name = path.basename(file, '.md');
      const content = fs.readFileSync(path.join(fullDir, file), 'utf-8');
      const tags = extractTags(content);  // parse frontmatter or infer from content

      await db.upsertResource({
        type,
        language,
        name: titleCase(name),
        content,
        tags,
        metadata: { source: `${dir}/${file}` },
      });
    }
  }
}
```

### Tag Extraction

If markdown files have YAML frontmatter, parse tags from it:
```yaml
---
tags: [reentrancy, external-calls, state-management]
language: solidity
---
```

If no frontmatter, infer tags from the filename and directory path. For example, `resources/primers/lending.md` gets tags `["lending"]`.

### Auto-Seed on First Boot

On server startup, if the `resources` table is empty and the `resources/` directory exists in the expected location, run the seed automatically. Log a message: "Seeded N resources from filesystem."

## Storage Layer

### ResourceStore

```typescript
// src/resources/ResourceStore.ts
class ResourceStore {
  constructor(private db: Database) {}

  async createTable(): Promise<void> { /* CREATE TABLE IF NOT EXISTS */ }

  async list(filter?: {
    type?: Resource['type'];
    language?: Resource['language'];
    tags?: string[];       // match ANY of these tags
    search?: string;       // full-text search in name and content
  }): Promise<ResourceSummary[]> { /* SELECT with WHERE clauses */ }

  async get(id: string): Promise<Resource | null> { /* SELECT by id */ }

  async getBySlug(slug: string): Promise<Resource | null> { /* SELECT by slug */ }

  async create(input: Omit<Resource, 'id' | 'slug' | 'version' | 'createdAt' | 'updatedAt'>): Promise<Resource> {
    /* Generate id and slug, INSERT */
  }

  async update(id: string, patch: Partial<Pick<Resource, 'name' | 'content' | 'tags' | 'metadata' | 'language'>>): Promise<Resource> {
    /* UPDATE, increment version */
  }

  async delete(id: string): Promise<boolean> { /* DELETE by id */ }

  async upsertResource(input: { type: string; language: string; name: string; content: string; tags: string[]; metadata: object }): Promise<Resource> {
    /* INSERT OR REPLACE for seeding */
  }
}
```

### Database Location

Resources are instance-level, not audit-scoped. They go in sera-core's main database (the one that holds agent registrations, stats, sessions), not in per-audit StorageEngine databases.

Check where the main database lives - likely `~/.sera/sera-core.db` or similar. The ResourceStore should be initialized alongside other stores during server startup.

## Key Files

| File | Change |
|------|--------|
| `src/resources/ResourceStore.ts` | **New** - Resource CRUD operations |
| `src/server.ts` | Initialize ResourceStore, pass to handlers |
| `src/cli.ts` | Add `seed-resources` command |
| `packages/sera-types/src/resource.ts` | **New** - Resource and ResourceSummary types |

## Validation Checklist

- [ ] `resources` table created on server startup
- [ ] Seed from filesystem populates table with all existing resources
- [ ] Auto-seed on first boot when table is empty
- [ ] IDs are deterministic (same file always produces same ID)
- [ ] Tags are extracted from frontmatter or inferred from path
- [ ] Version increments on update
- [ ] Slug is unique and URL-safe
- [ ] Content stored as full markdown text
- [ ] ResourceStore list supports filtering by type, language, tags
- [ ] ResourceStore list returns summaries (no content) for performance
- [ ] All TypeScript compiles with zero warnings
