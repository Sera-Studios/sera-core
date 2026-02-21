/**
 * @fileoverview RestAPI - HTTP endpoints for audit management and health
 * @module sera-core/api/RestAPI
 *
 * Provides REST endpoints for audit CRUD, table queries, and health checks.
 * Mounted on the same HTTP server as the WebSocket API (port 9800).
 */

import * as path from 'path';
import { Router, Request, Response } from 'express';
import { AuditRegistry } from '../database/AuditRegistry';
import { DatabaseManager } from '../database/DatabaseManager';
import { HealthResponse, AgentRegistration } from '@sera/types';
import { AgentRegistrationStore } from '../agents/AgentRegistrationStore';
import { CredentialStore } from '../credentials/CredentialStore';
import { BenchmarkStore } from '../benchmark/BenchmarkStore';
import { AgentExecutor } from '../execution/AgentExecutor';
import { importSherlockIndex } from '../benchmark/importSherlock';

export class RestAPI {
    private router: Router;
    private registry: AuditRegistry;
    private dbManager: DatabaseManager;
    private startTime: number;
    private getClientCount: () => number;
    private registrationStore: AgentRegistrationStore;
    private credentialStore: CredentialStore;
    private benchmarkStore?: BenchmarkStore;
    private agentExecutor?: AgentExecutor;

    constructor(
        registry: AuditRegistry,
        dbManager: DatabaseManager,
        getClientCount: () => number,
        registrationStore: AgentRegistrationStore,
        credentialStore: CredentialStore,
        benchmarkStore?: BenchmarkStore,
        agentExecutor?: AgentExecutor,
    ) {
        this.router = Router();
        this.registry = registry;
        this.dbManager = dbManager;
        this.startTime = Date.now();
        this.getClientCount = getClientCount;
        this.registrationStore = registrationStore;
        this.credentialStore = credentialStore;
        this.benchmarkStore = benchmarkStore;
        this.agentExecutor = agentExecutor;
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
        // Agent registration endpoints
        // ====================================================================

        // List all registrations
        this.router.get('/api/agents/registrations', (_req: Request, res: Response) => {
            const registrations = this.registrationStore.getAll();
            res.json({
                registrations: registrations.map(r => ({
                    id: r.id,
                    name: r.name,
                    version: r.version,
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
            const { scriptContent, files: artifactFiles, persist: bodyPersist, ...regBody } = req.body;
            const registration = regBody as AgentRegistration;
            if (!registration.id || !registration.name || !registration.execution) {
                res.status(400).json({ error: 'id, name, and execution are required' });
                return;
            }

            const persist = req.query.persist === 'true'
                || bodyPersist === true
                || bodyPersist === 'true';

            // Write script artifacts to disk when provided
            if (persist && scriptContent && registration.execution.type === 'script') {
                const artifacts: Array<{ name: string; content: string }> = [];
                artifacts.push({ name: registration.execution.scriptPath, content: scriptContent });
                if (Array.isArray(artifactFiles)) {
                    for (const f of artifactFiles) {
                        if (f.name && f.content) {
                            artifacts.push({ name: f.name, content: f.content });
                        }
                    }
                }
                const artifactDir = this.registrationStore.writeArtifacts(registration.id, artifacts);
                // Update scriptPath to absolute so the executor can find it
                registration.execution.scriptPath = path.join(artifactDir, registration.execution.scriptPath);
            }

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

        // Reload registrations from disk
        this.router.post('/api/agents/registrations/reload', (_req: Request, res: Response) => {
            this.registrationStore.reload();
            res.json({ reloaded: this.registrationStore.size });
        });

        // Get declared inputs for a registration (lightweight alternative to full GET)
        this.router.get('/api/agents/registrations/:id/inputs', (req: Request, res: Response) => {
            const reg = this.registrationStore.get(req.params.id);
            if (!reg) {
                res.status(404).json({ error: 'Agent registration not found' });
                return;
            }
            res.json(reg.interface.inputs);
        });

        // ====================================================================
        // Credential endpoints
        // ====================================================================

        // List credentials (masked keys only)
        this.router.get('/api/credentials', (req: Request, res: Response) => {
            const provider = req.query.provider as string | undefined;
            res.json({ credentials: this.credentialStore.list(provider) });
        });

        // Add a credential
        this.router.post('/api/credentials', (req: Request, res: Response) => {
            const { provider, name, apiKey } = req.body;
            if (!provider || !name || !apiKey) {
                res.status(400).json({ error: 'provider, name, and apiKey are required' });
                return;
            }
            const credential = this.credentialStore.save(provider, name, apiKey);
            res.status(201).json({
                id: credential.id,
                provider: credential.provider,
                name: credential.name,
                maskedKey: '****' + apiKey.slice(-4),
                createdAt: credential.createdAt,
            });
        });

        // Delete a credential
        this.router.delete('/api/credentials/:id', (req: Request, res: Response) => {
            const removed = this.credentialStore.remove(req.params.id);
            if (removed) {
                res.json({ deleted: true });
            } else {
                res.status(404).json({ error: 'Credential not found' });
            }
        });

        // ====================================================================
        // Benchmark endpoints
        // ====================================================================

        // List contests
        this.router.get('/api/benchmarks/contests', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const source = req.query.source as string | undefined;
            const temporalBucket = req.query.temporalBucket as string | undefined;
            const contests = this.benchmarkStore.listContests({ source, temporalBucket });
            res.json({ contests, total: contests.length });
        });

        // Get single contest
        this.router.get('/api/benchmarks/contests/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const contest = this.benchmarkStore.getContest(req.params.id);
            if (!contest) {
                res.status(404).json({ error: 'Contest not found' });
                return;
            }
            res.json(contest);
        });

        // Upsert contest
        this.router.post('/api/benchmarks/contests', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const contest = req.body;
            if (!contest.id || !contest.name || !contest.source) {
                res.status(400).json({ error: 'id, name, and source are required' });
                return;
            }
            this.benchmarkStore.upsertContest(contest);
            res.status(201).json({ upserted: contest.id });
        });

        // Get findings for contest
        this.router.get('/api/benchmarks/contests/:id/findings', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const findings = this.benchmarkStore.getFindingsForContest(req.params.id);
            res.json({ findings, total: findings.length });
        });

        // Upsert findings for contest
        this.router.post('/api/benchmarks/contests/:id/findings', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const { findings } = req.body;
            if (!Array.isArray(findings)) {
                res.status(400).json({ error: 'findings array is required' });
                return;
            }
            for (const finding of findings) {
                finding.contestId = req.params.id;
                this.benchmarkStore.upsertFinding(finding);
            }
            res.status(201).json({ upserted: findings.length });
        });

        // Create a benchmark run
        this.router.post('/api/benchmarks/runs', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const run = req.body;
            if (!run.id || !run.agentId || !run.contestId) {
                res.status(400).json({ error: 'id, agentId, and contestId are required' });
                return;
            }
            this.benchmarkStore.createRun(run);
            res.status(201).json({ created: run.id });
        });

        // Get run status
        this.router.get('/api/benchmarks/runs/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const run = this.benchmarkStore.getRun(req.params.id);
            if (!run) {
                res.status(404).json({ error: 'Run not found' });
                return;
            }
            res.json(run);
        });

        // Update run status
        this.router.patch('/api/benchmarks/runs/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const run = this.benchmarkStore.getRun(req.params.id);
            if (!run) {
                res.status(404).json({ error: 'Run not found' });
                return;
            }
            this.benchmarkStore.updateRun(req.params.id, req.body);
            res.json({ updated: req.params.id });
        });

        // List runs (filterable by agentId, contestId)
        this.router.get('/api/benchmarks/runs', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const agentId = req.query.agentId as string | undefined;
            const contestId = req.query.contestId as string | undefined;
            const runs = this.benchmarkStore.listRuns({ agentId, contestId });
            res.json({ runs, total: runs.length });
        });

        // Save evaluation result
        this.router.post('/api/benchmarks/results', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const result = req.body;
            if (!result.id || !result.runId || !result.agentId) {
                res.status(400).json({ error: 'id, runId, and agentId are required' });
                return;
            }
            this.benchmarkStore.saveResult(result);
            res.status(201).json({ saved: result.id });
        });

        // List results (filterable by agentId, contestId)
        this.router.get('/api/benchmarks/results', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const agentId = req.query.agentId as string | undefined;
            const contestId = req.query.contestId as string | undefined;
            const results = this.benchmarkStore.listResults({ agentId, contestId });
            res.json({ results, total: results.length });
        });

        // Agent score history (for trend charts)
        this.router.get('/api/benchmarks/agents/:id/history', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const history = this.benchmarkStore.getAgentHistory(req.params.id);
            res.json({ history, total: history.length });
        });

        // Import Sherlock index data
        this.router.post('/api/benchmarks/import/sherlock', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const { indexPath } = req.body;
            if (!indexPath) {
                res.status(400).json({ error: 'indexPath is required' });
                return;
            }
            try {
                const result = importSherlockIndex(this.benchmarkStore, indexPath);
                res.json({ imported: result });
            } catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });

        // ====================================================================
        // Agent execution endpoints
        // ====================================================================

        // Launch an agent
        this.router.post('/api/agents/executions', (req: Request, res: Response) => {
            if (!this.agentExecutor) {
                res.status(503).json({ error: 'Agent executor not initialized' });
                return;
            }
            const { registrationId, workspacePath, auditSlug, timeout, env, overrides, inputs } = req.body;
            if (!registrationId || !workspacePath) {
                res.status(400).json({ error: 'registrationId and workspacePath are required' });
                return;
            }

            // Route typed inputs to overrides/env based on registration declarations
            let resolvedOverrides = { ...(overrides || {}) };
            let resolvedEnv = { ...(env || {}) };

            if (inputs && typeof inputs === 'object') {
                const reg = this.registrationStore.get(registrationId);
                for (const [name, value] of Object.entries(inputs as Record<string, unknown>)) {
                    const decl = reg?.interface.inputs.find(i => i.name === name);
                    if (decl?.type === 'workspace') continue;
                    if (decl?.type === 'env') {
                        resolvedEnv[name] = String(value);
                    } else {
                        // Declared string/file inputs and undeclared inputs route to overrides
                        resolvedOverrides[name] = String(value);
                    }
                }
            }

            const instanceId = `${registrationId}-${Date.now().toString(36)}`;
            try {
                const handle = this.agentExecutor.launch(registrationId, {
                    instanceId,
                    auditSlug: auditSlug || 'benchmark',
                    workspacePath,
                    mcpServerUrl: '',
                    timeout,
                    env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
                    overrides: Object.keys(resolvedOverrides).length > 0 ? resolvedOverrides : undefined,
                });
                res.status(201).json(handle);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('not found') || msg.includes('Missing required inputs')) {
                    const status = msg.includes('not found') ? 404 : 400;
                    res.status(status).json({ error: msg });
                } else {
                    res.status(400).json({ error: msg });
                }
            }
        });

        // List all executions
        this.router.get('/api/agents/executions', (_req: Request, res: Response) => {
            if (!this.agentExecutor) {
                res.status(503).json({ error: 'Agent executor not initialized' });
                return;
            }
            res.json(this.agentExecutor.listAll());
        });

        // Get execution status
        this.router.get('/api/agents/executions/:instanceId', (req: Request, res: Response) => {
            if (!this.agentExecutor) {
                res.status(503).json({ error: 'Agent executor not initialized' });
                return;
            }
            const handle = this.agentExecutor.get(req.params.instanceId);
            if (!handle) {
                res.status(404).json({ error: 'Execution not found' });
                return;
            }
            res.json(handle);
        });

        // Get execution output
        this.router.get('/api/agents/executions/:instanceId/output', (req: Request, res: Response) => {
            if (!this.agentExecutor) {
                res.status(503).json({ error: 'Agent executor not initialized' });
                return;
            }
            const output = this.agentExecutor.getOutput(req.params.instanceId);
            if (!output) {
                res.status(404).json({ error: 'Execution not found' });
                return;
            }
            res.json(output);
        });

        // Stop an execution
        this.router.delete('/api/agents/executions/:instanceId', (req: Request, res: Response) => {
            if (!this.agentExecutor) {
                res.status(503).json({ error: 'Agent executor not initialized' });
                return;
            }
            const stopped = this.agentExecutor.stop(req.params.instanceId);
            if (!stopped) {
                res.status(404).json({ error: 'Execution not found or already finished' });
                return;
            }
            res.json({ stopped: req.params.instanceId });
        });
    }
}
