/**
 * @fileoverview Version Lineage & Experiment Tracking MCP Handler
 * @module sera-core/mcp/handlers/VersionHandler
 *
 * Exposes agent version lineage and experiment tracking via MCP:
 * - version_create_snapshot: Record a new agent version
 * - version_get_lineage: Get version history for an agent
 * - experiment_create: Start a new experiment
 * - experiment_complete: Record experiment results
 * - experiment_list: List experiments with filters
 * - experiment_summary: Get aggregated experiment stats
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
} from '@sera/types';
import type {
    ExperimentMetrics,
    ExperimentStatus,
    ExperimentVerdict,
    ModificationType,
    VersionCreator,
} from '@sera/types';
import { VersionStore } from '../../versioning/VersionStore';
import { AgentRegistrationStore } from '../../agents/AgentRegistrationStore';
import { createLogger } from '../../logging/Logger';

const log = createLogger('version-handler');

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const VERSION_TOOLS: McpToolDefinition[] = [
    {
        name: 'version_create_snapshot',
        description: 'Record a new agent version with its parent lineage. Auto-captures the current agent registration as a snapshot.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: {
                    type: 'string',
                    description: 'Agent registration ID',
                },
                version: {
                    type: 'string',
                    description: 'Semantic version string (e.g., "0.2.0")',
                },
                parent_version_id: {
                    type: 'string',
                    description: 'Previous version ID this derives from',
                },
                created_by: {
                    type: 'string',
                    enum: ['human', 'autonomous-loop', 'claude-code'],
                    description: 'Who created this version',
                },
            },
            required: ['agent_id', 'version', 'created_by'],
        },
    },
    {
        name: 'version_get_lineage',
        description: 'Get the full version history for an agent, from latest to root.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: {
                    type: 'string',
                    description: 'Agent registration ID',
                },
                limit: {
                    type: 'number',
                    description: 'Max versions to return (default: 20)',
                },
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'experiment_create',
        description: 'Start a new experiment: record hypothesis and modification before benchmarking.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: {
                    type: 'string',
                    description: 'Agent registration ID',
                },
                base_version_id: {
                    type: 'string',
                    description: 'Version ID to start from',
                },
                hypothesis: {
                    type: 'string',
                    description: 'What improvement is expected',
                },
                modification_type: {
                    type: 'string',
                    enum: [
                        'role-refinement', 'primer-attachment', 'primer-removal',
                        'tool-addition', 'tool-removal', 'model-change',
                        'resource-update', 'pipeline-restructure', 'custom',
                    ],
                    description: 'Type of modification being tested',
                },
                modification_detail: {
                    type: 'object',
                    description: 'Type-specific change details',
                },
            },
            required: ['agent_id', 'base_version_id', 'hypothesis', 'modification_type', 'modification_detail'],
        },
    },
    {
        name: 'experiment_complete',
        description: 'Record experiment results after benchmarking. Auto-calculates delta from before/after metrics.',
        inputSchema: {
            type: 'object',
            properties: {
                experiment_id: {
                    type: 'string',
                    description: 'Experiment ID to complete',
                },
                result_version_id: {
                    type: 'string',
                    description: 'The new version created for this experiment',
                },
                benchmark_run_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Benchmark run IDs used to evaluate',
                },
                before_metrics: {
                    type: 'object',
                    description: 'Metrics before modification (score, recall, precision, f1)',
                },
                after_metrics: {
                    type: 'object',
                    description: 'Metrics after modification',
                },
                verdict: {
                    type: 'string',
                    enum: ['keep', 'revert', 'investigate'],
                    description: 'Decision on this experiment',
                },
                notes: {
                    type: 'string',
                    description: 'Human or auto-generated notes',
                },
            },
            required: ['experiment_id', 'benchmark_run_ids', 'before_metrics', 'after_metrics', 'verdict'],
        },
    },
    {
        name: 'experiment_list',
        description: 'List experiments for an agent with optional filters.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: {
                    type: 'string',
                    description: 'Agent registration ID',
                },
                status: {
                    type: 'string',
                    enum: ['pending', 'running', 'improved', 'regressed', 'neutral', 'reverted'],
                    description: 'Filter by status',
                },
                modification_type: {
                    type: 'string',
                    description: 'Filter by modification type',
                },
                limit: {
                    type: 'number',
                    description: 'Max results (default: 50)',
                },
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'experiment_summary',
        description: 'Get a summary of experiments for an agent: totals, success rate, top improvements and regressions.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: {
                    type: 'string',
                    description: 'Agent registration ID',
                },
                since: {
                    type: 'string',
                    description: 'ISO date - only experiments after this date',
                },
            },
            required: ['agent_id'],
        },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class VersionHandler implements PortableMcpHandler {
    private store: VersionStore;
    private registrationStore: AgentRegistrationStore;

    constructor(store: VersionStore, registrationStore: AgentRegistrationStore) {
        this.store = store;
        this.registrationStore = registrationStore;
    }

    getToolDefinitions(): McpToolDefinition[] {
        return VERSION_TOOLS;
    }

    async handleToolCall(
        toolName: string,
        args: Record<string, unknown>,
        _ctx: HandlerContext
    ): Promise<unknown> {
        switch (toolName) {
            case 'version_create_snapshot':
                return this.handleCreateSnapshot(args);
            case 'version_get_lineage':
                return this.handleGetLineage(args);
            case 'experiment_create':
                return this.handleExperimentCreate(args);
            case 'experiment_complete':
                return this.handleExperimentComplete(args);
            case 'experiment_list':
                return this.handleExperimentList(args);
            case 'experiment_summary':
                return this.handleExperimentSummary(args);
            default:
                throw new Error(`Unknown version tool: ${toolName}`);
        }
    }

    private handleCreateSnapshot(args: Record<string, unknown>): unknown {
        const agentId = args.agent_id as string;
        const versionStr = args.version as string;
        const createdBy = args.created_by as VersionCreator;
        const parentVersionId = args.parent_version_id as string | undefined;

        // Auto-capture registration snapshot
        const registration = this.registrationStore.get(agentId);
        const registrationSnapshot = registration
            ? JSON.parse(JSON.stringify(registration))
            : null;

        const version = this.store.createVersion({
            agentId,
            version: versionStr,
            parentVersionId,
            createdBy,
            registrationSnapshot,
        });

        log.info('Created version', { agentId, version: versionStr, versionId: version.id });

        return {
            version_id: version.id,
            agent_id: version.agentId,
            version: version.version,
            has_registration_snapshot: registrationSnapshot !== null,
        };
    }

    private handleGetLineage(args: Record<string, unknown>): unknown {
        const agentId = args.agent_id as string;
        const limit = (args.limit as number) || 20;

        const latest = this.store.getLatestVersion(agentId);
        if (!latest) {
            return { agent_id: agentId, versions: [], total: 0 };
        }

        const lineage = this.store.getLineage(latest.id);
        const truncated = lineage.slice(0, limit);

        return {
            agent_id: agentId,
            versions: truncated.map(v => ({
                id: v.id,
                version: v.version,
                parentVersionId: v.parentVersionId,
                createdAt: v.createdAt,
                createdBy: v.createdBy,
            })),
            total: truncated.length,
        };
    }

    private handleExperimentCreate(args: Record<string, unknown>): unknown {
        const experiment = this.store.createExperiment({
            agentId: args.agent_id as string,
            baseVersionId: args.base_version_id as string,
            hypothesis: args.hypothesis as string,
            modificationType: args.modification_type as ModificationType,
            modificationDetail: args.modification_detail as Record<string, unknown>,
        });

        log.info('Created experiment', { experimentId: experiment.id, agentId: experiment.agentId });

        return {
            experiment_id: experiment.id,
            status: experiment.status,
        };
    }

    private handleExperimentComplete(args: Record<string, unknown>): unknown {
        const experimentId = args.experiment_id as string;
        const beforeMetrics = args.before_metrics as ExperimentMetrics;
        const afterMetrics = args.after_metrics as ExperimentMetrics;
        const verdict = args.verdict as ExperimentVerdict;

        const existing = this.store.getExperiment(experimentId);
        if (!existing) {
            throw new Error(`Experiment not found: ${experimentId}`);
        }

        // Auto-calculate delta
        const delta = calculateDelta(beforeMetrics, afterMetrics);

        // Derive status from verdict and delta
        const status = statusFromVerdict(verdict, delta);

        this.store.updateExperiment(experimentId, {
            resultVersionId: args.result_version_id as string | undefined,
            benchmarkRunIds: args.benchmark_run_ids as string[],
            beforeMetrics,
            afterMetrics,
            delta,
            verdict,
            status,
            completedAt: new Date().toISOString(),
            notes: args.notes as string | undefined,
        });

        log.info('Completed experiment', { experimentId, status });

        return {
            experiment_id: experimentId,
            status,
            delta,
        };
    }

    private handleExperimentList(args: Record<string, unknown>): unknown {
        const agentId = args.agent_id as string;
        const experiments = this.store.listExperiments(agentId, {
            status: args.status as ExperimentStatus | undefined,
            modificationType: args.modification_type as ModificationType | undefined,
            limit: (args.limit as number) || 50,
        });

        return {
            experiments: experiments.map(e => ({
                id: e.id,
                hypothesis: e.hypothesis,
                modificationType: e.modificationType,
                status: e.status,
                startedAt: e.startedAt,
                completedAt: e.completedAt,
                verdict: e.verdict,
                delta: e.delta,
            })),
            total: experiments.length,
        };
    }

    private handleExperimentSummary(args: Record<string, unknown>): unknown {
        const agentId = args.agent_id as string;
        const since = args.since as string | undefined;

        return this.store.getExperimentSummary(agentId, since);
    }
}

// ============================================================================
// HELPERS
// ============================================================================

function calculateDelta(
    before: ExperimentMetrics,
    after: ExperimentMetrics,
): ExperimentMetrics {
    const delta: ExperimentMetrics = {};
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of allKeys) {
        const b = before[key];
        const a = after[key];
        if (typeof a === 'number' && typeof b === 'number') {
            delta[key] = Math.round((a - b) * 1000) / 1000;
        }
    }
    return delta;
}

function statusFromVerdict(
    verdict: ExperimentVerdict,
    delta: ExperimentMetrics,
): ExperimentStatus {
    if (verdict === 'revert') return 'reverted';
    if (verdict === 'investigate') return 'neutral';
    // verdict === 'keep'
    const scoreChange = delta.score ?? 0;
    if (scoreChange > 0) return 'improved';
    if (scoreChange < 0) return 'regressed';
    return 'neutral';
}
