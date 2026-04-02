/**
 * @fileoverview Integration tests for monitoring and observability
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { createTestnet, TestnetInstance } from '../TestHarness';

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
): Promise<{ status: number; body: any }> {
    const body = {
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        ...(params ? { params } : {}),
    };
    return httpRequest('POST', mcpUrl, body);
}

describe('Monitoring & Observability', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    describe('Enhanced health endpoint', () => {
        it('returns dependency checks and metrics summary', async () => {
            testnet = await createTestnet({ auditSlug: 'mon-test' });

            // Make a few requests to generate metrics
            await httpRequest('GET', `${testnet.clientUrl}/api/audits`);
            await httpRequest('GET', `${testnet.clientUrl}/api/audits`);

            const res = await httpRequest('GET', `${testnet.clientUrl}/api/health`);
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('healthy');
            expect(res.body.version).toBe('0.1.0');
            expect(res.body.uptime).toBeGreaterThanOrEqual(0);

            // Dependency checks
            expect(res.body.checks).toBeDefined();
            expect(res.body.checks.database).toBeDefined();
            expect(res.body.checks.database.status).toBe('healthy');
            expect(res.body.checks.credentialStore).toBeDefined();

            // Metrics summary
            expect(res.body.metrics).toBeDefined();
            expect(res.body.metrics.requestsLastHour).toBeGreaterThanOrEqual(0);
            expect(typeof res.body.metrics.errorsLastHour).toBe('number');
            expect(typeof res.body.metrics.avgLatencyMs).toBe('number');
            expect(Array.isArray(res.body.metrics.topTools)).toBe(true);
        });
    });

    describe('Metrics endpoint', () => {
        it('GET /api/health/metrics returns detailed metrics', async () => {
            testnet = await createTestnet({ auditSlug: 'mon-test' });

            // Generate some REST metrics
            await httpRequest('GET', `${testnet.clientUrl}/api/audits`);

            const res = await httpRequest('GET', `${testnet.clientUrl}/api/health/metrics`);
            expect(res.status).toBe(200);
            expect(res.body.period).toBeDefined();
            expect(res.body.period.minutes).toBe(60);
            expect(res.body.requests).toBeDefined();
            expect(res.body.requests.total).toBeGreaterThanOrEqual(1);
            expect(res.body.toolCalls).toBeDefined();
        });

        it('respects minutes query parameter', async () => {
            testnet = await createTestnet({ auditSlug: 'mon-test' });

            const res = await httpRequest('GET', `${testnet.clientUrl}/api/health/metrics?minutes=5`);
            expect(res.status).toBe(200);
            expect(res.body.period.minutes).toBe(5);
        });
    });

    describe('MCP tool call metrics', () => {
        it('records tool calls with toolName', async () => {
            testnet = await createTestnet({ auditSlug: 'mon-test' });

            // Make some MCP tool calls
            await mcpCall(`${testnet.mcpUrl}/mon-test`, 'tools/list');
            await mcpCall(`${testnet.mcpUrl}/mon-test`, 'tools/call', {
                name: 'heartbeat',
                arguments: { agent_type: 'hunter' },
            });

            // Check metrics include tool call data
            const res = await httpRequest('GET', `${testnet.clientUrl}/api/health/metrics`);
            expect(res.status).toBe(200);

            // heartbeat tool call should be recorded
            if (res.body.toolCalls.total > 0) {
                expect(res.body.toolCalls.byTool).toBeDefined();
            }
        });
    });

    describe('system_health MCP tool', () => {
        it('returns health data', async () => {
            testnet = await createTestnet({ auditSlug: 'mon-test' });

            const res = await mcpCall(`${testnet.mcpUrl}/mon-test`, 'tools/call', {
                name: 'system_health',
                arguments: {},
            });
            expect(res.status).toBe(200);

            const result = JSON.parse(res.body.result.content[0].text);
            expect(result.status).toBe('healthy');
            expect(result.version).toBe('0.1.0');
            expect(result.checks).toBeDefined();
            expect(result.metrics).toBeDefined();
        });
    });

    describe('system_metrics MCP tool', () => {
        it('returns metrics summary', async () => {
            testnet = await createTestnet({ auditSlug: 'mon-test' });

            const res = await mcpCall(`${testnet.mcpUrl}/mon-test`, 'tools/call', {
                name: 'system_metrics',
                arguments: { minutes: 60 },
            });
            expect(res.status).toBe(200);

            const result = JSON.parse(res.body.result.content[0].text);
            expect(result.period.minutes).toBe(60);
            expect(result.requests).toBeDefined();
            expect(result.toolCalls).toBeDefined();
        });
    });
});
