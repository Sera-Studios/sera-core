/**
 * @fileoverview Schema Validation MCP Handler
 * @module sera-core/mcp/handlers/SchemaHandler
 *
 * Provides schema validation for structured agent output:
 * - validate_against_schema: Validate JSON data against a stored schema resource
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
} from '@sera/types';
import { ResourceStore } from '../../resources/ResourceStore';
import { validateAgainstSchema } from '../../schemas/validateSchema';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const SCHEMA_TOOLS: McpToolDefinition[] = [
    {
        name: 'validate_against_schema',
        description: 'Validate a JSON object against a stored schema resource. Returns validation result with errors.',
        inputSchema: {
            type: 'object',
            properties: {
                schema_id: {
                    type: 'string',
                    description: 'Resource ID of the schema (e.g., "schema-any-hunter-finding")',
                },
                data: {
                    type: 'object',
                    description: 'JSON object to validate against the schema',
                },
            },
            required: ['schema_id', 'data'],
        },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class SchemaHandler implements PortableMcpHandler {
    private store: ResourceStore;

    constructor(store: ResourceStore) {
        this.store = store;
    }

    getToolDefinitions(): McpToolDefinition[] {
        return SCHEMA_TOOLS;
    }

    async handleToolCall(
        toolName: string,
        args: Record<string, unknown>,
        _ctx: HandlerContext,
    ): Promise<unknown> {
        switch (toolName) {
            case 'validate_against_schema':
                return this.handleValidate(args);
            default:
                throw new Error(`Unknown schema tool: ${toolName}`);
        }
    }

    private handleValidate(args: Record<string, unknown>): unknown {
        const schemaId = args.schema_id as string;
        const data = args.data;

        const resource = this.store.get(schemaId);
        if (!resource) {
            throw new Error(`Schema not found: ${schemaId}`);
        }
        if (resource.type !== 'schema') {
            throw new Error(`Resource ${schemaId} is not a schema (type: ${resource.type})`);
        }

        let schema: Record<string, unknown>;
        try {
            schema = JSON.parse(resource.content);
        } catch {
            throw new Error(`Schema ${schemaId} contains invalid JSON`);
        }

        const result = validateAgainstSchema(schema, data);

        return {
            valid: result.valid,
            errors: result.errors,
            schema_id: schemaId,
            schema_name: resource.name,
        };
    }
}
