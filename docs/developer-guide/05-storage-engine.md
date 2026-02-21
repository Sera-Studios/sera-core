# Storage Engine

The StorageEngine is sera-core's per-audit database layer, built on sql.js (SQLite compiled to WebAssembly). Each audit gets its own isolated database file at `~/.sera/audits/{slug}/audit.db`.

## Architecture

```
DatabaseManager
  └── getEngine(slug) -> StorageEngine (lazy, one per audit)
        └── sql.js (SQLite in WASM)
              └── ~/.sera/audits/{slug}/audit.db
```

### DatabaseManager

The `DatabaseManager` provides lazy lifecycle management:

- **Lazy creation** - engines are created on first access via `getEngine(slug)`
- **Access tracking** - each `getEngine()` call updates the audit's `lastAccessed` timestamp
- **Graceful shutdown** - `shutdownAll()` flushes and closes every active engine

### StorageEngine

Each `StorageEngine` instance wraps a sql.js database with:

- **In-memory operation** - all reads and writes happen in memory for performance
- **Periodic flush** - dirty tables are written to disk at a configurable interval (default 30s)
- **Table registry** - handlers declare schemas, engine auto-creates or recreates tables
- **Dirty tracking** - only modified tables are flushed to disk
- **Table cache** - frequently accessed data is cached in memory

## Table Schema System

Handlers declare their required tables using `TableSchema`:

```typescript
interface TableSchema {
  name: string;           // Table name
  version: number;        // Schema version (triggers recreate on change)
  primaryKey: string;     // Primary key field name
  fields: TableField[];   // Column definitions
  indexes?: string[];     // Optional index columns
}

interface TableField {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
}
```

### Schema Versioning

When a handler provides a schema with a higher `version` than what's stored in `_storage_metadata`, the engine:

1. Drops the existing table
2. Creates the new table with the updated schema
3. Updates the metadata version

This allows schema evolution without manual migrations.

### Metadata Table

The engine maintains a `_storage_metadata` table that tracks:

| Column | Type | Description |
|--------|------|-------------|
| `applet_id` | TEXT | Applet that owns the table |
| `table_name` | TEXT | Table name |
| `schema` | TEXT | JSON-encoded schema definition |
| `version` | INTEGER | Current schema version |
| `created_at` | TEXT | Table creation timestamp |
| `updated_at` | TEXT | Last schema update timestamp |

## Operations

### Write (Upsert)

```typescript
engine.write(appletId: string, table: string, data: Record<string, any>): void
```

Performs an upsert by primary key:
- If a record with the same primary key exists, it is updated
- If no matching record exists, a new one is inserted
- Marks the table as dirty for the next flush cycle

### Query

```typescript
engine.query(appletId: string, table: string, filter?: Record<string, any>): Record<string, any>[]
```

Queries records from a table with optional field-value filters:
- No filter returns all records
- Multiple filter fields are combined with AND
- Returns an array of plain objects

### SQL

```typescript
engine.sql(query: string, params?: any[]): any[]
```

Executes raw SQL for complex queries that can't be expressed through the filter API. Use parameterized queries to prevent SQL injection.

### Delete

```typescript
engine.delete(appletId: string, table: string, filter: Record<string, any>): number
```

Deletes records matching the filter criteria. Returns the count of deleted rows.

### Register Tables

```typescript
engine.registerTables(appletId: string, schemas: TableSchema[]): void
```

Called automatically by the MCP server before each tool call. Creates tables that don't exist and recreates tables whose schema version has changed.

## Flush Cycle

The engine uses a dirty-tracking mechanism to minimize disk I/O:

1. `write()` and `delete()` operations mark the affected table as dirty
2. A periodic timer (default 30s) checks for dirty tables
3. Dirty tables are exported to the SQLite binary format
4. The binary is written atomically to `~/.sera/audits/{slug}/audit.db`
5. The dirty set is cleared

On shutdown, `engine.shutdown()` performs a final flush of all dirty tables before closing the database.

## File System Layout

```
~/.sera/
├── audits/
│   ├── registry.json              # Workspace-to-audit mappings
│   ├── my-audit/
│   │   ├── meta.json              # Audit metadata (name, created, lastAccessed)
│   │   └── audit.db               # SQLite database file
│   └── another-audit/
│       ├── meta.json
│       └── audit.db
├── config.json                    # Configuration overrides
├── logs/
│   └── sera-core.log              # Daemon log file
├── credentials.vault              # Encrypted credential store
├── vault.key                      # Vault encryption key (mode 0600)
└── sera-core.pid                  # PID file for daemon management
```

## AuditRegistry

The `AuditRegistry` manages the mapping between workspaces and audits:

| Operation | Description |
|-----------|-------------|
| `createAudit(slug, name, workspace)` | Create audit directory, write metadata, register workspace |
| `lookupWorkspace(path)` | Find audit slug for a workspace path |
| `auditExists(slug)` | Check if an audit exists |
| `listAudits()` | List all audits with metadata |
| `touchAudit(slug)` | Update lastAccessed timestamp |

The registry persists to `~/.sera/audits/registry.json` and is loaded at startup.

## Configuration

Database behavior is configured in `~/.sera/config.json`:

```json
{
  "database": {
    "flushIntervalMs": 30000,
    "backupOnMigrate": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `flushIntervalMs` | 30000 | Interval between dirty table flushes (ms) |
| `backupOnMigrate` | true | Create backup when migrating workspace databases |
