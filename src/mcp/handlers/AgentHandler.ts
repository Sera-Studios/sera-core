/**
 * @fileoverview Agent Management MCP Handler
 * @module sera-core/mcp/handlers/AgentHandler
 *
 * Exposes agent lifecycle management tools via MCP:
 * - list_agent_definitions: List available agent types
 * - launch_agent: Launch a new agent instance
 * - stop_agent: Stop a running agent
 * - list_agent_instances: List running/completed agents
 * - get_agent_status: Get status of a specific agent
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
    AgentLaunchConfig,
} from '@sera/types';
import { AgentRegistrationStore } from '../../agents/AgentRegistrationStore';
import { AgentLifecycleManager } from '../../agents/AgentLifecycleManager';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const AGENT_TOOLS: McpToolDefinition[] = [
    {
        name: 'list_agent_definitions',
        description: 'List all available agent definitions (hunter, gatherer, alchemist, cartographer, etc.)',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'launch_agent',
        description: 'Launch a new agent instance as a Claude Code subprocess with packed context',
        inputSchema: {
            type: 'object',
            properties: {
                definition_id: {
                    description: 'Agent definition ID (e.g., "hunter", "gatherer")',
                    type: 'string',
                },
                audit_slug: {
                    description: 'Audit slug to operate on',
                    type: 'string',
                },
                workspace_path: {
                    description: 'Workspace path for the Claude Code subprocess',
                    type: 'string',
                },
                primer_path: {
                    description: 'Path to protocol primer .md file (optional)',
                    type: 'string',
                },
                custom_prompt: {
                    description: 'Additional instructions to append to the agent prompt (optional)',
                    type: 'string',
                },
                timeout: {
                    description: 'Timeout in seconds (optional, overrides default)',
                    type: 'number',
                },
                contract_names: {
                    description: 'Specific contracts to focus on (optional)',
                    type: 'array',
                },
            },
            required: ['definition_id', 'audit_slug', 'workspace_path'],
        },
    },
    {
        name: 'stop_agent',
        description: 'Stop a running agent instance',
        inputSchema: {
            type: 'object',
            properties: {
                instance_id: {
                    description: 'Agent instance ID to stop',
                    type: 'string',
                },
            },
            required: ['instance_id'],
        },
    },
    {
        name: 'list_agent_instances',
        description: 'List all agent instances (running and completed)',
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
        name: 'get_agent_status',
        description: 'Get detailed status of a specific agent instance',
        inputSchema: {
            type: 'object',
            properties: {
                instance_id: {
                    description: 'Agent instance ID',
                    type: 'string',
                },
            },
            required: ['instance_id'],
        },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class AgentHandler implements PortableMcpHandler {
    private store: AgentRegistrationStore;
    private manager: AgentLifecycleManager;

    constructor(manager: AgentLifecycleManager, store: AgentRegistrationStore) {
        this.manager = manager;
        this.store = store;
    }

    getToolDefinitions(): McpToolDefinition[] {
        return AGENT_TOOLS;
    }

    async handleToolCall(
        toolName: string,
        args: Record<string, unknown>,
        _ctx: HandlerContext
    ): Promise<unknown> {
        switch (toolName) {
            case 'list_agent_definitions':
                return this.handleListDefinitions();

            case 'launch_agent':
                return this.handleLaunchAgent(args);

            case 'stop_agent':
                return this.handleStopAgent(args);

            case 'list_agent_instances':
                return this.handleListInstances(args);

            case 'get_agent_status':
                return this.handleGetStatus(args);

            default:
                throw new Error(`Unknown agent tool: ${toolName}`);
        }
    }

    private handleListDefinitions(): unknown {
        const registrations = this.store.getAll();
        return {
            definitions: registrations.map(r => ({
                id: r.id,
                name: r.name,
                description: r.description,
                execution_type: r.execution.type,
                default_timeout: r.defaultTimeout,
                input_count: r.interface.inputs.length,
                output_count: r.interface.outputs.length,
            })),
            total: registrations.length,
        };
    }

    private async handleLaunchAgent(args: Record<string, unknown>): Promise<unknown> {
        const config: AgentLaunchConfig = {
            definitionId: args.definition_id as string,
            auditSlug: args.audit_slug as string,
            workspacePath: args.workspace_path as string,
            primerPath: args.primer_path as string | undefined,
            customPrompt: args.custom_prompt as string | undefined,
            timeout: args.timeout as number | undefined,
        };

        // Apply contract name overrides if provided
        if (args.contract_names && Array.isArray(args.contract_names)) {
            config.scopeOverrides = {
                contractNames: args.contract_names as string[],
            };
        }

        const instance = await this.manager.launch(config);
        return {
            instance_id: instance.instanceId,
            definition_id: instance.definitionId,
            status: instance.status,
            pid: instance.pid,
            started_at: instance.startedAt,
        };
    }

    private async handleStopAgent(args: Record<string, unknown>): Promise<unknown> {
        const instanceId = args.instance_id as string;
        await this.manager.stop(instanceId);
        const instance = this.manager.getStatus(instanceId);
        return {
            instance_id: instanceId,
            status: instance?.status || 'stopped',
            completed_at: instance?.completedAt,
        };
    }

    private handleListInstances(args: Record<string, unknown>): unknown {
        const auditSlug = args.audit_slug as string | undefined;
        const instances = this.manager.listInstances(auditSlug);
        return {
            instances: instances.map(i => ({
                instance_id: i.instanceId,
                definition_id: i.definitionId,
                audit_slug: i.auditSlug,
                status: i.status,
                pid: i.pid,
                started_at: i.startedAt,
                completed_at: i.completedAt,
                exit_code: i.exitCode,
                error: i.error,
            })),
            total: instances.length,
            running: instances.filter(i => i.status === 'running').length,
        };
    }

    private handleGetStatus(args: Record<string, unknown>): unknown {
        const instanceId = args.instance_id as string;
        const instance = this.manager.getStatus(instanceId);

        if (!instance) {
            throw new Error(`Agent instance not found: ${instanceId}`);
        }

        return {
            instance_id: instance.instanceId,
            definition_id: instance.definitionId,
            audit_slug: instance.auditSlug,
            status: instance.status,
            pid: instance.pid,
            started_at: instance.startedAt,
            completed_at: instance.completedAt,
            exit_code: instance.exitCode,
            error: instance.error,
        };
    }
}
