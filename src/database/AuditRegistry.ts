/**
 * @fileoverview AuditRegistry - maps workspace paths to audit slugs
 * @module sera-core/database/AuditRegistry
 *
 * Persists the workspace-path-to-audit-slug mapping in
 * ~/.sera/audits/registry.json. Also manages audit metadata files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AuditMeta, AuditSummary } from '@sera/types';
import { getSeraHome } from '../config';

interface RegistryData {
    /** Maps absolute workspace paths to audit slugs */
    workspaces: Record<string, string>;
}

export class AuditRegistry {
    private registryPath: string;
    private auditsDir: string;
    private data: RegistryData = { workspaces: {} };

    constructor(seraHome?: string) {
        this.auditsDir = path.join(getSeraHome(seraHome), 'audits');
        this.registryPath = path.join(this.auditsDir, 'registry.json');
    }

    /**
     * Load registry from disk
     */
    load(): void {
        if (fs.existsSync(this.registryPath)) {
            try {
                this.data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
            } catch {
                this.data = { workspaces: {} };
            }
        }
    }

    /**
     * Save registry to disk
     */
    save(): void {
        if (!fs.existsSync(this.auditsDir)) {
            fs.mkdirSync(this.auditsDir, { recursive: true });
        }
        fs.writeFileSync(this.registryPath, JSON.stringify(this.data, null, 2));
    }

    /**
     * Look up which audit a workspace path belongs to
     * @returns Audit slug or null if not registered
     */
    lookupWorkspace(workspacePath: string): string | null {
        return this.data.workspaces[workspacePath] || null;
    }

    /**
     * Register a workspace path to an audit slug
     */
    registerWorkspace(workspacePath: string, slug: string): void {
        this.data.workspaces[workspacePath] = slug;
        this.save();
    }

    /**
     * Create a new audit with metadata
     * @returns The database path for this audit
     */
    createAudit(slug: string, name: string, workspacePath: string): string {
        const auditDir = path.join(this.auditsDir, slug);
        if (!fs.existsSync(auditDir)) {
            fs.mkdirSync(auditDir, { recursive: true });
        }

        const now = new Date().toISOString();
        const meta: AuditMeta = {
            slug,
            name,
            created: now,
            lastAccessed: now,
            workspacePaths: [workspacePath],
        };

        fs.writeFileSync(path.join(auditDir, 'meta.json'), JSON.stringify(meta, null, 2));
        this.registerWorkspace(workspacePath, slug);

        return path.join(auditDir, 'audit.db');
    }

    /**
     * Get the database path for an audit
     */
    getDbPath(slug: string): string {
        return path.join(this.auditsDir, slug, 'audit.db');
    }

    /**
     * Get metadata for an audit
     */
    getAuditMeta(slug: string): AuditMeta | null {
        const metaPath = path.join(this.auditsDir, slug, 'meta.json');
        if (!fs.existsSync(metaPath)) { return null; }

        try {
            return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch {
            return null;
        }
    }

    /**
     * Update the lastAccessed timestamp for an audit
     */
    touchAudit(slug: string): void {
        const meta = this.getAuditMeta(slug);
        if (meta) {
            meta.lastAccessed = new Date().toISOString();
            const metaPath = path.join(this.auditsDir, slug, 'meta.json');
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        }
    }

    /**
     * List all registered audits
     */
    listAudits(): AuditSummary[] {
        const summaries: AuditSummary[] = [];

        if (!fs.existsSync(this.auditsDir)) { return summaries; }

        for (const entry of fs.readdirSync(this.auditsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) { continue; }

            const meta = this.getAuditMeta(entry.name);
            if (meta) {
                summaries.push({
                    slug: meta.slug,
                    name: meta.name,
                    lastAccessed: meta.lastAccessed,
                    workspacePaths: meta.workspacePaths,
                });
            }
        }

        return summaries.sort((a, b) => b.lastAccessed.localeCompare(a.lastAccessed));
    }

    /**
     * Check if an audit slug exists
     */
    auditExists(slug: string): boolean {
        return fs.existsSync(path.join(this.auditsDir, slug, 'meta.json'));
    }

    /**
     * Generate a slug from a name
     */
    static slugify(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }
}
