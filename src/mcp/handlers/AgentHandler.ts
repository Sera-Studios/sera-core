/**
 * @fileoverview Agent Registration MCP Handler
 * @module sera-core/mcp/handlers/AgentHandler
 *
 * Exposes agent registration queries via MCP:
 * - list_agent_registrations: List all registered agent types
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
    AgentRole,
} from '@sera/types';
import { AgentRegistrationStore } from '../../agents/AgentRegistrationStore';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const AGENT_TOOLS: McpToolDefinition[] = [
    {
        name: 'list_agent_registrations',
        description: 'List registered agent definitions with their execution type and interface. Optionally filter by role.',
        inputSchema: {
            type: 'object',
            properties: {
                role: {
                    type: 'string',
                    enum: ['execution', 'evaluation'],
                    description: 'Filter to agents that include this role',
                },
            },
        },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class AgentHandler implements PortableMcpHandler {
    private store: AgentRegistrationStore;

    constructor(store: AgentRegistrationStore) {
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
            case 'list_agent_registrations':
                return this.handleListRegistrations(args.role as string | undefined);

            default:
                throw new Error(`Unknown agent tool: ${toolName}`);
        }
    }

    private handleListRegistrations(role?: string): unknown {
        const registrations = role
            ? this.store.getByRole(role as AgentRole)
            : this.store.getAll();
        return {
            registrations: registrations.map(r => ({
                id: r.id,
                name: r.name,
                description: r.description,
                roles: r.roles,
                execution_type: r.execution.type,
                default_timeout: r.defaultTimeout,
                input_count: r.interface.inputs.length,
                output_count: r.interface.outputs.length,
            })),
            total: registrations.length,
        };
    }
}
