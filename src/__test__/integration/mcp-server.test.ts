/**
 * @fileoverview Integration tests for MCP server
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

describe('MCP Server', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) { await testnet.teardown(); }
    });

    it('responds to initialize handshake', async () => {
        testnet = await createTestnet({ auditSlug: 'test-audit' });
        const client = new McpTestClient(`${testnet.mcpUrl}/test-audit`);

        const result = await client.initialize();
        expect(result).toBeDefined();
        expect(result.protocolVersion).toBeDefined();
        expect(result.serverInfo).toBeDefined();
    });

    it('lists all registered tools', async () => {
        testnet = await createTestnet({ auditSlug: 'test-audit' });
        const client = new McpTestClient(`${testnet.mcpUrl}/test-audit`);

        await client.initialize();
        const tools = await client.listTools();

        expect(tools.length).toBeGreaterThan(0);
        const names = tools.map(t => t.name);
        expect(names).toContain('register_agent');
        expect(names).toContain('heartbeat');
    });

    it('register_agent returns agent_id', async () => {
        testnet = await createTestnet({ auditSlug: 'test-audit' });
        const client = new McpTestClient(`${testnet.mcpUrl}/test-audit`);

        await client.initialize();
        const result = await client.callTool('register_agent', {
            agent_name: 'hunter',
            agent_version: '0.0.1',
        });

        expect(result).toBeDefined();
        const content = result.content;
        expect(content).toBeDefined();
        expect(content.length).toBeGreaterThan(0);

        const text = content[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.agent_id).toBeDefined();
        expect(parsed.agent_id).toContain('hunter');
    });

    it('routes by audit slug in URL path', async () => {
        testnet = await createTestnet({ auditSlug: 'slug-test' });
        const client = new McpTestClient(`${testnet.mcpUrl}/slug-test`);

        await client.initialize();
        // register_agent should work and return the slug
        const result = await client.callTool('register_agent', {
            agent_name: 'hunter',
            agent_version: '0.0.1',
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.audit_slug).toBe('slug-test');
    });

    it('returns error for unknown audit slug', async () => {
        testnet = await createTestnet({ auditSlug: 'real-audit' });
        const client = new McpTestClient(`${testnet.mcpUrl}/nonexistent`);

        await client.initialize();
        // Tool calls to unknown audit should return isError result, not throw
        const result = await client.callTool('heartbeat', {
            agent_type: 'hunter',
            session_id: 'test-session',
        });
        expect(result.isError).toBe(true);
    });

    it('injects agent_id into handler tool schemas (but not register_agent)', async () => {
        testnet = await createTestnet({ auditSlug: 'test-audit' });
        const client = new McpTestClient(`${testnet.mcpUrl}/test-audit`);

        await client.initialize();
        const tools = await client.listTools();

        const registerTool = tools.find(t => t.name === 'register_agent');
        const heartbeatTool = tools.find(t => t.name === 'heartbeat');

        // register_agent should NOT have agent_id
        expect(registerTool).toBeDefined();
        expect(registerTool!.inputSchema.properties).not.toHaveProperty('agent_id');

        // Handler tools SHOULD have agent_id
        expect(heartbeatTool).toBeDefined();
        expect(heartbeatTool!.inputSchema.properties).toHaveProperty('agent_id');
    });

    it('backwards compat: /mcp (no slug) with single audit', async () => {
        testnet = await createTestnet({ auditSlug: 'only-audit' });
        // Connect to /mcp without slug
        const client = new McpTestClient(testnet.mcpUrl);

        await client.initialize();
        const result = await client.callTool('register_agent', {
            agent_name: 'hunter',
            agent_version: '0.0.1',
        });
        // Should succeed using default audit resolution
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.agent_id).toBeDefined();
    });
});
