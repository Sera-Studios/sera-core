/**
 * @fileoverview Integration tests for agent registration REST API and MCP tools
 *
 * Tests the full registration flow using sera-core testnet:
 * - REST API CRUD for agent registrations
 * - MCP tool queries for registered agents
 * - Cross-module contract: agent-designer output accepted by sera-core
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';
import { HUNTER_REGISTRATION, CARTOGRAPHER_REGISTRATION } from '../fixtures/agent-registrations';

let testnet: TestnetInstance;

afterEach(async () => {
    if (testnet) { await testnet.teardown(); }
});

/**
 * Make an HTTP request returning { status, body }
 */
function httpRequest(method: string, url: string, body?: any): Promise<{ status: number; body: any }> {
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
        if (payload) { req.write(payload); }
        req.end();
    });
}

describe('Agent Registration REST API', () => {
    it('POST returns 201 for valid registration', async () => {
        testnet = await createTestnet();
        const res = await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, HUNTER_REGISTRATION);
        expect(res.status).toBe(201);
        expect(res.body.registered).toBe('hunter');
    });

    it('POST returns 400 for missing required fields', async () => {
        testnet = await createTestnet();
        const res = await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, {
            description: 'missing id, name, execution',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    it('GET list returns registered agents', async () => {
        testnet = await createTestnet();
        await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, HUNTER_REGISTRATION);
        await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, CARTOGRAPHER_REGISTRATION);

        const res = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations`);
        expect(res.status).toBe(200);
        expect(res.body.registrations).toHaveLength(2);
        expect(res.body.total).toBe(2);

        const ids = res.body.registrations.map((r: any) => r.id);
        expect(ids).toContain('hunter');
        expect(ids).toContain('cartographer');
    });

    it('GET list returns correct summary fields', async () => {
        testnet = await createTestnet();
        await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, HUNTER_REGISTRATION);

        const res = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations`);
        const hunter = res.body.registrations.find((r: any) => r.id === 'hunter');
        expect(hunter).toBeDefined();
        expect(hunter.name).toBe('Hunter');
        expect(hunter.executionType).toBe('claude-code');
        expect(hunter.defaultTimeout).toBe(18000);
        expect(hunter.inputCount).toBe(3);
        expect(hunter.outputCount).toBe(1);
    });

    it('GET by ID returns full registration', async () => {
        testnet = await createTestnet();
        await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, HUNTER_REGISTRATION);

        const res = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations/hunter`);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe('hunter');
        expect(res.body.execution.type).toBe('claude-code');
        expect(res.body.interface.inputs).toHaveLength(3);
        expect(res.body.interface.outputs).toHaveLength(1);
        expect(res.body.interface.mcpTools).toEqual(['heartbeat', 'log_prompt', 'submit_poi']);
    });

    it('GET by ID returns 404 for unknown agent', async () => {
        testnet = await createTestnet();
        const res = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations/nonexistent`);
        expect(res.status).toBe(404);
    });

    it('DELETE removes the registration', async () => {
        testnet = await createTestnet();
        await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, HUNTER_REGISTRATION);

        const del = await httpRequest('DELETE', `${testnet.clientUrl}/api/agents/registrations/hunter`);
        expect(del.status).toBe(200);
        expect(del.body.unregistered).toBe('hunter');

        const get = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations/hunter`);
        expect(get.status).toBe(404);
    });

    it('DELETE returns 404 for unknown agent', async () => {
        testnet = await createTestnet();
        const res = await httpRequest('DELETE', `${testnet.clientUrl}/api/agents/registrations/nonexistent`);
        expect(res.status).toBe(404);
    });
});

describe('Agent Registration MCP Tool', () => {
    it('list_agent_registrations returns empty on fresh instance', async () => {
        testnet = await createTestnet({ auditSlug: 'mcp-test' });
        const client = new McpTestClient(`${testnet.mcpUrl}/mcp-test`);
        await client.initialize();

        const result = await client.callTool('list_agent_registrations', {});
        const data = JSON.parse(result.content[0].text);
        expect(data.registrations).toEqual([]);
        expect(data.total).toBe(0);
    });

    it('returns agents registered via REST', async () => {
        testnet = await createTestnet({ auditSlug: 'mcp-test' });

        // Register via REST
        await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, HUNTER_REGISTRATION);

        // Query via MCP
        const client = new McpTestClient(`${testnet.mcpUrl}/mcp-test`);
        await client.initialize();

        const result = await client.callTool('list_agent_registrations', {});
        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(1);
        expect(data.registrations[0].id).toBe('hunter');
        expect(data.registrations[0].execution_type).toBe('claude-code');
        expect(data.registrations[0].default_timeout).toBe(18000);
        expect(data.registrations[0].input_count).toBe(3);
        expect(data.registrations[0].output_count).toBe(1);
    });

    it('REST register -> MCP query roundtrip preserves all fields', async () => {
        testnet = await createTestnet({ auditSlug: 'mcp-test' });

        await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, HUNTER_REGISTRATION);
        await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations`, CARTOGRAPHER_REGISTRATION);

        const client = new McpTestClient(`${testnet.mcpUrl}/mcp-test`);
        await client.initialize();

        const result = await client.callTool('list_agent_registrations', {});
        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(2);

        const hunter = data.registrations.find((r: any) => r.id === 'hunter');
        const carto = data.registrations.find((r: any) => r.id === 'cartographer');

        expect(hunter.name).toBe('Hunter');
        expect(hunter.description).toContain('Vulnerability');
        expect(carto.name).toBe('Cartographer');
        expect(carto.description).toContain('mapping');
    });
});
