/**
 * @fileoverview Integration tests for REST API
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { createTestnet, TestnetInstance } from '../TestHarness';

function httpRequest(method: string, url: string, body?: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method,
            headers: { 'Content-Type': 'application/json' },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode!, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode!, data });
                }
            });
        });

        req.on('error', reject);
        if (body) { req.write(JSON.stringify(body)); }
        req.end();
    });
}

describe('REST API', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) { await testnet.teardown(); }
    });

    describe('GET /api/health', () => {
        it('returns status ok', async () => {
            testnet = await createTestnet();
            const { status, data } = await httpRequest('GET', `${testnet.clientUrl}/api/health`);

            expect(status).toBe(200);
            expect(data.status).toBe('healthy');
            expect(data.version).toBeDefined();
            expect(data.uptime).toBeGreaterThanOrEqual(0);
        });
    });

    describe('audit CRUD', () => {
        it('creates and lists audits', async () => {
            testnet = await createTestnet();

            // Create
            const { status: createStatus, data: createData } = await httpRequest(
                'POST',
                `${testnet.clientUrl}/api/audits`,
                { name: 'New Audit', workspacePath: '/tmp/ws' }
            );
            expect(createStatus).toBe(201);
            expect(createData.slug).toBeDefined();

            // List
            const { data: listData } = await httpRequest('GET', `${testnet.clientUrl}/api/audits`);
            expect(listData.audits).toHaveLength(1);
            expect(listData.audits[0].name).toBe('New Audit');
        });

        it('returns 409 for duplicate audit', async () => {
            testnet = await createTestnet();

            await httpRequest('POST', `${testnet.clientUrl}/api/audits`, {
                name: 'Dup Test', workspacePath: '/tmp/ws1',
            });

            const { status } = await httpRequest('POST', `${testnet.clientUrl}/api/audits`, {
                name: 'Dup Test', workspacePath: '/tmp/ws2',
            });
            expect(status).toBe(409);
        });

        it('returns 400 for missing fields', async () => {
            testnet = await createTestnet();

            const { status } = await httpRequest('POST', `${testnet.clientUrl}/api/audits`, {
                name: 'No Workspace',
            });
            expect(status).toBe(400);
        });

        it('gets audit metadata by slug', async () => {
            testnet = await createTestnet({ auditSlug: 'meta-test', auditName: 'Meta Test' });

            const { status, data } = await httpRequest('GET', `${testnet.clientUrl}/api/audits/meta-test`);
            expect(status).toBe(200);
            expect(data.slug).toBe('meta-test');
            expect(data.name).toBe('Meta Test');
        });

        it('returns 404 for unknown audit slug', async () => {
            testnet = await createTestnet();

            const { status } = await httpRequest('GET', `${testnet.clientUrl}/api/audits/nonexistent`);
            expect(status).toBe(404);
        });
    });
});
