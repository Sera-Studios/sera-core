/**
 * @fileoverview Pipeline execution engine
 * @module sera-core/pipeline/PipelineEngine
 *
 * Orchestrates pipeline execution by walking the DAG, dispatching nodes
 * to handlers, managing state transitions, and emitting events.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
    PipelineSpec,
    PipelineRun,
    PipelineRunState,
    NodeRun,
    NodeOutput,
    PipelineExecutionEvent,
    ConcurrencyLimits,
    NodeExecutionContext,
    GraphWalkerState,
} from '@sera/types';
import {
    initializeState,
    getReadyNodes,
    markNodeStarted,
    markNodeCompleted,
    markNodeFailed,
    markNodeSkipped,
    evaluateConditionalEdges,
    resolveNodeInputs,
} from './GraphWalker';
import { HandlerRegistry } from './handlers';
import { PipelinePersistence } from './PipelinePersistence';
import type { AgentLifecycleManager } from '../agents/AgentLifecycleManager';
import type { EventBridge } from '../events/EventBridge';

interface ActiveRun {
    run: PipelineRun;
    spec: PipelineSpec;
    walkerState: GraphWalkerState;
    paused: boolean;
    cancelled: boolean;
    resumeResolve?: () => void;
}

/**
 * Pipeline execution engine.
 * Manages the full lifecycle of pipeline runs: execute, pause, resume, cancel.
 */
export class PipelineEngine {
    private persistence: PipelinePersistence;
    private handlerRegistry: HandlerRegistry;
    private agentManager: AgentLifecycleManager;
    private bridge: EventBridge;
    private mcpPort: number;
    private activeRuns: Map<string, ActiveRun> = new Map();

    constructor(
        persistence: PipelinePersistence,
        agentManager: AgentLifecycleManager,
        bridge: EventBridge,
        mcpPort: number
    ) {
        this.persistence = persistence;
        this.agentManager = agentManager;
        this.bridge = bridge;
        this.mcpPort = mcpPort;

        // Create handler registry with sub-pipeline execution callback
        this.handlerRegistry = new HandlerRegistry(
            agentManager,
            (event) => this.emitEvent(event),
            (spec, variables, auditSlug, depth) => this.executeSubPipeline(spec, variables, auditSlug, depth)
        );
    }

    /**
     * Execute a pipeline spec.
     * @param spec - Pipeline specification
     * @param variables - Runtime variable overrides
     * @param auditSlug - Audit to execute against
     * @param workspacePath - Workspace path for file access
     * @returns The completed pipeline run
     */
    async execute(
        spec: PipelineSpec,
        variables: Record<string, unknown>,
        auditSlug: string,
        workspacePath?: string
    ): Promise<PipelineRun> {
        // Ensure tables exist
        await this.persistence.ensureTables(auditSlug);

        // Create run record
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
            state: 'initializing',
            variables: this.resolveVariables(spec, variables),
            concurrency,
            startedAt: new Date().toISOString(),
            progress: 0,
        };

        await this.persistence.createRun(auditSlug, run);

        // Create temp directory for this run
        const tempDir = path.join(os.tmpdir(), 'sera-pipeline', runId);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        // Initialize walker state
        const walkerState = initializeState(spec);

        const activeRun: ActiveRun = {
            run,
            spec,
            walkerState,
            paused: false,
            cancelled: false,
        };
        this.activeRuns.set(runId, activeRun);

        // Emit started event
        run.state = 'running';
        await this.persistence.updateRun(auditSlug, runId, { state: 'running' });
        this.emitEvent({ runId, type: 'pipeline:started' });

        try {
            await this.runLoop(activeRun, tempDir, workspacePath);

            if (activeRun.cancelled) {
                run.state = 'cancelled';
                run.completedAt = new Date().toISOString();
                this.emitEvent({ runId, type: 'pipeline:cancelled' });
            } else if (activeRun.paused) {
                // Still paused - don't mark as completed
            } else {
                run.state = 'completed';
                run.completedAt = new Date().toISOString();
                run.progress = 1;
                this.emitEvent({ runId, type: 'pipeline:completed' });
            }
        } catch (err) {
            run.state = 'failed';
            run.error = err instanceof Error ? err.message : String(err);
            run.completedAt = new Date().toISOString();
            this.emitEvent({ runId, type: 'pipeline:failed', payload: { error: run.error } });
        }

        await this.persistence.updateRun(auditSlug, runId, {
            state: run.state,
            completedAt: run.completedAt,
            error: run.error,
            progress: run.progress,
        });

        this.activeRuns.delete(runId);
        return run;
    }

    /**
     * Pause a running pipeline.
     */
    async pause(runId: string): Promise<void> {
        const active = this.activeRuns.get(runId);
        if (!active || active.paused || active.cancelled) return;

        active.paused = true;
        active.run.state = 'paused';

        await this.persistence.updateRun(active.run.auditSlug, runId, { state: 'paused' });
        await this.persistence.saveSnapshot(active.run.auditSlug, {
            runId,
            timestamp: new Date().toISOString(),
            walkerState: active.walkerState,
        });

        this.emitEvent({ runId, type: 'pipeline:paused' });
    }

    /**
     * Resume a paused pipeline.
     */
    async resume(runId: string): Promise<void> {
        const active = this.activeRuns.get(runId);
        if (!active || !active.paused) return;

        active.paused = false;
        active.run.state = 'running';

        await this.persistence.updateRun(active.run.auditSlug, runId, { state: 'running' });
        this.emitEvent({ runId, type: 'pipeline:resumed' });

        // Signal the run loop to continue
        if (active.resumeResolve) {
            active.resumeResolve();
            active.resumeResolve = undefined;
        }
    }

    /**
     * Cancel a running or paused pipeline.
     */
    async cancel(runId: string): Promise<void> {
        const active = this.activeRuns.get(runId);
        if (!active) return;

        active.cancelled = true;
        active.paused = false;

        // Resume if paused so the loop can exit
        if (active.resumeResolve) {
            active.resumeResolve();
            active.resumeResolve = undefined;
        }
    }

    /**
     * Resolve a HITL approval from an external source.
     */
    resolveHITL(runId: string, nodeId: string, approved: boolean): boolean {
        return this.handlerRegistry.getHITLHandler().resolveApproval(`${runId}:${nodeId}`, approved);
    }

    /**
     * Get status of a run (from active runs or persistence).
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

    private async runLoop(activeRun: ActiveRun, tempDir: string, workspacePath?: string): Promise<void> {
        const { run, spec, walkerState } = activeRun;
        const totalNodes = spec.nodes.length;

        while (true) {
            // Check for cancellation
            if (activeRun.cancelled) break;

            // Check for pause
            if (activeRun.paused) {
                await new Promise<void>(resolve => {
                    activeRun.resumeResolve = resolve;
                });
                if (activeRun.cancelled) break;
                continue;
            }

            // Get ready nodes
            const ready = getReadyNodes(walkerState, spec);
            if (ready.length === 0 && walkerState.activeSet.length === 0) {
                // Nothing left to do
                break;
            }

            if (ready.length === 0) {
                // Active nodes running but nothing ready - wait a bit
                await this.sleep(100);
                continue;
            }

            // Respect concurrency limits
            const maxConcurrent = run.concurrency.maxParallelNodes;
            const available = Math.max(0, maxConcurrent - walkerState.activeSet.length);
            const toDispatch = ready.slice(0, Math.max(1, available));

            // Dispatch nodes in parallel
            const promises = toDispatch.map(nodeId =>
                this.executeNode(activeRun, nodeId, tempDir, workspacePath)
            );

            await Promise.all(promises);

            // Update progress
            const done = walkerState.completedSet.length + walkerState.failedSet.length + walkerState.skippedSet.length;
            run.progress = totalNodes > 0 ? done / totalNodes : 0;
            await this.persistence.updateRun(run.auditSlug, run.id, { progress: run.progress });
        }
    }

    private async executeNode(
        activeRun: ActiveRun,
        nodeId: string,
        tempDir: string,
        workspacePath?: string
    ): Promise<void> {
        const { run, spec, walkerState } = activeRun;
        const node = spec.nodes.find(n => n.id === nodeId);
        if (!node) return;

        // Mark as started
        markNodeStarted(walkerState, nodeId);

        const nodeRunId = `nr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const nodeRun: NodeRun = {
            id: nodeRunId,
            runId: run.id,
            nodeId: node.id,
            nodeType: node.type,
            state: 'running',
            attempts: 1,
            startedAt: new Date().toISOString(),
        };
        await this.persistence.createNodeRun(run.auditSlug, nodeRun);
        this.emitEvent({ runId: run.id, type: 'node:started', nodeId });

        // Resolve inputs
        const inputs = resolveNodeInputs(spec, nodeId, walkerState);

        // Build execution context
        const context: NodeExecutionContext = {
            runId: run.id,
            auditSlug: run.auditSlug,
            variables: run.variables,
            mcpPort: this.mcpPort,
            tempDir,
            workspacePath,
        };

        try {
            const handler = this.handlerRegistry.get(node.type);
            const output = await handler.execute(node, inputs, context);

            // Handle condition nodes - evaluate conditional edges
            if (node.type === 'condition') {
                const conditionResult = output.data as { result: boolean };
                const targetIds = evaluateConditionalEdges(
                    spec, nodeId,
                    conditionResult as unknown as Record<string, unknown>,
                    run.variables
                );

                // Pass through outputs for downstream nodes
                markNodeCompleted(walkerState, nodeId, output, spec);

                // Skip conditional edge targets that didn't match
                const allConditionalTargets = spec.edges
                    .filter(e => e.source === nodeId && e.type === 'conditional')
                    .map(e => e.target);
                for (const target of allConditionalTargets) {
                    if (!targetIds.includes(target)) {
                        markNodeSkipped(walkerState, target);
                        this.emitEvent({ runId: run.id, type: 'node:skipped', nodeId: target });
                    }
                }
            } else {
                markNodeCompleted(walkerState, nodeId, output, spec);
            }

            nodeRun.state = 'completed';
            nodeRun.completedAt = new Date().toISOString();
            nodeRun.outputs = output;
            await this.persistence.updateNodeRun(run.auditSlug, nodeRunId, {
                state: 'completed',
                completedAt: nodeRun.completedAt,
                outputs: output,
            });
            this.emitEvent({ runId: run.id, type: 'node:completed', nodeId });

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            markNodeFailed(walkerState, nodeId, spec);

            nodeRun.state = 'failed';
            nodeRun.error = errorMsg;
            nodeRun.completedAt = new Date().toISOString();
            await this.persistence.updateNodeRun(run.auditSlug, nodeRunId, {
                state: 'failed',
                error: errorMsg,
                completedAt: nodeRun.completedAt,
            });
            this.emitEvent({
                runId: run.id,
                type: 'node:failed',
                nodeId,
                payload: { error: errorMsg },
            });

            // Check if this is a fatal failure (no error edges and not all nodes done)
            const hasErrorEdges = spec.edges.some(e => e.source === nodeId && e.type === 'error');
            if (!hasErrorEdges) {
                // Check if there are still viable paths
                const allProcessed = new Set([
                    ...walkerState.completedSet,
                    ...walkerState.failedSet,
                    ...walkerState.skippedSet,
                ]);
                const remaining = spec.nodes.filter(n => !allProcessed.has(n.id));
                if (remaining.length > 0 && walkerState.readyQueue.length === 0 && walkerState.activeSet.length === 0) {
                    throw new Error(`Pipeline failed: node "${node.name}" failed with: ${errorMsg}`);
                }
            }
        }
    }

    private async executeSubPipeline(
        spec: PipelineSpec,
        variables: Record<string, unknown>,
        auditSlug: string,
        depth: number
    ): Promise<NodeOutput> {
        // Execute sub-pipeline and return the exit node's output
        const run = await this.execute(spec, variables, auditSlug);
        if (run.state === 'failed') {
            throw new Error(`Sub-pipeline failed: ${run.error}`);
        }

        // Return aggregated outputs from exit nodes
        const nodeRuns = await this.persistence.getNodeRuns(auditSlug, run.id);
        const exitOutputs: unknown[] = [];
        for (const exitId of spec.exitNodeIds) {
            const exitNodeRun = nodeRuns.find(nr => nr.nodeId === exitId);
            if (exitNodeRun?.outputs) {
                exitOutputs.push(exitNodeRun.outputs.data);
            }
        }

        return {
            type: 'sub-pipeline-output',
            data: exitOutputs.length === 1 ? exitOutputs[0] : exitOutputs,
            metadata: { runId: run.id, state: run.state },
        };
    }

    private emitEvent(event: Omit<PipelineExecutionEvent, 'id' | 'timestamp'>): void {
        const fullEvent: PipelineExecutionEvent = {
            id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            ...event,
        };

        // Persist the event
        const active = this.activeRuns.get(event.runId);
        if (active) {
            this.persistence.logEvent(active.run.auditSlug, fullEvent).catch(() => {
                // Best effort persistence
            });
        }

        // Forward to EventBridge for connected clients
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
        // Include overrides that aren't in spec.variables
        for (const [key, value] of Object.entries(overrides)) {
            if (!(key in resolved)) {
                resolved[key] = value;
            }
        }
        return resolved;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
