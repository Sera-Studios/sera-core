/**
 * @fileoverview E2E test: agent-designer output -> sera-core storage -> MCP query
 *
 * Proves the full cross-module chain works:
 * 1. Agent-designer produces AgentRegistration objects (fixtures represent this output)
 * 2. sera-core accepts them via REST POST
 * 3. They are queryable via both REST GET and MCP list_agent_registrations
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

describe('Agent Designer to Core E2E', () => {
    it('full registration chain: REST register -> REST list -> REST get -> MCP query', async () => {
        testnet = await createTestnet({ auditSlug: 'designer-e2e' });

        // Step 1: Register both agents via REST (simulating agent-designer CLI)
        const hunterRes = await httpRequest(
            'POST', `${testnet.clientUrl}/api/agents/registrations`, HUNTER_REGISTRATION
        );
        expect(hunterRes.status).toBe(201);
        expect(hunterRes.body.registered).toBe('hunter');

        const cartoRes = await httpRequest(
            'POST', `${testnet.clientUrl}/api/agents/registrations`, CARTOGRAPHER_REGISTRATION
        );
        expect(cartoRes.status).toBe(201);
        expect(cartoRes.body.registered).toBe('cartographer');

        // Step 2: Verify both appear in REST list
        const listRes = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations`);
        expect(listRes.status).toBe(200);
        expect(listRes.body.total).toBe(2);
        const restIds = listRes.body.registrations.map((r: any) => r.id).sort();
        expect(restIds).toEqual(['cartographer', 'hunter']);

        // Step 3: Verify full data via REST get by ID
        const hunterGet = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations/hunter`);
        expect(hunterGet.status).toBe(200);
        expect(hunterGet.body.execution.type).toBe('claude-code');
        expect(hunterGet.body.interface.inputs).toHaveLength(3);
        expect(hunterGet.body.interface.outputs).toHaveLength(1);
        expect(hunterGet.body.interface.mcpTools).toEqual(['heartbeat', 'log_prompt', 'submit_poi']);
        expect(hunterGet.body.defaultTimeout).toBe(18000);
        expect(hunterGet.body.metadata.capabilities).toContain('vulnerability-detection');

        const cartoGet = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations/cartographer`);
        expect(cartoGet.status).toBe(200);
        expect(cartoGet.body.execution.type).toBe('claude-code');
        expect(cartoGet.body.defaultTimeout).toBe(10800);

        // Step 4: Verify both appear in MCP list_agent_registrations
        const client = new McpTestClient(`${testnet.mcpUrl}/designer-e2e`);
        await client.initialize();

        const mcpResult = await client.callTool('list_agent_registrations', {});
        const mcpData = JSON.parse(mcpResult.content[0].text);
        expect(mcpData.total).toBe(2);

        const mcpIds = mcpData.registrations.map((r: any) => r.id).sort();
        expect(mcpIds).toEqual(['cartographer', 'hunter']);

        // Verify MCP returns correct summary for hunter
        const mcpHunter = mcpData.registrations.find((r: any) => r.id === 'hunter');
        expect(mcpHunter.name).toBe('Hunter');
        expect(mcpHunter.execution_type).toBe('claude-code');
        expect(mcpHunter.default_timeout).toBe(18000);
        expect(mcpHunter.input_count).toBe(3);
        expect(mcpHunter.output_count).toBe(1);
    });

    it('registered agents survive reload', async () => {
        testnet = await createTestnet({ auditSlug: 'reload-test' });

        // Register an agent with persist=true
        const res = await httpRequest(
            'POST', `${testnet.clientUrl}/api/agents/registrations?persist=true`, HUNTER_REGISTRATION
        );
        expect(res.status).toBe(201);

        // Reload from disk
        const reloadRes = await httpRequest('POST', `${testnet.clientUrl}/api/agents/registrations/reload`);
        expect(reloadRes.status).toBe(200);

        // The agent should still be queryable (was persisted to disk)
        const listRes = await httpRequest('GET', `${testnet.clientUrl}/api/agents/registrations`);
        expect(listRes.status).toBe(200);
        // Note: after reload, only disk-persisted agents remain.
        // The hunter was persisted, so it should be there.
        const hunterFound = listRes.body.registrations.some((r: any) => r.id === 'hunter');
        expect(hunterFound).toBe(true);
    });
});
