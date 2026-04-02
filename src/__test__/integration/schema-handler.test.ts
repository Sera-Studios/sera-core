/**
 * @fileoverview Integration tests for SchemaHandler MCP tools
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

// ============================================================================
// HELPERS
// ============================================================================

function parseResult(result: any): any {
    const text = result.content[0].text;
    try { return JSON.parse(text); }
    catch { return text; }
}

// ============================================================================
// TESTS
// ============================================================================

describe('SchemaHandler MCP Tools', () => {
    let testnet: TestnetInstance;
    let client: McpTestClient;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'schema-test' });
        client = new McpTestClient(`${testnet.mcpUrl}/schema-test`);
        await client.initialize();
    }

    it('built-in schemas are seeded on boot', async () => {
        await setup();

        const result = await client.callTool('list_resources', { type: 'schema' });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.total).toBe(3);
        const names = data.resources.map((r: any) => r.name);
        expect(names).toContain('Hunter Finding');
        expect(names).toContain('Judge Verdict');
        expect(names).toContain('Audit Report');
    });

    it('validate_against_schema passes for valid HunterFinding', async () => {
        await setup();

        const result = await client.callTool('validate_against_schema', {
            schema_id: 'schema-any-hunter-finding',
            data: {
                title: 'Reentrancy in withdraw',
                severity: 'high',
                description: 'The withdraw function allows reentrancy.',
                impact: 'Fund theft',
            },
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.valid).toBe(true);
        expect(data.errors).toEqual([]);
        expect(data.schema_name).toBe('Hunter Finding');
    });

    it('validate_against_schema returns errors for missing required fields', async () => {
        await setup();

        const result = await client.callTool('validate_against_schema', {
            schema_id: 'schema-any-hunter-finding',
            data: { impact: 'Something bad' },
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.valid).toBe(false);
        expect(data.errors).toHaveLength(3);
        const paths = data.errors.map((e: any) => e.path);
        expect(paths).toContain('$.title');
        expect(paths).toContain('$.severity');
        expect(paths).toContain('$.description');
    });

    it('validate_against_schema returns error for invalid enum', async () => {
        await setup();

        const result = await client.callTool('validate_against_schema', {
            schema_id: 'schema-any-hunter-finding',
            data: {
                title: 'Bug',
                severity: 'Critical', // wrong case
                description: 'Details',
            },
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.valid).toBe(false);
        expect(data.errors[0].path).toBe('$.severity');
        expect(data.errors[0].message).toContain('must be one of');
    });

    it('validate_against_schema validates nested objects', async () => {
        await setup();

        const result = await client.callTool('validate_against_schema', {
            schema_id: 'schema-any-hunter-finding',
            data: {
                title: 'Bug',
                severity: 'high',
                description: 'Details',
                affectedFiles: [{ startLine: 10 }], // missing required 'path'
            },
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.valid).toBe(false);
        expect(data.errors[0].path).toBe('$.affectedFiles[0].path');
    });

    it('validate_against_schema returns error for non-existent schema', async () => {
        await setup();

        const result = await client.callTool('validate_against_schema', {
            schema_id: 'nonexistent',
            data: { title: 'test' },
        });
        expect(result.isError).toBe(true);
    });

    it('validate_against_schema returns error for non-schema resource', async () => {
        await setup();

        // Create a non-schema resource
        await client.callTool('create_resource', {
            type: 'primer',
            name: 'Test Primer',
            content: 'Some primer content',
        });

        const result = await client.callTool('validate_against_schema', {
            schema_id: 'primer-any-test-primer',
            data: { title: 'test' },
        });
        expect(result.isError).toBe(true);
    });

    it('validate_against_schema passes for valid JudgeVerdict', async () => {
        await setup();

        const result = await client.callTool('validate_against_schema', {
            schema_id: 'schema-any-judge-verdict',
            data: {
                findingId: 'f-001',
                verdict: 'valid',
                confidence: 0.95,
                reasoning: 'Confirmed through static analysis.',
            },
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.valid).toBe(true);
    });

    it('validate_against_schema works with user-created custom schema', async () => {
        await setup();

        // Create a custom schema resource
        const customSchema = {
            type: 'object',
            required: ['name', 'score'],
            properties: {
                name: { type: 'string' },
                score: { type: 'number' },
            },
        };

        await client.callTool('create_resource', {
            type: 'schema',
            name: 'Custom Schema',
            content: JSON.stringify(customSchema),
        });

        // Validate valid data
        const result = await client.callTool('validate_against_schema', {
            schema_id: 'schema-any-custom-schema',
            data: { name: 'Alice', score: 95 },
        });
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        expect(data.valid).toBe(true);

        // Validate invalid data
        const result2 = await client.callTool('validate_against_schema', {
            schema_id: 'schema-any-custom-schema',
            data: { score: 'not a number' },
        });
        const data2 = parseResult(result2);
        expect(data2.valid).toBe(false);
        expect(data2.errors.length).toBeGreaterThanOrEqual(1);
    });
});
