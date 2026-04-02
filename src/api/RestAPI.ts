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
import { ResourceStore } from '../resources/ResourceStore';
import { VersionStore } from '../versioning/VersionStore';
import { AgentExecutor } from '../execution/AgentExecutor';
import { importSherlockIndex } from '../benchmark/importSherlock';
import { importSolanaIndex } from '../benchmark/importSolana';
import type { ResourceType, ResourceLanguage } from '@sera/types';
import { MetricsCollector } from '../monitoring/MetricsCollector';
import { FetcherRegistry } from '../benchmark/DatasetFetcher';

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
    private resourceStore?: ResourceStore;
    private versionStore?: VersionStore;
    private metricsCollector?: MetricsCollector;
    private fetcherRegistry?: FetcherRegistry;

    constructor(
        registry: AuditRegistry,
        dbManager: DatabaseManager,
        getClientCount: () => number,
        registrationStore: AgentRegistrationStore,
        credentialStore: CredentialStore,
        benchmarkStore?: BenchmarkStore,
        agentExecutor?: AgentExecutor,
        resourceStore?: ResourceStore,
        versionStore?: VersionStore,
        metricsCollector?: MetricsCollector,
        fetcherRegistry?: FetcherRegistry,
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
        this.resourceStore = resourceStore;
        this.versionStore = versionStore;
        this.metricsCollector = metricsCollector;
        this.fetcherRegistry = fetcherRegistry;
        this.setupRoutes();
    }

    /**
     * Get the Express router
     */
    getRouter(): Router {
        return this.router;
    }

    private setupRoutes(): void {
        // Health check (enhanced with dependency checks and metrics summary)
        this.router.get('/api/health', (_req: Request, res: Response) => {
            const uptime = Math.floor((Date.now() - this.startTime) / 1000);

            if (!this.metricsCollector) {
                // Minimal health response when metrics not available
                const response: HealthResponse = {
                    status: 'ok',
                    version: '0.1.0',
                    uptime,
                    audits: this.registry.listAudits().length,
                    clients: this.getClientCount(),
                };
                res.json(response);
                return;
            }

            const summary = this.metricsCollector.getSummary(60);
            const toolCounts = this.metricsCollector.getToolCallCounts(60);
            const topTools = Object.entries(toolCounts)
                .map(([name, calls]) => ({ name, calls }))
                .sort((a, b) => b.calls - a.calls)
                .slice(0, 10);

            const totalRequests = summary.requests.total;
            const totalErrors = summary.errors.length;
            const avgLatency = totalRequests > 0
                ? Math.round(
                    Object.values(summary.requests.byPath)
                        .reduce((sum, p) => sum + p.avgLatencyMs * p.count, 0) / totalRequests * 10
                  ) / 10
                : 0;

            const checks: Record<string, unknown> = {
                database: { status: 'healthy', activeAudits: this.registry.listAudits().length },
                credentialStore: { status: 'healthy' },
            };
            try {
                checks.agentStore = { status: 'healthy', agentsLoaded: this.registrationStore.size };
            } catch {
                checks.agentStore = { status: 'degraded' };
            }

            const allHealthy = Object.values(checks).every(
                (c: any) => c.status === 'healthy',
            );

            res.json({
                status: allHealthy ? 'healthy' : 'degraded',
                uptime,
                version: '0.1.0',
                clients: this.getClientCount(),
                checks,
                metrics: {
                    requestsLastHour: totalRequests,
                    errorsLastHour: totalErrors,
                    avgLatencyMs: avgLatency,
                    topTools,
                },
            });
        });

        // Detailed metrics endpoint
        this.router.get('/api/health/metrics', (req: Request, res: Response) => {
            if (!this.metricsCollector) {
                res.status(503).json({ error: 'Metrics not available' });
                return;
            }
            const minutes = req.query.minutes ? parseInt(req.query.minutes as string, 10) : 60;
            res.json(this.metricsCollector.getSummary(minutes));
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

        // List findings for an audit (used by benchmarker-dashboard evaluation flow)
        this.router.get('/api/audits/:slug/findings', async (req: Request, res: Response) => {
            const { slug } = req.params;

            if (!this.registry.auditExists(slug)) {
                res.status(404).json({ error: 'Audit not found' });
                return;
            }

            try {
                const engine = await this.dbManager.getEngine(slug);
                const status = typeof req.query.status === 'string' ? req.query.status : 'all';

                let query = `SELECT id, title, severity, filePath, startLine, endLine,
                                    description, recommendation, submittedBy,
                                    validated, validatedAt, createdAt
                             FROM notepad_notes WHERE type = 'issue'`;

                if (status === 'validated') query += ` AND validated = 1`;
                else if (status === 'unvalidated') query += ` AND validated = 0`;

                query += ` ORDER BY createdAt DESC`;

                const findings = engine.sql(query, []);
                res.json({ count: findings.length, findings });
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

        // List all registrations (optional ?role= filter)
        this.router.get('/api/agents/registrations', (req: Request, res: Response) => {
            const roleFilter = req.query.role as string | undefined;
            const registrations = roleFilter
                ? this.registrationStore.getByRole(roleFilter as import('@sera/types').AgentRole)
                : this.registrationStore.getAll();
            res.json({
                registrations: registrations.map(r => ({
                    id: r.id,
                    name: r.name,
                    version: r.version,
                    description: r.description,
                    roles: r.roles,
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
            const language = req.query.language as string | undefined;
            const difficulty = req.query.difficulty as string | undefined;
            const includeArchived = req.query.include_archived === 'true';
            const tags = req.query.tags ? (req.query.tags as string).split(',') : undefined;
            const subset = req.query.subset as string | undefined;

            let contestIds: string[] | undefined;
            if (subset) {
                const sub = this.benchmarkStore.getSubset(subset);
                if (!sub) {
                    res.status(404).json({ error: `Subset not found: ${subset}` });
                    return;
                }
                contestIds = sub.contestIds;
            }

            const contests = this.benchmarkStore.listContests({
                source, temporalBucket, language, difficulty, includeArchived, tags, contestIds,
            });
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

        // Update contest metadata (tags, difficulty, notes, archived, etc.)
        this.router.patch('/api/benchmarks/contests/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const updated = this.benchmarkStore.updateContestMetadata(req.params.id, req.body);
            if (!updated) {
                res.status(404).json({ error: 'Contest not found' });
                return;
            }
            res.json({ updated: req.params.id });
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

        // Import Solana contest data
        this.router.post('/api/benchmarks/import/solana', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const { indexPath, source } = req.body;
            if (!indexPath) {
                res.status(400).json({ error: 'indexPath is required' });
                return;
            }
            try {
                const result = importSolanaIndex(this.benchmarkStore, indexPath, source || 'ottersec');
                res.json({ imported: result });
            } catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });

        // ====================================================================
        // Contest subsets
        // ====================================================================

        // List subsets
        this.router.get('/api/benchmarks/subsets', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const subsets = this.benchmarkStore.listSubsets();
            res.json({ subsets });
        });

        // Create/update subset
        this.router.post('/api/benchmarks/subsets', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const { name, contestIds, description } = req.body;
            if (!name || !Array.isArray(contestIds)) {
                res.status(400).json({ error: 'name and contestIds array are required' });
                return;
            }
            this.benchmarkStore.upsertSubset(name, contestIds, description);
            res.status(201).json({ created: name });
        });

        // Delete subset
        this.router.delete('/api/benchmarks/subsets/:name', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const deleted = this.benchmarkStore.deleteSubset(req.params.name);
            if (!deleted) {
                res.status(404).json({ error: 'Subset not found' });
                return;
            }
            res.json({ deleted: req.params.name });
        });

        // ====================================================================
        // Benchmark category endpoints
        // ====================================================================

        // List all categories
        this.router.get('/api/benchmarks/categories', (_req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const categories = this.benchmarkStore.listCategories();
            res.json({ categories, total: categories.length });
        });

        // Get single category
        this.router.get('/api/benchmarks/categories/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const category = this.benchmarkStore.getCategory(req.params.id);
            if (!category) {
                res.status(404).json({ error: 'Category not found' });
                return;
            }
            res.json({ category });
        });

        // Create category
        this.router.post('/api/benchmarks/categories', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const { id, name, description, fetcherId, metrics } = req.body;
            if (!id || !name || !description || !fetcherId || !metrics) {
                res.status(400).json({ error: 'Missing required fields: id, name, description, fetcherId, metrics' });
                return;
            }
            const category = { id, name, description, fetcherId, metrics, createdAt: new Date().toISOString() };
            this.benchmarkStore.upsertCategory(category);
            res.status(201).json(category);
        });

        // Update category
        this.router.patch('/api/benchmarks/categories/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const existing = this.benchmarkStore.getCategory(req.params.id);
            if (!existing) {
                res.status(404).json({ error: 'Category not found' });
                return;
            }
            const updated = {
                ...existing,
                name: req.body.name ?? existing.name,
                description: req.body.description ?? existing.description,
                fetcherId: req.body.fetcherId ?? existing.fetcherId,
                metrics: req.body.metrics ?? existing.metrics,
            };
            this.benchmarkStore.upsertCategory(updated);
            res.json(updated);
        });

        // Delete category
        this.router.delete('/api/benchmarks/categories/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const deleted = this.benchmarkStore.deleteCategory(req.params.id);
            if (!deleted) {
                res.status(404).json({ error: 'Category not found' });
                return;
            }
            res.json({ deleted: req.params.id });
        });

        // ====================================================================
        // Category results & leaderboard endpoints
        // ====================================================================

        // Category leaderboard
        this.router.get('/api/benchmarks/categories/:categoryId/leaderboard', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const category = this.benchmarkStore.getCategory(req.params.categoryId);
            if (!category) {
                res.status(404).json({ error: 'Category not found' });
                return;
            }
            const datasetIdsParam = typeof req.query.dataset_ids === 'string' ? req.query.dataset_ids : undefined;
            const datasetIds = datasetIdsParam ? datasetIdsParam.split(',') : undefined;
            const evaluationAgentId = typeof req.query.evaluation_agent_id === 'string' ? req.query.evaluation_agent_id : undefined;
            const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
            const limit = limitParam && !isNaN(limitParam) ? limitParam : undefined;

            const { entries } = this.benchmarkStore.getCategoryLeaderboard(req.params.categoryId, {
                datasetIds,
                evaluationAgentId,
                limit,
            });

            const datasets = this.benchmarkStore.listDatasets(req.params.categoryId);

            res.json({
                categoryId: category.id,
                categoryName: category.name,
                metrics: category.metrics,
                datasets: datasets.map(d => ({ id: d.id, name: d.name })),
                leaderboard: entries,
            });
        });

        // List category results
        this.router.get('/api/benchmarks/categories/:categoryId/results', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const executionAgentId = typeof req.query.execution_agent_id === 'string' ? req.query.execution_agent_id : undefined;
            const datasetId = typeof req.query.dataset_id === 'string' ? req.query.dataset_id : undefined;

            const results = this.benchmarkStore.listCategoryResults({
                categoryId: req.params.categoryId,
                executionAgentId,
                datasetId,
            });
            res.json({ results });
        });

        // Save a category result
        this.router.post('/api/benchmarks/category-results', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const result = req.body;
            if (!result.id || !result.categoryId || !result.datasetId || !result.metrics) {
                res.status(400).json({ error: 'id, categoryId, datasetId, and metrics are required' });
                return;
            }
            this.benchmarkStore.saveCategoryResult(result);
            res.status(201).json({ saved: result.id });
        });

        // Get a single category result
        this.router.get('/api/benchmarks/category-results/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const result = this.benchmarkStore.getCategoryResult(req.params.id);
            if (!result) {
                res.status(404).json({ error: 'Result not found' });
                return;
            }
            res.json({ result });
        });

        // ====================================================================
        // Dataset endpoints
        // ====================================================================

        // List fetchers (must be before /api/datasets/:id to avoid matching 'fetchers' as :id)
        this.router.get('/api/datasets/fetchers', (_req: Request, res: Response) => {
            if (!this.fetcherRegistry) {
                res.status(503).json({ error: 'Fetcher registry not initialized' });
                return;
            }
            res.json({ fetchers: this.fetcherRegistry.list() });
        });

        // List datasets (optional ?category_id filter)
        this.router.get('/api/datasets', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const categoryId = req.query.category_id as string | undefined;
            const datasets = this.benchmarkStore.listDatasets(categoryId);
            res.json({ datasets });
        });

        // Get dataset by ID
        this.router.get('/api/datasets/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const dataset = this.benchmarkStore.getDataset(req.params.id);
            if (!dataset) {
                res.status(404).json({ error: 'Dataset not found' });
                return;
            }
            res.json({ dataset });
        });

        // Import dataset (triggers fetcher)
        this.router.post('/api/datasets/import', async (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const { categoryId, sourceId, sourceType, options } = req.body;
            if (!categoryId || !sourceId || !sourceType) {
                res.status(400).json({ error: 'categoryId, sourceId, and sourceType are required' });
                return;
            }

            // Check if dataset already exists
            const existing = this.benchmarkStore.findDatasetBySource(sourceId, sourceType, categoryId);
            if (existing) {
                res.json({ dataset: existing, cached: true });
                return;
            }

            // Look up category to find fetcher
            const category = this.benchmarkStore.getCategory(categoryId);
            if (!category) {
                res.status(404).json({ error: `Category not found: ${categoryId}` });
                return;
            }

            if (!this.fetcherRegistry) {
                res.status(503).json({ error: 'Fetcher registry not initialized' });
                return;
            }

            const fetcher = this.fetcherRegistry.get(category.fetcherId);
            if (!fetcher) {
                res.status(400).json({ error: `Fetcher not found: ${category.fetcherId}` });
                return;
            }

            try {
                const result = await fetcher.fetch(sourceId, sourceType, options || {});
                const datasetId = `ds-${categoryId}-${sourceId}`;
                const dataset = {
                    ...result.dataset,
                    id: datasetId,
                    fetchedAt: new Date().toISOString(),
                };
                this.benchmarkStore.upsertDataset(dataset);

                // Store ground truth based on fetcher type
                if (category.fetcherId === 'valid-findings' && Array.isArray(result.groundTruth)) {
                    for (const finding of result.groundTruth) {
                        this.benchmarkStore.upsertFinding(finding);
                    }
                } else if (category.fetcherId === 'all-submissions-with-labels' && Array.isArray(result.groundTruth)) {
                    const submissions = result.groundTruth as Array<{
                        id: string; externalId: string; severity: string;
                        title: string; description: string; impact?: string;
                        affectedFiles?: Array<{ path: string; lines?: { start: number; end: number } }>;
                        labels?: string[]; isValid: boolean; rejectionReason?: string;
                    }>;
                    this.benchmarkStore.batchUpsertDatasetSubmissions(
                        submissions.map(s => ({ ...s, datasetId }))
                    );
                }

                res.json({ dataset, cached: false });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                res.status(500).json({ error: `Fetch failed: ${message}` });
            }
        });

        // Delete dataset
        this.router.delete('/api/datasets/:id', (req: Request, res: Response) => {
            if (!this.benchmarkStore) {
                res.status(503).json({ error: 'Benchmark store not initialized' });
                return;
            }
            const deleted = this.benchmarkStore.deleteDataset(req.params.id);
            if (!deleted) {
                res.status(404).json({ error: 'Dataset not found' });
                return;
            }
            res.json({ deleted: req.params.id });
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

        // ====================================================================
        // Resource endpoints (audit knowledge management)
        // ====================================================================

        // List resources with optional filters
        this.router.get('/api/resources', (req: Request, res: Response) => {
            if (!this.resourceStore) {
                res.status(503).json({ error: 'Resource store not initialized' });
                return;
            }
            const type = req.query.type as ResourceType | undefined;
            const language = req.query.language as ResourceLanguage | undefined;
            const search = req.query.search as string | undefined;
            const tagsParam = req.query.tags as string | undefined;
            const tags = tagsParam ? tagsParam.split(',') : undefined;

            const resources = this.resourceStore.list({ type, language, tags, search });
            res.json({ resources, total: resources.length });
        });

        // Get single resource by ID
        this.router.get('/api/resources/:id', (req: Request, res: Response) => {
            if (!this.resourceStore) {
                res.status(503).json({ error: 'Resource store not initialized' });
                return;
            }
            const resource = this.resourceStore.get(req.params.id);
            if (!resource) {
                res.status(404).json({ error: 'Resource not found' });
                return;
            }
            res.json({ resource });
        });

        // Create a resource
        this.router.post('/api/resources', (req: Request, res: Response) => {
            if (!this.resourceStore) {
                res.status(503).json({ error: 'Resource store not initialized' });
                return;
            }
            const { type, name, content, language, tags, metadata } = req.body;
            if (!type || !name || !content) {
                res.status(400).json({ error: 'type, name, and content are required' });
                return;
            }
            try {
                const resource = this.resourceStore.create({ type, name, content, language, tags, metadata });
                res.status(201).json({ resource_id: resource.id, slug: resource.slug, version: resource.version });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('already exists')) {
                    res.status(409).json({ error: msg });
                } else {
                    res.status(500).json({ error: msg });
                }
            }
        });

        // Update a resource
        this.router.patch('/api/resources/:id', (req: Request, res: Response) => {
            if (!this.resourceStore) {
                res.status(503).json({ error: 'Resource store not initialized' });
                return;
            }
            const { name, content, tags, language, metadata } = req.body;
            const resource = this.resourceStore.update(req.params.id, { name, content, tags, language, metadata });
            if (!resource) {
                res.status(404).json({ error: 'Resource not found' });
                return;
            }
            res.json({ resource_id: resource.id, version: resource.version, updated: true });
        });

        // Delete a resource
        this.router.delete('/api/resources/:id', (req: Request, res: Response) => {
            if (!this.resourceStore) {
                res.status(503).json({ error: 'Resource store not initialized' });
                return;
            }
            const deleted = this.resourceStore.delete(req.params.id);
            if (!deleted) {
                res.status(404).json({ error: 'Resource not found' });
                return;
            }
            res.json({ resource_id: req.params.id, deleted: true });
        });

        // ====================================================================
        // Version lineage endpoints
        // ====================================================================

        // List versions for an agent
        this.router.get('/api/versions', (req: Request, res: Response) => {
            if (!this.versionStore) {
                res.status(503).json({ error: 'Version store not initialized' });
                return;
            }
            const agentId = req.query.agent_id as string;
            if (!agentId) {
                res.status(400).json({ error: 'agent_id query parameter is required' });
                return;
            }
            const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
            const versions = this.versionStore.getVersionsByAgent(agentId, limit);
            res.json({ versions, total: versions.length });
        });

        // Get version by ID
        this.router.get('/api/versions/:id', (req: Request, res: Response) => {
            if (!this.versionStore) {
                res.status(503).json({ error: 'Version store not initialized' });
                return;
            }
            const version = this.versionStore.getVersion(req.params.id);
            if (!version) {
                res.status(404).json({ error: 'Version not found' });
                return;
            }
            res.json({ version });
        });

        // Get lineage for a version
        this.router.get('/api/versions/:id/lineage', (req: Request, res: Response) => {
            if (!this.versionStore) {
                res.status(503).json({ error: 'Version store not initialized' });
                return;
            }
            const lineage = this.versionStore.getLineage(req.params.id);
            res.json({ lineage, total: lineage.length });
        });

        // ====================================================================
        // Experiment endpoints
        // ====================================================================

        // Experiment summary (register BEFORE /:id to avoid param capture)
        this.router.get('/api/experiments/summary', (req: Request, res: Response) => {
            if (!this.versionStore) {
                res.status(503).json({ error: 'Version store not initialized' });
                return;
            }
            const agentId = req.query.agent_id as string;
            if (!agentId) {
                res.status(400).json({ error: 'agent_id query parameter is required' });
                return;
            }
            const since = req.query.since as string | undefined;
            const summary = this.versionStore.getExperimentSummary(agentId, since);
            res.json(summary);
        });

        // List experiments
        this.router.get('/api/experiments', (req: Request, res: Response) => {
            if (!this.versionStore) {
                res.status(503).json({ error: 'Version store not initialized' });
                return;
            }
            const agentId = req.query.agent_id as string;
            if (!agentId) {
                res.status(400).json({ error: 'agent_id query parameter is required' });
                return;
            }
            const status = req.query.status as string | undefined;
            const modificationType = req.query.modification_type as string | undefined;
            const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

            const experiments = this.versionStore.listExperiments(agentId, {
                status: status as any,
                modificationType: modificationType as any,
                limit,
            });
            res.json({ experiments, total: experiments.length });
        });

        // Get experiment by ID
        this.router.get('/api/experiments/:id', (req: Request, res: Response) => {
            if (!this.versionStore) {
                res.status(503).json({ error: 'Version store not initialized' });
                return;
            }
            const experiment = this.versionStore.getExperiment(req.params.id);
            if (!experiment) {
                res.status(404).json({ error: 'Experiment not found' });
                return;
            }
            res.json({ experiment });
        });
    }
}
