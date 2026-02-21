/**
 * @fileoverview Smoke test for the TestHarness itself
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import { createTestnet, TestnetInstance } from './TestHarness';

function httpGet(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error(`Invalid JSON: ${data}`)); }
            });
        }).on('error', reject);
    });
}

describe('TestHarness', () => {
    let testnet: TestnetInstance | null = null;

    afterEach(async () => {
        if (testnet) {
            await testnet.teardown();
            testnet = null;
        }
    });

    it('boots and tears down cleanly', async () => {
        testnet = await createTestnet();

        // Verify temp directory exists
        expect(fs.existsSync(testnet.seraHome)).toBe(true);

        // Verify health endpoint responds
        const health = await httpGet(`${testnet.clientUrl}/api/health`);
        expect(health.status).toBe('ok');

        // Verify MCP endpoint responds to initialize
        const mcpResult = await testnet.mcpCall('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.1' },
        });
        expect(mcpResult.result).toBeDefined();

        // Teardown and verify cleanup
        const seraHome = testnet.seraHome;
        await testnet.teardown();
        testnet = null;
        expect(fs.existsSync(seraHome)).toBe(false);
    });

    it('creates a pre-configured audit', async () => {
        testnet = await createTestnet({
            auditSlug: 'test-audit',
            auditName: 'Test Audit',
        });

        const audits = await httpGet(`${testnet.clientUrl}/api/audits`);
        expect(audits.audits).toHaveLength(1);
        expect(audits.audits[0].slug).toBe('test-audit');
    });

    it('uses unique ports for each instance', async () => {
        testnet = await createTestnet();
        const testnet2 = await createTestnet();

        try {
            expect(testnet.clientPort).not.toBe(testnet2.clientPort);
            expect(testnet.mcpPort).not.toBe(testnet2.mcpPort);
        } finally {
            await testnet2.teardown();
        }
    });
});
