/**
 * @fileoverview ResourceStore - SQLite store for audit knowledge resources
 * @module sera-core/resources/ResourceStore
 *
 * Manages roles, primers, references, articles, reports, and schemas.
 * Uses sql.js (same as BenchmarkStore) with its own resources.db file.
 * Resources are global (not per-audit) since they are shared across all audits.
 */

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database } from 'sql.js';
import type { Resource, ResourceSummary, ResourceType, ResourceLanguage } from '@sera/types';

export interface ResourceCreateInput {
    type: ResourceType;
    language?: ResourceLanguage;
    name: string;
    content: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
}

export interface ResourceUpdateInput {
    name?: string;
    content?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    language?: ResourceLanguage;
}

export interface ResourceListFilter {
    type?: ResourceType;
    language?: ResourceLanguage;
    tags?: string[];
    search?: string;
}

export class ResourceStore {
    private db!: Database;
    private dbPath: string;

    constructor(seraHome: string | undefined) {
        const home = seraHome || path.join(require('os').homedir(), '.sera');
        this.dbPath = path.join(home, 'resources.db');
    }

    /**
     * Initialize the database, creating tables if needed
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

        this.createTables();
        this.save();
    }

    /**
     * Shut down the store, saving to disk
     */
    async shutdown(): Promise<void> {
        if (this.db) {
            this.save();
            this.db.close();
        }
    }

    // ========================================================================
    // CRUD
    // ========================================================================

    create(input: ResourceCreateInput): Resource {
        const language = input.language || 'any';
        const id = this.generateId(input.type, language, input.name);
        const slug = this.generateSlug(language, input.name);
        const now = Date.now();
        const tags = input.tags || [];
        const metadata = input.metadata || {};

        // Check for duplicate ID
        const existing = this.get(id);
        if (existing) {
            throw new Error(`Resource already exists with id: ${id}`);
        }

        this.db.run(`
            INSERT INTO resources
                (id, type, language, name, slug, tags, content, version, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id, input.type, language, input.name, slug,
            JSON.stringify(tags), input.content, 1,
            JSON.stringify(metadata), now, now,
        ]);
        this.save();

        return {
            id, type: input.type, language, name: input.name, slug,
            tags, content: input.content, version: 1,
            metadata, createdAt: now, updatedAt: now,
        };
    }

    get(id: string): Resource | null {
        const rows = this.query('SELECT * FROM resources WHERE id = ?', [id]);
        if (rows.length === 0) return null;
        return this.rowToResource(rows[0]);
    }

    getBySlug(slug: string): Resource | null {
        const rows = this.query('SELECT * FROM resources WHERE slug = ?', [slug]);
        if (rows.length === 0) return null;
        return this.rowToResource(rows[0]);
    }

    list(filter?: ResourceListFilter): ResourceSummary[] {
        let sql = 'SELECT id, type, language, name, slug, tags, version, length(content) as content_length, updated_at FROM resources';
        const conditions: string[] = [];
        const params: (string | number)[] = [];

        if (filter?.type) {
            conditions.push('type = ?');
            params.push(filter.type);
        }
        if (filter?.language) {
            conditions.push('language = ?');
            params.push(filter.language);
        }
        if (filter?.tags && filter.tags.length > 0) {
            // Match ANY of the provided tags using LIKE on the JSON array string
            const tagConditions = filter.tags.map(() => 'tags LIKE ?');
            conditions.push('(' + tagConditions.join(' OR ') + ')');
            for (const tag of filter.tags) {
                params.push(`%"${tag}"%`);
            }
        }
        if (filter?.search) {
            conditions.push('name LIKE ?');
            params.push(`%${filter.search}%`);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY type, name';

        return this.query(sql, params).map(r => this.rowToSummary(r));
    }

    update(id: string, patch: ResourceUpdateInput): Resource | null {
        const existing = this.get(id);
        if (!existing) return null;

        const now = Date.now();
        const newName = patch.name ?? existing.name;
        const newContent = patch.content ?? existing.content;
        const newTags = patch.tags ?? existing.tags;
        const newMetadata = patch.metadata ?? existing.metadata;
        const newLanguage = patch.language ?? existing.language;
        const newVersion = existing.version + 1;

        this.db.run(`
            UPDATE resources SET
                name = ?, content = ?, tags = ?, metadata = ?,
                language = ?, version = ?, updated_at = ?
            WHERE id = ?
        `, [
            newName, newContent, JSON.stringify(newTags),
            JSON.stringify(newMetadata), newLanguage, newVersion, now, id,
        ]);
        this.save();

        return {
            ...existing,
            name: newName,
            content: newContent,
            tags: newTags,
            metadata: newMetadata,
            language: newLanguage,
            version: newVersion,
            updatedAt: now,
        };
    }

    delete(id: string): boolean {
        const existing = this.get(id);
        if (!existing) return false;

        this.db.run('DELETE FROM resources WHERE id = ?', [id]);
        this.save();
        return true;
    }

    /**
     * Upsert a resource for seeding. Creates if not exists, updates if it does.
     */
    upsert(input: ResourceCreateInput): Resource {
        const language = input.language || 'any';
        const id = this.generateId(input.type, language, input.name);

        const existing = this.get(id);
        if (existing) {
            const updated = this.update(id, {
                content: input.content,
                tags: input.tags,
                metadata: input.metadata,
            });
            return updated!;
        }

        return this.create(input);
    }

    /**
     * Get the total number of resources
     */
    count(): number {
        const rows = this.query('SELECT COUNT(*) as cnt FROM resources');
        return rows[0]?.cnt ?? 0;
    }

    // ========================================================================
    // ID AND SLUG GENERATION
    // ========================================================================

    generateId(type: string, language: string, name: string): string {
        return `${type}-${language}-${this.slugify(name)}`;
    }

    private generateSlug(language: string, name: string): string {
        return `${language}-${this.slugify(name)}`;
    }

    private slugify(input: string): string {
        return input
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .replace(/-{2,}/g, '-');
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    private createTables(): void {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS resources (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'any',
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                tags TEXT NOT NULL DEFAULT '[]',
                content TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        `);

        this.db.run('CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_resources_language ON resources(language)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_resources_slug ON resources(slug)');
    }

    private query(sql: string, params?: (string | number | null)[]): Record<string, any>[] {
        const result = this.db.exec(sql, params || []);
        if (result.length === 0) return [];

        const columns = result[0].columns;
        return result[0].values.map((row: any[]) => {
            const obj: Record<string, any> = {};
            columns.forEach((col: string, i: number) => {
                obj[col] = row[i];
            });
            return obj;
        });
    }

    private save(): void {
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
    }

    private rowToResource(row: Record<string, any>): Resource {
        return {
            id: row.id,
            type: row.type,
            language: row.language,
            name: row.name,
            slug: row.slug,
            tags: JSON.parse(row.tags),
            content: row.content,
            version: row.version,
            metadata: JSON.parse(row.metadata),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    private rowToSummary(row: Record<string, any>): ResourceSummary {
        return {
            id: row.id,
            type: row.type,
            language: row.language,
            name: row.name,
            slug: row.slug,
            tags: JSON.parse(row.tags),
            version: row.version,
            contentLength: row.content_length,
            updatedAt: row.updated_at,
        };
    }
}
