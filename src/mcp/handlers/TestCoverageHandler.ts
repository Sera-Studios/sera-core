/**
 * @fileoverview Test Coverage MCP Handler for sera-core (Alchemist role)
 * @module sera-core/mcp/handlers/TestCoverageHandler
 *
 * Handles test mapping submission, retrieval, and management.
 * Writes to sessionbridge_test_mappings and sessionbridge_test_requests tables.
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
    TableSchema,
} from '@sera/types';

const TEST_SCHEMAS: TableSchema[] = [
    {
        name: 'test_mappings',
        fields: [
            { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
            { name: 'mappingId', type: 'TEXT', required: true },
            { name: 'sessionId', type: 'TEXT', required: true },
            { name: 'targetFunction', type: 'TEXT', required: true },
            { name: 'tests', type: 'TEXT', required: true },
            { name: 'coverageGaps', type: 'TEXT', required: false },
            { name: 'createdAt', type: 'TEXT', required: true },
        ],
        indexes: [
            { fields: ['mappingId'], unique: true },
            { fields: ['sessionId'] },
        ],
    },
    {
        name: 'test_requests',
        fields: [
            { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
            { name: 'requestId', type: 'TEXT', required: true },
            { name: 'target', type: 'TEXT', required: true },
            { name: 'missingCases', type: 'TEXT', required: true },
            { name: 'priority', type: 'TEXT', required: true },
            { name: 'status', type: 'TEXT', required: true, defaultValue: 'pending' },
            { name: 'testFile', type: 'TEXT', required: false },
            { name: 'createdAt', type: 'TEXT', required: true },
            { name: 'completedAt', type: 'TEXT', required: false },
        ],
        indexes: [
            { fields: ['requestId'], unique: true },
            { fields: ['status'] },
            { fields: ['priority'] },
        ],
    },
];

const TOOL_DEFINITIONS: McpToolDefinition[] = [
    {
        name: 'submit_test_mapping',
        description: 'Map discovered tests to their target functions with coverage analysis.',
        inputSchema: {
            type: 'object',
            properties: {
                target_function: {
                    type: 'object',
                    properties: {
                        file: { type: 'string' },
                        name: { type: 'string' },
                        line: { type: 'number' },
                    },
                    required: ['file', 'name', 'line'],
                },
                tests: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            file: { type: 'string' },
                            test_name: { type: 'string' },
                            test_type: { type: 'string', enum: ['happy_path', 'negative', 'fuzz', 'invariant', 'integration'] },
                            one_liner: { type: 'string' },
                            line: { type: 'number' },
                        },
                        required: ['file', 'test_name', 'test_type', 'one_liner', 'line'],
                    },
                },
                coverage_gaps: { type: 'array', items: { type: 'string' } },
            },
            required: ['target_function', 'tests', 'coverage_gaps'],
        },
    },
    {
        name: 'get_test_requests',
        description: 'Get pending test generation requests from auditor.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'mark_test_complete',
        description: 'Mark a test request as completed.',
        inputSchema: {
            type: 'object',
            properties: {
                request_id: { type: 'string' },
                test_file: { type: 'string' },
                cases_covered: { type: 'array', items: { type: 'string' } },
            },
            required: ['request_id', 'test_file', 'cases_covered'],
        },
    },
    {
        name: 'report_test_failure',
        description: 'Alert user of failing tests.',
        inputSchema: {
            type: 'object',
            properties: {
                test_file: { type: 'string' },
                test_name: { type: 'string' },
                error: { type: 'string' },
                severity: { type: 'string', enum: ['blocker', 'warning'] },
            },
            required: ['test_file', 'test_name', 'error', 'severity'],
        },
    },
    {
        name: 'get_test_mappings',
        description: 'Get all test mappings previously submitted.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string' },
            },
            required: [],
        },
    },
    {
        name: 'update_test_mapping',
        description: 'Update an existing test mapping.',
        inputSchema: {
            type: 'object',
            properties: {
                target_function: {
                    type: 'object',
                    properties: { file: { type: 'string' }, name: { type: 'string' }, line: { type: 'number' } },
                    required: ['file', 'name', 'line'],
                },
                tests: { type: 'array', items: { type: 'object' } },
                coverage_gaps: { type: 'array', items: { type: 'string' } },
            },
            required: ['target_function', 'tests', 'coverage_gaps'],
        },
    },
    {
        name: 'clear_test_mappings',
        description: 'Clear all test mappings and coverage data.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
];

export class TestCoverageHandler implements PortableMcpHandler {
    getToolDefinitions(): McpToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    getRequiredTableSchemas() {
        return [{ appletId: 'sessionbridge', schemas: TEST_SCHEMAS }];
    }

    async handleToolCall(toolName: string, args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> {
        switch (toolName) {
            case 'submit_test_mapping':
                return this.handleSubmitMapping(args, ctx);
            case 'get_test_requests':
                return this.handleGetTestRequests(ctx);
            case 'mark_test_complete':
                return this.handleMarkComplete(args, ctx);
            case 'report_test_failure':
                return this.handleReportFailure(args, ctx);
            case 'get_test_mappings':
                return this.handleGetMappings(args, ctx);
            case 'update_test_mapping':
                return this.handleUpdateMapping(args, ctx);
            case 'clear_test_mappings':
                return this.handleClearMappings(ctx);
            default:
                throw new Error(`Unknown test coverage tool: ${toolName}`);
        }
    }

    private async handleSubmitMapping(args: Record<string, unknown>, ctx: HandlerContext): Promise<{ mapping_id: string }> {
        const targetFunction = args.target_function as Record<string, unknown>;

        // Delete existing mapping for this function (deduplication)
        const existing = await ctx.db.sql(
            `SELECT * FROM sessionbridge_test_mappings`, []
        );
        for (const old of existing) {
            try {
                const tf = JSON.parse(old.targetFunction);
                if (tf.file === targetFunction.file && tf.name === targetFunction.name) {
                    await ctx.db.sql(
                        `DELETE FROM sessionbridge_test_mappings WHERE id = ?`, [old.id]
                    );
                }
            } catch { /* skip */ }
        }

        const id = Date.now();
        const mappingId = `mapping_${id}`;

        await ctx.db.write('sessionbridge', 'test_mappings', {
            id,
            mappingId,
            sessionId: ctx.sessionId,
            targetFunction: JSON.stringify(targetFunction),
            tests: JSON.stringify(args.tests),
            coverageGaps: args.coverage_gaps ? JSON.stringify(args.coverage_gaps) : null,
            createdAt: new Date().toISOString(),
        });

        console.log(`[TestCoverageHandler] Mapping submitted: ${mappingId}`);
        return { mapping_id: mappingId };
    }

    private async handleGetTestRequests(ctx: HandlerContext): Promise<unknown[]> {
        return ctx.db.sql(
            `SELECT * FROM sessionbridge_test_requests WHERE status = 'pending' ORDER BY priority`, []
        );
    }

    private async handleMarkComplete(args: Record<string, unknown>, ctx: HandlerContext): Promise<{ success: boolean }> {
        const requestId = args.request_id as string;
        const requests = await ctx.db.sql(
            `SELECT * FROM sessionbridge_test_requests WHERE requestId = ?`, [requestId]
        );

        if (requests.length === 0) {
            throw new Error(`Test request not found: ${requestId}`);
        }

        await ctx.db.write('sessionbridge', 'test_requests', {
            ...requests[0],
            status: 'completed',
            testFile: args.test_file as string,
            completedAt: new Date().toISOString(),
        });

        return { success: true };
    }

    private async handleReportFailure(args: Record<string, unknown>, ctx: HandlerContext): Promise<{ reported: boolean }> {
        console.log(`[TestCoverageHandler] Test failure: ${args.test_file}::${args.test_name} - ${args.error}`);
        // In sera-core, we emit a bridge event that VS Code clients can show as a notification
        ctx.bridge.emit('test:failure', {
            testFile: args.test_file,
            testName: args.test_name,
            error: args.error,
            severity: args.severity,
        });
        return { reported: true };
    }

    private async handleGetMappings(args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown[]> {
        let mappings: any[];
        if (args.file) {
            mappings = await ctx.db.sql(
                `SELECT * FROM sessionbridge_test_mappings ORDER BY createdAt DESC`, []
            );
            // Filter by file in TypeScript for flexible path matching
            mappings = mappings.filter((m: any) => {
                try {
                    const tf = JSON.parse(m.targetFunction);
                    const file = args.file as string;
                    return tf.file?.includes(file) || file.includes(tf.file || '');
                } catch { return false; }
            });
        } else {
            mappings = await ctx.db.sql(
                `SELECT * FROM sessionbridge_test_mappings ORDER BY createdAt DESC`, []
            );
        }

        return mappings.map((m: any) => ({
            mapping_id: m.mappingId,
            target_function: JSON.parse(m.targetFunction),
            tests: JSON.parse(m.tests),
            coverage_gaps: m.coverageGaps ? JSON.parse(m.coverageGaps) : [],
            created_at: m.createdAt,
        }));
    }

    private async handleUpdateMapping(args: Record<string, unknown>, ctx: HandlerContext): Promise<{ mapping_id: string }> {
        // Update is implemented as delete + insert (same as submit)
        return this.handleSubmitMapping(args, ctx);
    }

    private async handleClearMappings(ctx: HandlerContext): Promise<{ cleared: boolean; count: number }> {
        const mappings = await ctx.db.sql(
            `SELECT COUNT(*) as count FROM sessionbridge_test_mappings`, []
        );
        const count = mappings[0]?.count || 0;

        if (count > 0) {
            await ctx.db.sql(`DELETE FROM sessionbridge_test_mappings`, []);
        }

        console.log(`[TestCoverageHandler] Cleared ${count} mappings`);
        return { cleared: true, count };
    }
}
