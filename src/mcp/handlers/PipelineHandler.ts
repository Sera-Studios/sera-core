/**
 * @fileoverview Pipeline Management MCP Handler
 * @module sera-core/mcp/handlers/PipelineHandler
 *
 * Exposes pipeline lifecycle tools via MCP:
 * - execute_pipeline: Execute a pipeline spec
 * - get_pipeline_status: Get run status and node states
 * - list_pipeline_runs: List runs for an audit
 * - pause_pipeline: Pause a running pipeline
 * - resume_pipeline: Resume a paused pipeline
 * - cancel_pipeline: Cancel a running/paused pipeline
 */

import type {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
    PipelineSpec,
} from '@sera/types';
import type { PipelineEngine } from '../../pipeline/PipelineEngine';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const PIPELINE_TOOLS: McpToolDefinition[] = [
    {
        name: 'execute_pipeline',
        description: 'Execute a pipeline specification. Returns the run ID immediately; the pipeline runs asynchronously.',
        inputSchema: {
            type: 'object',
            properties: {
                spec: {
                    description: 'Pipeline specification object (PipelineSpec JSON)',
                    type: 'object',
                },
                variables: {
                    description: 'Variable overrides for the pipeline execution',
                    type: 'object',
                },
                audit_slug: {
                    description: 'Audit slug to execute against',
                    type: 'string',
                },
                workspace_path: {
                    description: 'Workspace path for file access (optional)',
                    type: 'string',
                },
            },
            required: ['spec', 'audit_slug'],
        },
    },
    {
        name: 'get_pipeline_status',
        description: 'Get the status of a pipeline run including node states',
        inputSchema: {
            type: 'object',
            properties: {
                run_id: {
                    description: 'Pipeline run ID',
                    type: 'string',
                },
                audit_slug: {
                    description: 'Audit slug the run belongs to',
                    type: 'string',
                },
            },
            required: ['run_id', 'audit_slug'],
        },
    },
    {
        name: 'list_pipeline_runs',
        description: 'List all pipeline runs, optionally filtered by audit',
        inputSchema: {
            type: 'object',
            properties: {
                audit_slug: {
                    description: 'Filter by audit slug (optional)',
                    type: 'string',
                },
            },
        },
    },
    {
        name: 'pause_pipeline',
        description: 'Pause a running pipeline. It can be resumed later.',
        inputSchema: {
            type: 'object',
            properties: {
                run_id: {
                    description: 'Pipeline run ID to pause',
                    type: 'string',
                },
            },
            required: ['run_id'],
        },
    },
    {
        name: 'resume_pipeline',
        description: 'Resume a paused pipeline',
        inputSchema: {
            type: 'object',
            properties: {
                run_id: {
                    description: 'Pipeline run ID to resume',
                    type: 'string',
                },
            },
            required: ['run_id'],
        },
    },
    {
        name: 'cancel_pipeline',
        description: 'Cancel a running or paused pipeline',
        inputSchema: {
            type: 'object',
            properties: {
                run_id: {
                    description: 'Pipeline run ID to cancel',
                    type: 'string',
                },
            },
            required: ['run_id'],
        },
    },
    {
        name: 'compile_pipeline',
        description: 'Compile a pipeline spec to executable code without running it. Returns the generated script and supporting files.',
        inputSchema: {
            type: 'object',
            properties: {
                spec: {
                    description: 'Pipeline specification object (PipelineSpec JSON)',
                    type: 'object',
                },
                variables: {
                    description: 'Variable overrides for compilation',
                    type: 'object',
                },
            },
            required: ['spec'],
        },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class PipelineHandler implements PortableMcpHandler {
    private engine: PipelineEngine;

    constructor(engine: PipelineEngine) {
        this.engine = engine;
    }

    getToolDefinitions(): McpToolDefinition[] {
        return PIPELINE_TOOLS;
    }

    async handleToolCall(
        toolName: string,
        args: Record<string, unknown>,
        _ctx: HandlerContext
    ): Promise<unknown> {
        switch (toolName) {
            case 'execute_pipeline':
                return this.handleExecute(args);

            case 'get_pipeline_status':
                return this.handleGetStatus(args);

            case 'list_pipeline_runs':
                return this.handleListRuns(args);

            case 'pause_pipeline':
                return this.handlePause(args);

            case 'resume_pipeline':
                return this.handleResume(args);

            case 'cancel_pipeline':
                return this.handleCancel(args);

            case 'compile_pipeline':
                return this.handleCompile(args);

            default:
                throw new Error(`Unknown pipeline tool: ${toolName}`);
        }
    }

    private async handleExecute(args: Record<string, unknown>): Promise<unknown> {
        const spec = args.spec as PipelineSpec;
        const variables = (args.variables as Record<string, unknown>) ?? {};
        const auditSlug = args.audit_slug as string;
        const workspacePath = args.workspace_path as string | undefined;

        // Execute asynchronously - don't await the full run
        const executePromise = this.engine.execute(spec, variables, auditSlug, workspacePath);

        // Wait briefly for initialization to get the run ID
        const run = await Promise.race([
            executePromise,
            new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
        ]);

        if (run) {
            return {
                run_id: run.id,
                state: run.state,
                started_at: run.startedAt,
                completed_at: run.completedAt,
                progress: run.progress,
            };
        }

        // Pipeline is still running - get status from active runs
        const runs = await this.engine.listRuns(auditSlug);
        const latest = runs[runs.length - 1];
        return {
            run_id: latest?.id ?? 'unknown',
            state: latest?.state ?? 'running',
            started_at: latest?.startedAt,
            message: 'Pipeline execution started asynchronously',
        };
    }

    private async handleGetStatus(args: Record<string, unknown>): Promise<unknown> {
        const runId = args.run_id as string;
        const auditSlug = args.audit_slug as string;

        const run = await this.engine.getStatus(runId, auditSlug);
        if (!run) {
            throw new Error(`Pipeline run not found: ${runId}`);
        }

        const nodeRuns = await this.engine.getNodeRuns(runId, auditSlug);
        return {
            run_id: run.id,
            pipeline_id: run.pipelineId,
            state: run.state,
            progress: run.progress,
            started_at: run.startedAt,
            completed_at: run.completedAt,
            error: run.error,
            node_runs: nodeRuns.map(nr => ({
                node_id: nr.nodeId,
                node_type: nr.nodeType,
                state: nr.state,
                attempts: nr.attempts,
                started_at: nr.startedAt,
                completed_at: nr.completedAt,
                error: nr.error,
            })),
        };
    }

    private async handleListRuns(args: Record<string, unknown>): Promise<unknown> {
        const auditSlug = args.audit_slug as string | undefined;
        const runs = await this.engine.listRuns(auditSlug);
        return {
            runs: runs.map(r => ({
                run_id: r.id,
                pipeline_id: r.pipelineId,
                state: r.state,
                progress: r.progress,
                started_at: r.startedAt,
                completed_at: r.completedAt,
            })),
            total: runs.length,
        };
    }

    private async handlePause(args: Record<string, unknown>): Promise<unknown> {
        const runId = args.run_id as string;
        await this.engine.pause(runId);
        return { run_id: runId, action: 'paused' };
    }

    private async handleResume(args: Record<string, unknown>): Promise<unknown> {
        const runId = args.run_id as string;
        await this.engine.resume(runId);
        return { run_id: runId, action: 'resumed' };
    }

    private async handleCancel(args: Record<string, unknown>): Promise<unknown> {
        const runId = args.run_id as string;
        await this.engine.cancel(runId);
        return { run_id: runId, action: 'cancelled' };
    }

    private handleCompile(args: Record<string, unknown>): unknown {
        const spec = args.spec as PipelineSpec;
        const variables = args.variables as Record<string, unknown> | undefined;
        const result = this.engine.compile(spec, variables);
        return {
            script: result.script,
            script_filename: result.scriptFilename,
            files: result.files.map(f => ({ name: f.name, content: f.content })),
            warnings: result.warnings,
        };
    }
}
