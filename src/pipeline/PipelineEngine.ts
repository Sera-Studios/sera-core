/**
 * @fileoverview Pipeline execution engine (compile-then-run)
 * @module sera-core/pipeline/PipelineEngine
 *
 * Compiles pipeline specs to executable scripts using framework-specific
 * compilers, then runs them as subprocesses. Also manages spec CRUD
 * and run tracking via PipelinePersistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import type {
    PipelineSpec,
    PipelineRun,
    PipelineRunState,
    NodeRun,
    PipelineExecutionEvent,
    ConcurrencyLimits,
} from '@sera/types';
import { PipelinePersistence } from './PipelinePersistence';
import { CompilerRegistry } from '../compiler/CompilerRegistry';
import type { EventBridge } from '../events/EventBridge';

interface ActiveRun {
    run: PipelineRun;
    process: ChildProcess;
    outputLines: string[];
}

/**
 * Pipeline execution engine.
 * Compiles specs to Python scripts and runs them as subprocesses.
 */
export class PipelineEngine {
    private persistence: PipelinePersistence;
    private compilerRegistry: CompilerRegistry;
    private bridge: EventBridge;
    private activeRuns: Map<string, ActiveRun> = new Map();

    constructor(
        persistence: PipelinePersistence,
        compilerRegistry: CompilerRegistry,
        bridge: EventBridge
    ) {
        this.persistence = persistence;
        this.compilerRegistry = compilerRegistry;
        this.bridge = bridge;
    }

    /**
     * Compile a pipeline spec without executing it.
     * @param spec - Pipeline specification
     * @param variables - Runtime variable overrides
     * @returns Generated script and supporting files
     */
    compile(spec: PipelineSpec, variables?: Record<string, unknown>) {
        const framework = spec.framework ?? 'pydantic-ai';
        const compiler = this.compilerRegistry.getCompiler(framework);
        return compiler.compile(spec, variables);
    }

    /**
     * Execute a pipeline spec by compiling and running it.
     * @param spec - Pipeline specification
     * @param variables - Runtime variable overrides
     * @param auditSlug - Audit to execute against
     * @param workspacePath - Workspace path for file access
     * @returns The pipeline run record
     */
    async execute(
        spec: PipelineSpec,
        variables: Record<string, unknown>,
        auditSlug: string,
        workspacePath?: string
    ): Promise<PipelineRun> {
        await this.persistence.ensureTables(auditSlug);

        // Compile spec to script
        const framework = spec.framework ?? 'pydantic-ai';
        const compiler = this.compilerRegistry.getCompiler(framework);
        const compiled = compiler.compile(spec, variables);

        if (compiled.warnings.length > 0) {
            console.log(`[pipeline] Compilation warnings: ${compiled.warnings.join(', ')}`);
        }

        // Write compiled files to temp directory
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tempDir = path.join(os.tmpdir(), 'sera-pipeline', runId);
        fs.mkdirSync(tempDir, { recursive: true });

        fs.writeFileSync(path.join(tempDir, compiled.scriptFilename), compiled.script, 'utf-8');
        for (const file of compiled.files) {
            fs.writeFileSync(path.join(tempDir, file.name), file.content, 'utf-8');
        }

        // Write pipeline spec for reference
        fs.writeFileSync(
            path.join(tempDir, 'pipeline.json'),
            JSON.stringify(spec, null, 2),
            'utf-8'
        );

        // Create run record
        const concurrency: ConcurrencyLimits = {
            maxParallelNodes: 4,
            maxParallelAgents: 2,
            maxDockerContainers: 2,
        };

        const run: PipelineRun = {
            id: runId,
            pipelineId: spec.id,
            pipelineSpecVersion: spec.version,
            auditSlug,
            state: 'running',
            variables: this.resolveVariables(spec, variables),
            concurrency,
            startedAt: new Date().toISOString(),
            progress: 0,
        };

        await this.persistence.createRun(auditSlug, run);
        this.emitEvent({ runId, type: 'pipeline:started' });

        // Spawn process
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            WORKSPACE_PATH: workspacePath ?? '',
            AUDIT_SLUG: auditSlug,
        };

        // Set pipeline variables as env vars
        for (const [key, value] of Object.entries(run.variables)) {
            env[`PIPELINE_VAR_${key.toUpperCase()}`] = String(value);
        }

        const child = spawn('python3', [compiled.scriptFilename], {
            cwd: tempDir,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const activeRun: ActiveRun = { run, process: child, outputLines: [] };
        this.activeRuns.set(runId, activeRun);

        // Monitor stdout for JSON-line events
        child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                activeRun.outputLines.push(trimmed);
                this.handleOutputLine(activeRun, trimmed);
            }
        });

        // Capture stderr
        child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString().trim();
            if (text) console.log(`[pipeline:${runId}] stderr: ${text}`);
        });

        // Wait for process to complete
        return new Promise<PipelineRun>((resolve) => {
            child.on('close', async (code) => {
                this.activeRuns.delete(runId);

                if (code === 0) {
                    run.state = 'completed';
                    run.progress = 1;
                    this.emitEvent({ runId, type: 'pipeline:completed' });
                } else if (code === 2) {
                    run.state = 'cancelled';
                    this.emitEvent({ runId, type: 'pipeline:cancelled' });
                } else {
                    run.state = 'failed';
                    run.error = `Process exited with code ${code}`;
                    this.emitEvent({ runId, type: 'pipeline:failed', payload: { error: run.error } });
                }

                run.completedAt = new Date().toISOString();
                await this.persistence.updateRun(auditSlug, runId, {
                    state: run.state,
                    completedAt: run.completedAt,
                    error: run.error,
                    progress: run.progress,
                });

                resolve(run);
            });

            child.on('error', async (err) => {
                this.activeRuns.delete(runId);
                run.state = 'failed';
                run.error = err.message;
                run.completedAt = new Date().toISOString();

                await this.persistence.updateRun(auditSlug, runId, {
                    state: run.state,
                    completedAt: run.completedAt,
                    error: run.error,
                });

                this.emitEvent({ runId, type: 'pipeline:failed', payload: { error: run.error } });
                resolve(run);
            });
        });
    }

    /**
     * Pause a running pipeline by sending SIGUSR1 to the process.
     */
    async pause(runId: string): Promise<void> {
        const active = this.activeRuns.get(runId);
        if (!active) return;

        active.process.kill('SIGUSR1');
        active.run.state = 'paused';
        await this.persistence.updateRun(active.run.auditSlug, runId, { state: 'paused' });
    }

    /**
     * Resume a paused pipeline by sending SIGUSR2 to the process.
     */
    async resume(runId: string): Promise<void> {
        const active = this.activeRuns.get(runId);
        if (!active) return;

        active.process.kill('SIGUSR2');
        active.run.state = 'running';
        await this.persistence.updateRun(active.run.auditSlug, runId, { state: 'running' });
    }

    /**
     * Cancel a running or paused pipeline by sending SIGTERM.
     */
    async cancel(runId: string): Promise<void> {
        const active = this.activeRuns.get(runId);
        if (!active) return;

        active.process.kill('SIGTERM');
    }

    /**
     * Get status of a run.
     */
    async getStatus(runId: string, auditSlug: string): Promise<PipelineRun | null> {
        const active = this.activeRuns.get(runId);
        if (active) return active.run;
        return this.persistence.getRun(auditSlug, runId);
    }

    /**
     * Get node runs for a pipeline run.
     */
    async getNodeRuns(runId: string, auditSlug: string): Promise<NodeRun[]> {
        return this.persistence.getNodeRuns(auditSlug, runId);
    }

    /**
     * Get events for a pipeline run.
     */
    async getEvents(runId: string, auditSlug: string): Promise<PipelineExecutionEvent[]> {
        return this.persistence.getEvents(auditSlug, runId);
    }

    /**
     * List pipeline runs.
     */
    async listRuns(auditSlug?: string): Promise<PipelineRun[]> {
        return this.persistence.listRuns(auditSlug);
    }

    /**
     * Save a pipeline spec.
     */
    async saveSpec(auditSlug: string, spec: PipelineSpec): Promise<void> {
        await this.persistence.ensureTables(auditSlug);
        await this.persistence.saveSpec(auditSlug, spec);
    }

    /**
     * Get a pipeline spec.
     */
    async getSpec(auditSlug: string, specId: string): Promise<PipelineSpec | null> {
        return this.persistence.getSpec(auditSlug, specId);
    }

    /**
     * List pipeline specs.
     */
    async listSpecs(auditSlug: string): Promise<Array<{ id: string; name: string; version: string; updatedAt: string }>> {
        await this.persistence.ensureTables(auditSlug);
        return this.persistence.listSpecs(auditSlug);
    }

    /**
     * Stop all active pipeline runs. Called during shutdown.
     */
    async stopAll(): Promise<void> {
        for (const [runId] of this.activeRuns) {
            await this.cancel(runId);
        }
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    /**
     * Process a JSON-line output from the running pipeline script.
     */
    private handleOutputLine(activeRun: ActiveRun, line: string): void {
        try {
            const parsed = JSON.parse(line);
            const eventType = parsed.event as string;
            if (!eventType) return;

            const nodeId = parsed.nodeId as string | undefined;
            const data = parsed.data as Record<string, unknown> | undefined;

            // Persist as execution event
            this.emitEvent({
                runId: activeRun.run.id,
                type: eventType as PipelineExecutionEvent['type'],
                nodeId,
                payload: data,
            });

            // Track node state changes for persistence
            if (eventType === 'node:started' && nodeId) {
                const nodeRunId = `nr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                this.persistence.createNodeRun(activeRun.run.auditSlug, {
                    id: nodeRunId,
                    runId: activeRun.run.id,
                    nodeId,
                    nodeType: 'llm-agent', // Type not available from output line
                    state: 'running',
                    attempts: 1,
                    startedAt: new Date().toISOString(),
                }).catch(() => { /* best effort */ });
            }

            if (eventType === 'node:completed' && nodeId) {
                // Update progress estimate
                const completed = activeRun.outputLines.filter(l => {
                    try { return JSON.parse(l).event === 'node:completed'; } catch { return false; }
                }).length;
                activeRun.run.progress = Math.min(0.99, completed * 0.1);
            }
        } catch {
            // Not JSON - just log output
        }
    }

    private emitEvent(event: Omit<PipelineExecutionEvent, 'id' | 'timestamp'>): void {
        const fullEvent: PipelineExecutionEvent = {
            id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            ...event,
        };

        const active = this.activeRuns.get(event.runId);
        if (active) {
            this.persistence.logEvent(active.run.auditSlug, fullEvent).catch(() => {
                // Best effort persistence
            });
        }

        this.bridge.broadcastBridgeEvent({
            event: `pipeline:${fullEvent.type}`,
            source: 'pipeline-engine',
            auditSlug: active?.run.auditSlug ?? '',
            timestamp: fullEvent.timestamp,
            data: {
                runId: fullEvent.runId,
                nodeId: fullEvent.nodeId,
                payload: fullEvent.payload,
            },
        });
    }

    private resolveVariables(spec: PipelineSpec, overrides: Record<string, unknown>): Record<string, unknown> {
        const resolved: Record<string, unknown> = {};
        if (spec.variables) {
            for (const [key, def] of Object.entries(spec.variables)) {
                resolved[key] = overrides[key] ?? def.default;
            }
        }
        for (const [key, value] of Object.entries(overrides)) {
            if (!(key in resolved)) {
                resolved[key] = value;
            }
        }
        return resolved;
    }
}
