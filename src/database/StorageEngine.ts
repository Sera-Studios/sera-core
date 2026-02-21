/**
 * @fileoverview StorageEngine - sql.js wrapper for a single audit database
 * @module sera-core/database/StorageEngine
 *
 * Extracted from the VS Code extension's StorageApplet. Manages a single
 * SQLite database with in-memory caching and periodic flush to disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database } from 'sql.js';
import {
    TableSchema,
    TableMetadata,
    FieldDefinition,
    FieldType,
    ValidationResult,
} from '@sera/types';

export class StorageEngine {
    private db!: Database;
    private dbPath: string;
    private tableRegistry: Map<string, TableMetadata> = new Map();
    private tableCache: Map<string, any[]> = new Map();
    private dirtyTables: Set<string> = new Set();
    private flushTimer?: NodeJS.Timeout;
    private flushIntervalMs: number;

    constructor(dbPath: string, flushIntervalMs: number = 30000) {
        this.dbPath = dbPath;
        this.flushIntervalMs = flushIntervalMs;
    }

    /**
     * Initialize the database engine, loading from disk if exists
     */
    async initialize(): Promise<void> {
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const SQL = await initSqlJs();

        if (fs.existsSync(this.dbPath)) {
            const buffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(buffer);
        } else {
            this.db = new SQL.Database();
        }

        // Create metadata table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS _storage_metadata (
                applet_id TEXT NOT NULL,
                table_name TEXT NOT NULL,
                schema TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (applet_id, table_name)
            );
        `);

        this.loadTableRegistry();
        this.saveDatabase();
        this.startPeriodicFlush();
    }

    /**
     * Shut down the engine, flushing all dirty data and saving to disk
     */
    async shutdown(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = undefined;
        }

        if (this.dirtyTables.size > 0) {
            this.flushToDatabase();
        }

        if (this.db) {
            this.saveDatabase();
            this.db.close();
        }
    }

    /**
     * Register tables for an applet. Creates tables if they don't exist,
     * handles version upgrades by recreating.
     * @returns Array of { table, exists, data } for each registered table
     */
    registerTables(appletId: string, tables: TableSchema[]): Array<{ table: string; exists: boolean; data: any[] | null }> {
        const results: Array<{ table: string; exists: boolean; data: any[] | null }> = [];

        for (const schema of tables) {
            const key = `${appletId}:${schema.name}`;
            const existing = this.tableRegistry.get(key);

            if (existing) {
                const requestedVersion = schema.version || '0';
                const existingVersion = existing.schema.version || '0';

                if (existingVersion !== requestedVersion) {
                    // Version mismatch - recreate
                    const quotedName = this.getQuotedTableName(appletId, schema.name);
                    this.db.run(`DROP TABLE IF EXISTS ${quotedName}`);
                    this.db.run(
                        `DELETE FROM _storage_metadata WHERE applet_id = ? AND table_name = ?`,
                        [appletId, schema.name]
                    );
                    this.tableRegistry.delete(key);
                    this.createTable(appletId, schema);
                    this.tableCache.set(key, []);
                    results.push({ table: schema.name, exists: false, data: null });
                } else {
                    // Version matches - use existing cache if populated, else load from DB
                    if (!this.tableCache.has(key)) {
                        const data = this.loadTableDataFromDB(appletId, schema.name);
                        this.tableCache.set(key, data);
                    }
                    results.push({ table: schema.name, exists: true, data: this.tableCache.get(key)! });
                }
            } else {
                // New table
                this.createTable(appletId, schema);
                this.tableCache.set(key, []);
                results.push({ table: schema.name, exists: false, data: null });
            }
        }

        this.saveDatabase();
        return results;
    }

    /**
     * Write a record to a table (upsert by primary key)
     */
    write(appletId: string, table: string, data: Record<string, any>): void {
        const key = `${appletId}:${table}`;
        const metadata = this.tableRegistry.get(key);
        if (!metadata) {
            throw new Error(`Table ${key} not registered`);
        }

        // Sanitize undefined -> null
        const sanitized: Record<string, any> = {};
        for (const [k, v] of Object.entries(data)) {
            sanitized[k] = v === undefined ? null : v;
        }

        // Upsert in cache
        const cachedData = this.tableCache.get(key) || [];
        const pkFields = metadata.schema.fields.filter(f => f.primaryKey).map(f => f.name);

        if (pkFields.length > 0) {
            const existingIndex = cachedData.findIndex(row =>
                pkFields.every(pk => row[pk] === sanitized[pk])
            );
            if (existingIndex >= 0) {
                // Update (merge) - skip required field validation since existing record has them
                cachedData[existingIndex] = { ...cachedData[existingIndex], ...sanitized };
            } else {
                // Insert - validate required fields
                const validation = this.validateData(appletId, table, data);
                if (!validation.valid) {
                    throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
                }
                cachedData.push(sanitized);
            }
        } else {
            // No primary key - always insert, validate required fields
            const validation = this.validateData(appletId, table, data);
            if (!validation.valid) {
                throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
            }
            cachedData.push(sanitized);
        }

        this.tableCache.set(key, cachedData);
        this.dirtyTables.add(key);
    }

    /**
     * Query records from a table
     */
    query(appletId: string, table: string, filter?: Record<string, any>): any[] {
        const key = `${appletId}:${table}`;
        const cachedData = this.tableCache.get(key) || [];

        if (!filter || Object.keys(filter).length === 0) {
            return cachedData;
        }

        return cachedData.filter(row =>
            Object.keys(filter).every(k => row[k] === filter[k])
        );
    }

    /**
     * Execute raw SQL query
     */
    sql(query: string, params?: any[]): any[] {
        // Flush dirty tables for consistency
        if (this.dirtyTables.size > 0) {
            this.flushToDatabase();
        }

        const result = this.db.exec(query, params || []);
        if (result.length === 0) {
            return [];
        }

        const columns = result[0].columns;
        return result[0].values.map((row: any[]) => {
            const obj: any = {};
            columns.forEach((col: string, i: number) => {
                obj[col] = row[i];
            });
            return obj;
        });
    }

    /**
     * Delete records matching a filter
     * @returns Number of records deleted
     */
    delete(appletId: string, table: string, filter: Record<string, any>): number {
        const key = `${appletId}:${table}`;
        const cachedData = this.tableCache.get(key) || [];
        const before = cachedData.length;

        const filtered = cachedData.filter(row =>
            !Object.keys(filter).every(k => row[k] === filter[k])
        );

        this.tableCache.set(key, filtered);
        this.dirtyTables.add(key);

        return before - filtered.length;
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    private loadTableRegistry(): void {
        const result = this.db.exec(
            `SELECT applet_id, table_name, schema, created_at, updated_at FROM _storage_metadata`
        );

        if (result.length === 0) { return; }

        for (const row of result[0].values) {
            const appletId = row[0] as string;
            const tableName = row[1] as string;
            const schema = JSON.parse(row[2] as string);
            const key = `${appletId}:${tableName}`;
            this.tableRegistry.set(key, {
                appletId,
                schema,
                createdAt: row[3] as number,
                updatedAt: row[4] as number,
            });
        }
    }

    private createTable(appletId: string, schema: TableSchema): void {
        const quotedName = this.getQuotedTableName(appletId, schema.name);

        const fieldDefs = schema.fields.map(field => {
            let def = `${field.name} ${this.sqlType(field.type)}`;
            if (field.required) { def += ' NOT NULL'; }
            if (field.unique) { def += ' UNIQUE'; }
            if (field.defaultValue !== undefined) { def += ` DEFAULT ${this.sqlValue(field.defaultValue)}`; }
            return def;
        });

        const pkFields = schema.fields.filter(f => f.primaryKey).map(f => f.name);
        if (pkFields.length > 0) {
            fieldDefs.push(`PRIMARY KEY (${pkFields.join(', ')})`);
        }

        this.db.run(`CREATE TABLE IF NOT EXISTS ${quotedName} (${fieldDefs.join(', ')})`);

        if (schema.indexes) {
            const tableName = `${appletId}_${schema.name}`;
            for (const index of schema.indexes) {
                const indexName = index.name || `idx_${tableName}_${index.fields.join('_')}`;
                const unique = index.unique ? 'UNIQUE' : '';
                this.db.run(`CREATE ${unique} INDEX IF NOT EXISTS ${indexName} ON ${quotedName} (${index.fields.join(', ')})`);
            }
        }

        const now = Date.now();
        this.db.run(
            `INSERT INTO _storage_metadata (applet_id, table_name, schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [appletId, schema.name, JSON.stringify(schema), now, now]
        );

        const key = `${appletId}:${schema.name}`;
        this.tableRegistry.set(key, { appletId, schema, createdAt: now, updatedAt: now });
    }

    private loadTableDataFromDB(appletId: string, table: string): any[] {
        const quotedName = this.getQuotedTableName(appletId, table);
        const result = this.db.exec(`SELECT * FROM ${quotedName}`);
        if (result.length === 0) { return []; }

        const columns = result[0].columns;
        return result[0].values.map((row: any[]) => {
            const obj: any = {};
            columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
            return obj;
        });
    }

    private getQuotedTableName(appletId: string, table: string): string {
        return `"${appletId}_${table}"`;
    }

    private saveDatabase(): void {
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
    }

    private startPeriodicFlush(): void {
        this.flushTimer = setInterval(() => {
            if (this.dirtyTables.size > 0) {
                this.flushToDatabase();
            }
        }, this.flushIntervalMs);
    }

    private flushToDatabase(): void {
        if (this.dirtyTables.size === 0) { return; }

        try {
            this.db.run('BEGIN TRANSACTION');

            for (const key of this.dirtyTables) {
                const [appletId, tableName] = key.split(':');
                const quotedName = this.getQuotedTableName(appletId, tableName);
                const cachedData = this.tableCache.get(key) || [];

                this.db.run(`DELETE FROM ${quotedName}`);

                for (const row of cachedData) {
                    const fields = Object.keys(row);
                    const placeholders = fields.map(() => '?').join(', ');
                    const values = fields.map(f => row[f] === undefined ? null : row[f]);
                    this.db.run(`INSERT INTO ${quotedName} (${fields.join(', ')}) VALUES (${placeholders})`, values);
                }
            }

            this.db.run('COMMIT');
            this.saveDatabase();
            this.dirtyTables.clear();
        } catch (error) {
            try { this.db.run('ROLLBACK'); } catch (_) { /* ignore */ }
            throw error;
        }
    }

    private validateData(appletId: string, table: string, data: Record<string, any>): ValidationResult {
        const metadata = this.tableRegistry.get(`${appletId}:${table}`);
        if (!metadata) {
            return { valid: false, errors: [`Table ${appletId}:${table} not registered`] };
        }

        const errors: string[] = [];
        for (const field of metadata.schema.fields) {
            if (field.required && !(field.name in data)) {
                errors.push(`Missing required field: ${field.name}`);
            }
        }

        return { valid: errors.length === 0, errors };
    }

    private sqlType(fieldType: FieldType): string {
        switch (fieldType) {
            case 'TEXT': return 'TEXT';
            case 'INTEGER': return 'INTEGER';
            case 'REAL': return 'REAL';
            case 'BOOLEAN': return 'INTEGER';
            case 'JSON': return 'TEXT';
            default: return 'TEXT';
        }
    }

    private sqlValue(value: any): string {
        if (typeof value === 'string') { return `'${value.replace(/'/g, "''")}'`; }
        if (typeof value === 'boolean') { return value ? '1' : '0'; }
        if (value === null) { return 'NULL'; }
        return String(value);
    }
}
