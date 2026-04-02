/**
 * @fileoverview Integration tests for ResourceHandler MCP tools and Resource REST endpoints
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

// ============================================================================
// HELPERS
// ============================================================================

function httpJson(method: string, url: string, body?: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const payload = body ? JSON.stringify(body) : undefined;
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode!, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode!, body: data });
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function parseResult(result: any): any {
    const text = result.content[0].text;
    try { return JSON.parse(text); }
    catch { return text; }
}

// ============================================================================
// MCP TOOL TESTS
// ============================================================================

describe('ResourceHandler MCP Tools', () => {
    let testnet: TestnetInstance;
    let client: McpTestClient;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'resource-test' });
        client = new McpTestClient(`${testnet.mcpUrl}/resource-test`);
        await client.initialize();
    }

    it('list_resources returns only seeded schemas on fresh database', async () => {
        await setup();

        const result = await client.callTool('list_resources', {});
        expect(result.isError).not.toBe(true);

        const data = parseResult(result);
        // 3 built-in schemas are seeded on boot
        expect(data.total).toBe(3);
        expect(data.resources.every((r: any) => r.type === 'schema')).toBe(true);
    });

    it('create_resource + get_resource roundtrip', async () => {
        await setup();

        const createResult = await client.callTool('create_resource', {
            type: 'role',
            language: 'solidity',
            name: 'Hunter',
            content: '# Hunter\nFinds vulnerabilities in Solidity.',
            tags: ['hunter', 'solidity'],
        });
        expect(createResult.isError).not.toBe(true);
        const created = parseResult(createResult);
        expect(created.resource_id).toBe('role-solidity-hunter');
        expect(created.version).toBe(1);

        const getResult = await client.callTool('get_resource', {
            resource_id: 'role-solidity-hunter',
        });
        expect(getResult.isError).not.toBe(true);
        const fetched = parseResult(getResult);
        expect(fetched.resource.name).toBe('Hunter');
        expect(fetched.resource.content).toBe('# Hunter\nFinds vulnerabilities in Solidity.');
        expect(fetched.resource.tags).toEqual(['hunter', 'solidity']);
    });

    it('generates deterministic IDs from type, language, and name', async () => {
        await setup();

        await client.callTool('create_resource', {
            type: 'reference',
            language: 'any',
            name: 'Access Control',
            content: '# Access Control',
        });

        const result = await client.callTool('get_resource', {
            resource_id: 'reference-any-access-control',
        });
        expect(result.isError).not.toBe(true);
        expect(parseResult(result).resource.name).toBe('Access Control');
    });

    it('list_resources filters by type', async () => {
        await setup();

        await client.callTool('create_resource', { type: 'role', name: 'Hunter', content: 'r1' });
        await client.callTool('create_resource', { type: 'primer', name: 'Lending', content: 'p1' });
        await client.callTool('create_resource', { type: 'reference', name: 'Reentrancy', content: 'ref1' });

        const result = await client.callTool('list_resources', { type: 'role' });
        const data = parseResult(result);
        expect(data.total).toBe(1);
        expect(data.resources[0].name).toBe('Hunter');
    });

    it('list_resources filters by language', async () => {
        await setup();

        await client.callTool('create_resource', {
            type: 'role', language: 'solidity', name: 'Sol Hunter', content: 'sol',
        });
        await client.callTool('create_resource', {
            type: 'role', language: 'rust-solana', name: 'Rust Hunter', content: 'rust',
        });

        const result = await client.callTool('list_resources', { language: 'solidity' });
        const data = parseResult(result);
        expect(data.total).toBe(1);
        expect(data.resources[0].name).toBe('Sol Hunter');
    });

    it('list_resources filters by tags (ANY match)', async () => {
        await setup();

        await client.callTool('create_resource', {
            type: 'reference', name: 'Reentrancy', content: 'r',
            tags: ['reentrancy', 'external-calls'],
        });
        await client.callTool('create_resource', {
            type: 'reference', name: 'Access Control', content: 'a',
            tags: ['access-control'],
        });

        const result = await client.callTool('list_resources', { tags: ['reentrancy'] });
        const data = parseResult(result);
        expect(data.total).toBe(1);
        expect(data.resources[0].name).toBe('Reentrancy');
    });

    it('list_resources filters by search term', async () => {
        await setup();

        await client.callTool('create_resource', { type: 'role', name: 'Hunter', content: 'h' });
        await client.callTool('create_resource', { type: 'role', name: 'Cartographer', content: 'c' });

        const result = await client.callTool('list_resources', { search: 'cartographer' });
        const data = parseResult(result);
        expect(data.total).toBe(1);
        expect(data.resources[0].name).toBe('Cartographer');
    });

    it('list_resources summaries exclude content but include contentLength', async () => {
        await setup();

        await client.callTool('create_resource', {
            type: 'role', name: 'Hunter',
            content: '# Hunter\nLong content for testing contentLength field.',
        });

        const result = await client.callTool('list_resources', {});
        const data = parseResult(result);
        const summary = data.resources[0];
        expect(summary).not.toHaveProperty('content');
        expect(summary.contentLength).toBeGreaterThan(0);
    });

    it('update_resource increments version', async () => {
        await setup();

        await client.callTool('create_resource', {
            type: 'role', name: 'Hunter', content: 'v1',
        });

        const result = await client.callTool('update_resource', {
            resource_id: 'role-any-hunter',
            content: 'v2 improved',
        });
        expect(result.isError).not.toBe(true);
        const data = parseResult(result);
        expect(data.version).toBe(2);
        expect(data.updated).toBe(true);

        const getResult = await client.callTool('get_resource', { resource_id: 'role-any-hunter' });
        expect(parseResult(getResult).resource.content).toBe('v2 improved');
    });

    it('update_resource preserves unpatched fields', async () => {
        await setup();

        await client.callTool('create_resource', {
            type: 'role', name: 'Hunter', content: 'original',
            tags: ['test'], language: 'solidity',
        });

        await client.callTool('update_resource', {
            resource_id: 'role-solidity-hunter',
            tags: ['updated-tag'],
        });

        const getResult = await client.callTool('get_resource', { resource_id: 'role-solidity-hunter' });
        const resource = parseResult(getResult).resource;
        expect(resource.content).toBe('original');
        expect(resource.tags).toEqual(['updated-tag']);
        expect(resource.language).toBe('solidity');
    });

    it('delete_resource removes the resource', async () => {
        await setup();

        await client.callTool('create_resource', {
            type: 'role', name: 'Hunter', content: 'to delete',
        });

        const deleteResult = await client.callTool('delete_resource', {
            resource_id: 'role-any-hunter',
        });
        expect(deleteResult.isError).not.toBe(true);
        expect(parseResult(deleteResult).deleted).toBe(true);

        const getResult = await client.callTool('get_resource', { resource_id: 'role-any-hunter' });
        expect(getResult.isError).toBe(true);
    });

    it('get_resource with invalid ID returns error', async () => {
        await setup();

        const result = await client.callTool('get_resource', {
            resource_id: 'nonexistent-id',
        });
        expect(result.isError).toBe(true);
    });
});

// ============================================================================
// REST API TESTS
// ============================================================================

describe('Resource REST API', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    function url(path: string): string {
        return `${testnet.clientUrl}${path}`;
    }

    it('GET /api/resources returns only seeded schemas initially', async () => {
        testnet = await createTestnet();

        const res = await httpJson('GET', url('/api/resources'));
        expect(res.status).toBe(200);
        // 3 built-in schemas are seeded on boot
        expect(res.body.total).toBe(3);
        expect(res.body.resources.every((r: any) => r.type === 'schema')).toBe(true);
    });

    it('POST + GET resource roundtrip', async () => {
        testnet = await createTestnet();

        const postRes = await httpJson('POST', url('/api/resources'), {
            type: 'role',
            language: 'solidity',
            name: 'Hunter',
            content: '# Hunter\nRole definition.',
            tags: ['audit'],
        });
        expect(postRes.status).toBe(201);
        expect(postRes.body.resource_id).toBe('role-solidity-hunter');
        expect(postRes.body.version).toBe(1);

        const getRes = await httpJson('GET', url('/api/resources/role-solidity-hunter'));
        expect(getRes.status).toBe(200);
        expect(getRes.body.resource.name).toBe('Hunter');
        expect(getRes.body.resource.content).toBe('# Hunter\nRole definition.');
    });

    it('POST /api/resources rejects missing required fields', async () => {
        testnet = await createTestnet();

        const res = await httpJson('POST', url('/api/resources'), {
            type: 'role',
            name: 'Hunter',
            // missing content
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('required');
    });

    it('POST /api/resources returns 409 on duplicate', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/resources'), {
            type: 'role', name: 'Hunter', content: 'v1',
        });

        const res = await httpJson('POST', url('/api/resources'), {
            type: 'role', name: 'Hunter', content: 'v2',
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('already exists');
    });

    it('PATCH /api/resources/:id updates and increments version', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/resources'), {
            type: 'role', name: 'Hunter', content: 'v1',
        });

        const patchRes = await httpJson('PATCH', url('/api/resources/role-any-hunter'), {
            content: 'v2 updated',
        });
        expect(patchRes.status).toBe(200);
        expect(patchRes.body.version).toBe(2);
        expect(patchRes.body.updated).toBe(true);
    });

    it('DELETE /api/resources/:id removes resource', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/resources'), {
            type: 'role', name: 'Hunter', content: 'to delete',
        });

        const deleteRes = await httpJson('DELETE', url('/api/resources/role-any-hunter'));
        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.deleted).toBe(true);

        const getRes = await httpJson('GET', url('/api/resources/role-any-hunter'));
        expect(getRes.status).toBe(404);
    });

    it('GET /api/resources?type=role filters correctly', async () => {
        testnet = await createTestnet();

        await httpJson('POST', url('/api/resources'), {
            type: 'role', name: 'Hunter', content: 'r1',
        });
        await httpJson('POST', url('/api/resources'), {
            type: 'primer', name: 'Lending', content: 'p1',
        });

        const res = await httpJson('GET', url('/api/resources?type=role'));
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.resources[0].name).toBe('Hunter');
    });

    it('GET /api/resources/:id returns 404 for nonexistent resource', async () => {
        testnet = await createTestnet();

        const res = await httpJson('GET', url('/api/resources/nonexistent'));
        expect(res.status).toBe(404);
    });

    it('PATCH /api/resources/:id returns 404 for nonexistent resource', async () => {
        testnet = await createTestnet();

        const res = await httpJson('PATCH', url('/api/resources/nonexistent'), {
            content: 'new',
        });
        expect(res.status).toBe(404);
    });

    it('DELETE /api/resources/:id returns 404 for nonexistent resource', async () => {
        testnet = await createTestnet();

        const res = await httpJson('DELETE', url('/api/resources/nonexistent'));
        expect(res.status).toBe(404);
    });
});
