/**
 * @fileoverview Integration tests for API key authentication
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { createTestnet, TestnetInstance } from '../TestHarness';

// ============================================================================
// HELPERS
// ============================================================================

function httpRequest(
    method: string,
    url: string,
    body?: any,
    headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
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
                ...headers,
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

function mcpCall(
    mcpUrl: string,
    method: string,
    params?: any,
    headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
    const body = {
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        ...(params ? { params } : {}),
    };
    return httpRequest('POST', mcpUrl, body, headers);
}

// ============================================================================
// AUTH DISABLED (DEFAULT)
// ============================================================================

describe('Auth disabled (default)', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    it('REST endpoint accessible without key', async () => {
        testnet = await createTestnet();
        const res = await httpRequest('GET', `${testnet.clientUrl}/api/audits`);
        expect(res.status).toBe(200);
    });

    it('MCP endpoint accessible without key', async () => {
        testnet = await createTestnet({ auditSlug: 'auth-test' });
        const res = await mcpCall(`${testnet.mcpUrl}/auth-test`, 'tools/list');
        expect(res.status).toBe(200);
        expect(res.body.result.tools).toBeDefined();
    });
});

// ============================================================================
// AUTH ENABLED
// ============================================================================

describe('Auth enabled', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    it('REST: valid key returns 200', async () => {
        testnet = await createTestnet({
            auditSlug: 'auth-test',
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await httpRequest(
            'GET',
            `${testnet.clientUrl}/api/audits`,
            undefined,
            { Authorization: `Bearer ${testnet.apiKey}` },
        );
        expect(res.status).toBe(200);
    });

    it('MCP: valid key allows tool call', async () => {
        testnet = await createTestnet({
            auditSlug: 'auth-test',
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await mcpCall(
            `${testnet.mcpUrl}/auth-test`,
            'tools/list',
            undefined,
            { Authorization: `Bearer ${testnet.apiKey}` },
        );
        expect(res.status).toBe(200);
        expect(res.body.result.tools).toBeDefined();
    });

    it('REST: no key returns 401 with helpful message', async () => {
        testnet = await createTestnet({
            auditSlug: 'auth-test',
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await httpRequest('GET', `${testnet.clientUrl}/api/audits`);
        expect(res.status).toBe(401);
        expect(res.body.error).toContain('Missing API key');
    });

    it('MCP: no key returns 401', async () => {
        testnet = await createTestnet({
            auditSlug: 'auth-test',
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await mcpCall(`${testnet.mcpUrl}/auth-test`, 'tools/list');
        expect(res.status).toBe(401);
        expect(res.body.error).toContain('Missing API key');
    });

    it('REST: invalid key returns 403', async () => {
        testnet = await createTestnet({
            auditSlug: 'auth-test',
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await httpRequest(
            'GET',
            `${testnet.clientUrl}/api/audits`,
            undefined,
            { Authorization: 'Bearer sk-sera-invalid0000000000000000000000' },
        );
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('Invalid API key');
    });

    it('MCP: invalid key returns 403', async () => {
        testnet = await createTestnet({
            auditSlug: 'auth-test',
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await mcpCall(
            `${testnet.mcpUrl}/auth-test`,
            'tools/list',
            undefined,
            { Authorization: 'Bearer sk-sera-invalid0000000000000000000000' },
        );
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('Invalid API key');
    });

    it('REST: localhost bypass works when skipLocalhost=true', async () => {
        testnet = await createTestnet({
            auditSlug: 'auth-test',
            auth: { enabled: true, skipLocalhost: true },
        });
        // Test requests go to localhost, so they should be bypassed
        const res = await httpRequest('GET', `${testnet.clientUrl}/api/audits`);
        expect(res.status).toBe(200);
    });

    it('REST: no bypass when skipLocalhost=false', async () => {
        testnet = await createTestnet({
            auditSlug: 'auth-test',
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await httpRequest('GET', `${testnet.clientUrl}/api/audits`);
        expect(res.status).toBe(401);
    });

    it('REST: health endpoint accessible without auth', async () => {
        testnet = await createTestnet({
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await httpRequest('GET', `${testnet.clientUrl}/api/health`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('healthy');
    });

    it('MCP: health endpoint accessible without auth', async () => {
        testnet = await createTestnet({
            auth: { enabled: true, skipLocalhost: false },
        });
        const res = await httpRequest('GET', `http://localhost:${testnet.mcpPort}/health`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok'); // MCP health still returns 'ok'
    });
});
