/**
 * @fileoverview Integration tests for agent execution REST endpoints
 *
 * Tests the full execution lifecycle via HTTP:
 * POST /api/agents/executions -> GET status -> GET output -> DELETE stop
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createTestnet, TestnetInstance } from '../TestHarness';
import type { AgentRegistration } from '@sera/types';

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
        if (payload) req.write(payload);
        req.end();
    });
}

/** Wait for an execution to reach a terminal state */
async function waitForCompletion(baseUrl: string, instanceId: string, maxMs = 10000): Promise<any> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const res = await httpRequest('GET', `${baseUrl}/api/agents/executions/${instanceId}`);
        if (res.body.status === 'completed' || res.body.status === 'failed' || res.body.status === 'stopped') {
            return res.body;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Execution ${instanceId} did not complete within ${maxMs}ms`);
}

/** Helper to write a Python script to the testnet's home dir and return the absolute path */
function writeTestScript(seraHome: string, name: string, code: string): string {
    const scriptsDir = path.join(seraHome, 'test-scripts');
    if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
    }
    const filePath = path.join(scriptsDir, name);
    fs.writeFileSync(filePath, code);
    return filePath;
}

function makeScriptAgent(id: string, scriptPath: string, overrides?: Partial<AgentRegistration>): AgentRegistration {
    return {
        id,
        name: `Test Agent ${id}`,
        version: '0.1.0',
        description: 'Test agent',
        execution: {
            type: 'script',
            interpreter: 'python3',
            scriptPath,
        },
        interface: { inputs: [], outputs: [] },
        defaultTimeout: 30,
        ...overrides,
    } as AgentRegistration;
}

describe('Agent Execution REST API', () => {
    it('launches a script agent and retrieves output', async () => {
        testnet = await createTestnet();
        const base = testnet.clientUrl;
        const sp = writeTestScript(testnet.seraHome, 'echo.py', "print('execution test output')\n");

        // Register the agent
        const agent = makeScriptAgent('test-script-agent', sp);
        const regRes = await httpRequest('POST', `${base}/api/agents/registrations`, agent);
        expect(regRes.status).toBe(201);

        // Launch execution
        const launchRes = await httpRequest('POST', `${base}/api/agents/executions`, {
            registrationId: 'test-script-agent',
            workspacePath: '/tmp/test',
        });
        expect(launchRes.status).toBe(201);
        expect(launchRes.body.instanceId).toBeDefined();
        expect(launchRes.body.registrationId).toBe('test-script-agent');
        expect(launchRes.body.status).toMatch(/starting|running/);

        // Wait for completion
        const final = await waitForCompletion(base, launchRes.body.instanceId);
        expect(final.status).toBe('completed');
        expect(final.exitCode).toBe(0);

        // Get output
        const outputRes = await httpRequest('GET', `${base}/api/agents/executions/${launchRes.body.instanceId}/output`);
        expect(outputRes.status).toBe(200);
        expect(outputRes.body.stdout).toContain('execution test output');
    });

    it('lists all executions', async () => {
        testnet = await createTestnet();
        const base = testnet.clientUrl;
        const sp = writeTestScript(testnet.seraHome, 'list.py', "print('done')\n");

        // Register agent
        const agent = makeScriptAgent('test-script-agent', sp);
        await httpRequest('POST', `${base}/api/agents/registrations`, agent);

        // Launch
        const launchRes = await httpRequest('POST', `${base}/api/agents/executions`, {
            registrationId: 'test-script-agent',
            workspacePath: '/tmp/test',
        });

        // List
        const listRes = await httpRequest('GET', `${base}/api/agents/executions`);
        expect(listRes.status).toBe(200);
        expect(Array.isArray(listRes.body)).toBe(true);
        expect(listRes.body.length).toBe(1);
        expect(listRes.body[0].instanceId).toBe(launchRes.body.instanceId);

        // Wait for completion to avoid dangling processes
        await waitForCompletion(base, launchRes.body.instanceId);
    });

    it('returns 404 for unknown registration', async () => {
        testnet = await createTestnet();
        const base = testnet.clientUrl;

        const res = await httpRequest('POST', `${base}/api/agents/executions`, {
            registrationId: 'nonexistent',
            workspacePath: '/tmp/test',
        });
        expect(res.status).toBe(404);
        expect(res.body.error).toContain('not found');
    });

    it('returns 400 for unsupported execution type', async () => {
        testnet = await createTestnet();
        const base = testnet.clientUrl;

        // Register a docker agent (not supported)
        await httpRequest('POST', `${base}/api/agents/registrations`, {
            id: 'docker-agent',
            name: 'Docker Agent',
            version: '0.1.0',
            description: 'test',
            execution: { type: 'docker', image: 'test:latest' },
            interface: { inputs: [], outputs: [] },
            defaultTimeout: 30,
        });

        const res = await httpRequest('POST', `${base}/api/agents/executions`, {
            registrationId: 'docker-agent',
            workspacePath: '/tmp/test',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Unsupported');
    });

    it('returns 400 when required fields are missing', async () => {
        testnet = await createTestnet();
        const base = testnet.clientUrl;

        const res = await httpRequest('POST', `${base}/api/agents/executions`, {});
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('required');
    });

    it('returns 404 for unknown execution instance', async () => {
        testnet = await createTestnet();
        const base = testnet.clientUrl;

        const res = await httpRequest('GET', `${base}/api/agents/executions/nonexistent`);
        expect(res.status).toBe(404);
    });

    it('returns 404 when stopping an unknown execution', async () => {
        testnet = await createTestnet();
        const base = testnet.clientUrl;

        const res = await httpRequest('DELETE', `${base}/api/agents/executions/nonexistent`);
        expect(res.status).toBe(404);
    });

    it('stops a running execution', async () => {
        testnet = await createTestnet();
        const base = testnet.clientUrl;
        const sp = writeTestScript(testnet.seraHome, 'sleep.py', "import time\ntime.sleep(60)\n");

        // Register a long-running agent
        const agent = makeScriptAgent('slow-agent', sp);
        await httpRequest('POST', `${base}/api/agents/registrations`, agent);

        // Launch
        const launchRes = await httpRequest('POST', `${base}/api/agents/executions`, {
            registrationId: 'slow-agent',
            workspacePath: '/tmp/test',
        });
        expect(launchRes.status).toBe(201);

        // Give it a moment to start
        await new Promise(r => setTimeout(r, 200));

        // Stop it
        const stopRes = await httpRequest('DELETE', `${base}/api/agents/executions/${launchRes.body.instanceId}`);
        expect(stopRes.status).toBe(200);
        expect(stopRes.body.stopped).toBe(launchRes.body.instanceId);

        // Verify it's stopped
        const final = await waitForCompletion(base, launchRes.body.instanceId);
        expect(final.status).toBe('stopped');
    });
});
