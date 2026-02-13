/**
 * @fileoverview RestAPI - HTTP endpoints for audit management and health
 * @module sera-core/api/RestAPI
 *
 * Provides REST endpoints for audit CRUD, table queries, and health checks.
 * Mounted on the same HTTP server as the WebSocket API (port 9800).
 */

import { Router, Request, Response } from 'express';
import { AuditRegistry } from '../database/AuditRegistry';
import { DatabaseManager } from '../database/DatabaseManager';
import { HealthResponse } from '@sera/types';

export class RestAPI {
    private router: Router;
    private registry: AuditRegistry;
    private dbManager: DatabaseManager;
    private startTime: number;
    private getClientCount: () => number;

    constructor(
        registry: AuditRegistry,
        dbManager: DatabaseManager,
        getClientCount: () => number
    ) {
        this.router = Router();
        this.registry = registry;
        this.dbManager = dbManager;
        this.startTime = Date.now();
        this.getClientCount = getClientCount;
        this.setupRoutes();
    }

    /**
     * Get the Express router
     */
    getRouter(): Router {
        return this.router;
    }

    private setupRoutes(): void {
        // Health check
        this.router.get('/api/health', (_req: Request, res: Response) => {
            const response: HealthResponse = {
                status: 'ok',
                version: '0.1.0',
                uptime: Math.floor((Date.now() - this.startTime) / 1000),
                audits: this.registry.listAudits().length,
                clients: this.getClientCount(),
            };
            res.json(response);
        });

        // List all audits
        this.router.get('/api/audits', (_req: Request, res: Response) => {
            const audits = this.registry.listAudits();
            res.json({ audits });
        });

        // Create a new audit
        this.router.post('/api/audits', (req: Request, res: Response) => {
            const { name, workspacePath } = req.body;
            if (!name || !workspacePath) {
                res.status(400).json({ error: 'name and workspacePath are required' });
                return;
            }

            const slug = AuditRegistry.slugify(name);
            if (this.registry.auditExists(slug)) {
                res.status(409).json({ error: `Audit '${slug}' already exists` });
                return;
            }

            this.registry.createAudit(slug, name, workspacePath);
            res.status(201).json({ slug, name });
        });

        // Get audit metadata
        this.router.get('/api/audits/:slug', (req: Request, res: Response) => {
            const meta = this.registry.getAuditMeta(req.params.slug);
            if (!meta) {
                res.status(404).json({ error: 'Audit not found' });
                return;
            }
            res.json(meta);
        });

        // Query a table in an audit
        this.router.get('/api/audits/:slug/tables/:table', async (req: Request, res: Response) => {
            const { slug, table } = req.params;

            if (!this.registry.auditExists(slug)) {
                res.status(404).json({ error: 'Audit not found' });
                return;
            }

            try {
                const engine = await this.dbManager.getEngine(slug);
                // Table format is "appletId_tableName", split on first _
                const underscoreIndex = table.indexOf('_');
                if (underscoreIndex === -1) {
                    res.status(400).json({ error: 'Table must be in format appletId_tableName' });
                    return;
                }

                const appletId = table.substring(0, underscoreIndex);
                const tableName = table.substring(underscoreIndex + 1);
                const records = engine.query(appletId, tableName);
                res.json({ records });
            } catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });

        // Trigger migration from workspace
        this.router.post('/api/audits/:slug/migrate', async (req: Request, res: Response) => {
            const { slug } = req.params;
            const { sourcePath } = req.body;

            if (!sourcePath) {
                res.status(400).json({ error: 'sourcePath is required' });
                return;
            }

            if (!this.registry.auditExists(slug)) {
                res.status(404).json({ error: 'Audit not found' });
                return;
            }

            try {
                const fs = await import('fs');
                const dbPath = this.registry.getDbPath(slug);

                if (!fs.existsSync(sourcePath)) {
                    res.status(404).json({ error: 'Source database not found' });
                    return;
                }

                fs.copyFileSync(sourcePath, dbPath);
                fs.renameSync(sourcePath, sourcePath + '.migrated');

                res.json({ migrated: true, from: sourcePath, to: dbPath });
            } catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });
    }
}
