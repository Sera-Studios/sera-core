/**
 * @fileoverview Resource Management MCP Handler
 * @module sera-core/mcp/handlers/ResourceHandler
 *
 * Exposes audit knowledge resource CRUD via MCP:
 * - list_resources: List resources with filtering
 * - get_resource: Get full resource by ID
 * - create_resource: Create a new resource
 * - update_resource: Update an existing resource
 * - delete_resource: Delete a resource
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
} from '@sera/types';
import { ResourceStore } from '../../resources/ResourceStore';
import type { ResourceType, ResourceLanguage } from '@sera/types';
import { createLogger } from '../../logging/Logger';

const log = createLogger('resource-handler');

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const RESOURCE_TOOLS: McpToolDefinition[] = [
    {
        name: 'list_resources',
        description: 'List available audit resources (roles, primers, references, articles, reports, schemas). Returns summaries without full content.',
        inputSchema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['role', 'primer', 'reference', 'article', 'report', 'schema'],
                    description: 'Filter by resource type',
                },
                language: {
                    type: 'string',
                    enum: ['solidity', 'rust-solana', 'rust-offchain', 'any'],
                    description: 'Filter by target language',
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Filter by tags (matches ANY of the provided tags)',
                },
                search: {
                    type: 'string',
                    description: 'Search in resource names',
                },
            },
        },
    },
    {
        name: 'get_resource',
        description: 'Get the full content of a resource by ID.',
        inputSchema: {
            type: 'object',
            properties: {
                resource_id: {
                    type: 'string',
                    description: 'Resource ID (e.g., "role-solidity-hunter")',
                },
            },
            required: ['resource_id'],
        },
    },
    {
        name: 'create_resource',
        description: 'Create a new audit resource (role, primer, reference, article, report, or schema).',
        inputSchema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['role', 'primer', 'reference', 'article', 'report', 'schema'],
                    description: 'Resource type',
                },
                language: {
                    type: 'string',
                    enum: ['solidity', 'rust-solana', 'rust-offchain', 'any'],
                    description: 'Target language (default: any)',
                },
                name: {
                    type: 'string',
                    description: 'Resource name',
                },
                content: {
                    type: 'string',
                    description: 'Full markdown content',
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tags for categorization',
                },
                metadata: {
                    type: 'object',
                    description: 'Additional metadata',
                },
            },
            required: ['type', 'name', 'content'],
        },
    },
    {
        name: 'update_resource',
        description: 'Update an existing resource. Only provided fields are changed. Version is auto-incremented.',
        inputSchema: {
            type: 'object',
            properties: {
                resource_id: {
                    type: 'string',
                    description: 'Resource ID to update',
                },
                content: {
                    type: 'string',
                    description: 'New markdown content',
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'New tags (replaces existing)',
                },
                name: {
                    type: 'string',
                    description: 'New name',
                },
                language: {
                    type: 'string',
                    enum: ['solidity', 'rust-solana', 'rust-offchain', 'any'],
                    description: 'New language',
                },
                metadata: {
                    type: 'object',
                    description: 'New metadata (replaces existing)',
                },
            },
            required: ['resource_id'],
        },
    },
    {
        name: 'delete_resource',
        description: 'Delete a resource by ID.',
        inputSchema: {
            type: 'object',
            properties: {
                resource_id: {
                    type: 'string',
                    description: 'Resource ID to delete',
                },
            },
            required: ['resource_id'],
        },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class ResourceHandler implements PortableMcpHandler {
    private store: ResourceStore;

    constructor(store: ResourceStore) {
        this.store = store;
    }

    getToolDefinitions(): McpToolDefinition[] {
        return RESOURCE_TOOLS;
    }

    async handleToolCall(
        toolName: string,
        args: Record<string, unknown>,
        _ctx: HandlerContext
    ): Promise<unknown> {
        switch (toolName) {
            case 'list_resources':
                return this.handleList(args);
            case 'get_resource':
                return this.handleGet(args);
            case 'create_resource':
                return this.handleCreate(args);
            case 'update_resource':
                return this.handleUpdate(args);
            case 'delete_resource':
                return this.handleDelete(args);
            default:
                throw new Error(`Unknown resource tool: ${toolName}`);
        }
    }

    private handleList(args: Record<string, unknown>): unknown {
        const resources = this.store.list({
            type: args.type as ResourceType | undefined,
            language: args.language as ResourceLanguage | undefined,
            tags: args.tags as string[] | undefined,
            search: args.search as string | undefined,
        });

        return {
            resources,
            total: resources.length,
        };
    }

    private handleGet(args: Record<string, unknown>): unknown {
        const id = args.resource_id as string;
        const resource = this.store.get(id);

        if (!resource) {
            throw new Error(`Resource not found: ${id}`);
        }

        return { resource };
    }

    private handleCreate(args: Record<string, unknown>): unknown {
        const resource = this.store.create({
            type: args.type as ResourceType,
            language: args.language as ResourceLanguage | undefined,
            name: args.name as string,
            content: args.content as string,
            tags: args.tags as string[] | undefined,
            metadata: args.metadata as Record<string, unknown> | undefined,
        });

        log.info('Created resource', { resourceId: resource.id });

        return {
            resource_id: resource.id,
            slug: resource.slug,
            version: resource.version,
        };
    }

    private handleUpdate(args: Record<string, unknown>): unknown {
        const id = args.resource_id as string;

        const resource = this.store.update(id, {
            name: args.name as string | undefined,
            content: args.content as string | undefined,
            tags: args.tags as string[] | undefined,
            language: args.language as ResourceLanguage | undefined,
            metadata: args.metadata as Record<string, unknown> | undefined,
        });

        if (!resource) {
            throw new Error(`Resource not found: ${id}`);
        }

        log.info('Updated resource', { resourceId: id, version: resource.version });

        return {
            resource_id: resource.id,
            version: resource.version,
            updated: true,
        };
    }

    private handleDelete(args: Record<string, unknown>): unknown {
        const id = args.resource_id as string;
        const deleted = this.store.delete(id);

        if (!deleted) {
            throw new Error(`Resource not found: ${id}`);
        }

        log.info('Deleted resource', { resourceId: id });

        return {
            resource_id: id,
            deleted: true,
        };
    }
}
