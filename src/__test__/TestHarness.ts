/**
 * @fileoverview Test harness for spinning up isolated sera-core instances
 * @module sera-core/__test__/TestHarness
 *
 * Provides createTestnet() which boots a fully isolated sera-core daemon
 * with its own temp directory, random ports, and auto-teardown.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import { SeraCore, SeraCoreOptions } from '../server';
import { CredentialStore } from '../credentials/CredentialStore';
import { generateApiKey, hashApiKey } from '../api/authMiddleware';

export interface TestnetInstance {
    /** The running SeraCore instance */
    core: SeraCore;
    /** Ephemeral sera home directory (e.g. /tmp/sera-test-a1b2c3/) */
    seraHome: string;
    /** Port for REST + WebSocket */
    clientPort: number;
    /** Port for MCP HTTP endpoint */
    mcpPort: number;
    /** Port for debug MCP endpoint (testnet-only) */
    debugPort: number;
    /** Base URL for REST API (e.g. http://localhost:PORT) */
    clientUrl: string;
    /** Base URL for MCP endpoint (e.g. http://localhost:PORT/mcp) */
    mcpUrl: string;
    /** Base URL for debug MCP endpoint (e.g. http://localhost:PORT/mcp) */
    debugMcpUrl: string;
    /** API key for authenticated requests (only set when auth is configured) */
    apiKey?: string;

    /** Create a test audit via REST API */
    createAudit(slug: string, name: string, workspace: string): Promise<void>;
    /** Make a raw MCP JSON-RPC call */
    mcpCall(method: string, params?: any, slug?: string): Promise<any>;
    /** Shut down the testnet and clean up temp directory */
    teardown(): Promise<void>;
}

/**
 * Find a free port by briefly listening on port 0
 */
async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, () => {
            const addr = server.address() as net.AddressInfo;
            const port = addr.port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

/**
 * Make an HTTP request and return the parsed JSON body
 */
function httpJson(method: string, url: string, body?: any, extraHeaders?: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method,
            headers: { 'Content-Type': 'application/json', ...extraHeaders },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve(data);
                }
            });
        });

        req.on('error', reject);
        if (body) { req.write(JSON.stringify(body)); }
        req.end();
    });
}

let mcpRequestId = 1;

export interface CreateTestnetOptions {
    /** If provided, create this audit on startup */
    auditSlug?: string;
    /** Audit display name (used with auditSlug) */
    auditName?: string;
    /** Workspace path to register (used with auditSlug) */
    workspacePath?: string;
    /** Auth configuration override */
    auth?: {
        enabled: boolean;
        skipLocalhost?: boolean;
    };
}

/**
 * Boot an isolated sera-core testnet instance.
 *
 * Creates a temp directory, finds free ports, starts the server,
 * and returns a TestnetInstance with helpers for making requests.
 *
 * Call `teardown()` when done (or use vitest afterEach/afterAll).
 */
export async function createTestnet(options?: CreateTestnetOptions): Promise<TestnetInstance> {
    const seraHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-test-'));
    const [clientPort, mcpPort, debugPort] = await Promise.all([
        findFreePort(), findFreePort(), findFreePort(),
    ]);

    // Create isolated resources directory so testnet doesn't load real agent registrations
    const resourcesDir = path.join(seraHome, 'resources');
    fs.mkdirSync(path.join(resourcesDir, 'agents'), { recursive: true });

    // Write auth config and pre-store API key if auth is enabled
    let testApiKey: string | undefined;
    if (options?.auth) {
        const configData = {
            auth: {
                enabled: options.auth.enabled,
                skipLocalhost: options.auth.skipLocalhost ?? true,
            },
        };
        fs.writeFileSync(path.join(seraHome, 'config.json'), JSON.stringify(configData), 'utf-8');

        // Pre-store an API key so the harness can make authenticated requests
        if (options.auth.enabled) {
            testApiKey = generateApiKey();
            const store = new CredentialStore(seraHome);
            store.saveWithId('testnet-key', 'sera-auth', 'Testnet Key', hashApiKey(testApiKey));
        }
    }

    const coreOptions: SeraCoreOptions = {
        seraHome,
        clientPort,
        mcpPort,
        debugPort,
        testnet: true,
        resourcesDir,
    };

    const core = new SeraCore(coreOptions);
    await core.start();

    const clientUrl = `http://localhost:${clientPort}`;
    const mcpUrl = `http://localhost:${mcpPort}/mcp`;
    const debugMcpUrl = `http://localhost:${debugPort}/mcp`;

    // Auth headers for internal harness calls (when auth is enabled)
    const authHeaders = testApiKey ? { Authorization: `Bearer ${testApiKey}` } : undefined;

    const instance: TestnetInstance = {
        core,
        seraHome,
        clientPort,
        mcpPort,
        debugPort,
        clientUrl,
        mcpUrl,
        debugMcpUrl,
        apiKey: testApiKey,

        async createAudit(slug: string, name: string, workspace: string): Promise<void> {
            const result = await httpJson('POST', `${clientUrl}/api/audits`, {
                name,
                workspacePath: workspace,
            }, authHeaders);
            if (result.error) {
                throw new Error(`Failed to create audit: ${result.error}`);
            }
        },

        async mcpCall(method: string, params?: any, slug?: string): Promise<any> {
            const url = slug ? `${mcpUrl}/${slug}` : mcpUrl;
            const id = mcpRequestId++;
            const body: any = { jsonrpc: '2.0', id, method };
            if (params) { body.params = params; }
            return httpJson('POST', url, body, authHeaders);
        },

        async teardown(): Promise<void> {
            await core.stop();
            fs.rmSync(seraHome, { recursive: true, force: true });
        },
    };

    // Pre-create audit if requested
    if (options?.auditSlug) {
        const name = options.auditName || options.auditSlug;
        const workspace = options.workspacePath || path.join(seraHome, 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        await instance.createAudit(options.auditSlug, name, workspace);
    }

    return instance;
}
