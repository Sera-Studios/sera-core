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
import { HealthResponse, AgentRegistration } from '@sera/types';
import { AgentLifecycleManager } from '../agents/AgentLifecycleManager';
import { AgentDefinitionLoader } from '../agents/AgentDefinitionLoader';
import { AgentRegistrationStore } from '../agents/AgentRegistrationStore';

export class RestAPI {
    private router: Router;
    private registry: AuditRegistry;
    private dbManager: DatabaseManager;
    private startTime: number;
    private getClientCount: () => number;
    private agentManager: AgentLifecycleManager;
    private agentLoader: AgentDefinitionLoader;
    private registrationStore: AgentRegistrationStore;

    constructor(
        registry: AuditRegistry,
        dbManager: DatabaseManager,
        getClientCount: () => number,
        agentManager: AgentLifecycleManager,
        agentLoader: AgentDefinitionLoader,
        registrationStore: AgentRegistrationStore
    ) {
        this.router = Router();
        this.registry = registry;
        this.dbManager = dbManager;
        this.startTime = Date.now();
        this.getClientCount = getClientCount;
        this.agentManager = agentManager;
        this.agentLoader = agentLoader;
        this.registrationStore = registrationStore;
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

        // ====================================================================
        // Agent management endpoints
        // ====================================================================

        // Reload agent definitions from disk
        this.router.post('/api/agents/definitions/reload', (_req: Request, res: Response) => {
            this.agentLoader.reload();
            const definitions = this.agentLoader.getAll();
            res.json({ reloaded: definitions.length });
        });

        // List available agent definitions
        this.router.get('/api/agents/definitions', (_req: Request, res: Response) => {
            const definitions = this.agentLoader.getAll();
            res.json({
                definitions: definitions.map(d => ({
                    id: d.id,
                    name: d.name,
                    description: d.description,
                    capabilities: d.capabilities,
                    defaultTimeout: d.defaultTimeout,
                    toolsCount: d.defaultTools.allowed.length,
                    defaultScope: d.defaultScope,
                })),
            });
        });

        // Get single agent definition
        this.router.get('/api/agents/definitions/:id', (req: Request, res: Response) => {
            const def = this.agentLoader.getDefinition(req.params.id);
            if (!def) {
                res.status(404).json({ error: 'Agent definition not found' });
                return;
            }
            res.json(def);
        });

        // List agent instances
        this.router.get('/api/agents/instances', (req: Request, res: Response) => {
            const auditSlug = req.query.audit as string | undefined;
            const instances = this.agentManager.listInstances(auditSlug);
            res.json({
                instances,
                total: instances.length,
                running: instances.filter(i => i.status === 'running').length,
            });
        });

        // Get agent instance status
        this.router.get('/api/agents/instances/:id', (req: Request, res: Response) => {
            const instance = this.agentManager.getStatus(req.params.id);
            if (!instance) {
                res.status(404).json({ error: 'Agent instance not found' });
                return;
            }
            res.json(instance);
        });

        // Launch agent
        this.router.post('/api/agents/launch', async (req: Request, res: Response) => {
            const { definitionId, auditSlug, workspacePath, primerPath, customPrompt, timeout, scopeOverrides } = req.body;

            if (!definitionId || !auditSlug || !workspacePath) {
                res.status(400).json({ error: 'definitionId, auditSlug, and workspacePath are required' });
                return;
            }

            try {
                const instance = await this.agentManager.launch({
                    definitionId,
                    auditSlug,
                    workspacePath,
                    primerPath,
                    customPrompt,
                    timeout,
                    scopeOverrides,
                });
                res.status(201).json(instance);
            } catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });

        // Stop agent
        this.router.post('/api/agents/instances/:id/stop', async (req: Request, res: Response) => {
            try {
                await this.agentManager.stop(req.params.id);
                const instance = this.agentManager.getStatus(req.params.id);
                res.json(instance || { status: 'stopped' });
            } catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });

        // Get agent instance outputs
        this.router.get('/api/agents/instances/:id/outputs', async (req: Request, res: Response) => {
            try {
                const outputs = await this.agentManager.getOutputs(req.params.id);
                if (!outputs) {
                    res.status(404).json({ error: 'Agent instance not found' });
                    return;
                }
                res.json(outputs);
            } catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });

        // ====================================================================
        // Agent registration endpoints (new format)
        // ====================================================================

        // List all registrations
        this.router.get('/api/agents/registrations', (_req: Request, res: Response) => {
            const registrations = this.registrationStore.getAll();
            res.json({
                registrations: registrations.map(r => ({
                    id: r.id,
                    name: r.name,
                    description: r.description,
                    executionType: r.execution.type,
                    defaultTimeout: r.defaultTimeout,
                    inputCount: r.interface.inputs.length,
                    outputCount: r.interface.outputs.length,
                })),
                total: registrations.length,
            });
        });

        // Get single registration
        this.router.get('/api/agents/registrations/:id', (req: Request, res: Response) => {
            const reg = this.registrationStore.get(req.params.id);
            if (!reg) {
                res.status(404).json({ error: 'Agent registration not found' });
                return;
            }
            res.json(reg);
        });

        // Register new agent
        this.router.post('/api/agents/registrations', (req: Request, res: Response) => {
            const registration = req.body as AgentRegistration;
            if (!registration.id || !registration.name || !registration.execution) {
                res.status(400).json({ error: 'id, name, and execution are required' });
                return;
            }

            const persist = req.query.persist === 'true';
            this.registrationStore.register(registration, persist);
            res.status(201).json({ registered: registration.id });
        });

        // Unregister agent
        this.router.delete('/api/agents/registrations/:id', (req: Request, res: Response) => {
            const removed = this.registrationStore.unregister(req.params.id);
            if (!removed) {
                res.status(404).json({ error: 'Agent registration not found' });
                return;
            }
            res.json({ unregistered: req.params.id });
        });

        // Validate a registration (pre-flight check)
        this.router.post('/api/agents/registrations/:id/validate', async (req: Request, res: Response) => {
            const reg = this.registrationStore.get(req.params.id);
            if (!reg) {
                res.status(404).json({ error: 'Agent registration not found' });
                return;
            }

            try {
                const handle = this.agentManager.getHandle(req.params.id);
                res.json({
                    id: reg.id,
                    executionType: reg.execution.type,
                    valid: true,
                    handle: handle ? { status: handle.status } : null,
                });
            } catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });

        // Reload registrations from disk
        this.router.post('/api/agents/registrations/reload', (_req: Request, res: Response) => {
            this.registrationStore.reload();
            res.json({ reloaded: this.registrationStore.size });
        });

        // List available adapter types
        this.router.get('/api/agents/adapters', (_req: Request, res: Response) => {
            res.json({ message: 'Use GET /api/agents/registrations for available agents' });
        });
    }
}
