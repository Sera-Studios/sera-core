/**
 * @fileoverview Lightweight MCP JSON-RPC client for tests
 * @module sera-core/__test__/McpTestClient
 *
 * Wraps the MCP protocol (initialize, tools/list, tools/call) into
 * simple async methods for use in integration and E2E tests.
 */

import * as http from 'http';
import { McpToolDefinition } from '@sera/types';

let globalRequestId = 1;

function httpPost(url: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const payload = JSON.stringify(body);
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error(`Invalid JSON response: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

export class McpTestClient {
    private baseUrl: string;
    private sessionId?: string;

    /**
     * @param baseUrl - Full MCP URL including slug, e.g. http://localhost:PORT/mcp/test-slug
     */
    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    /**
     * Send a JSON-RPC request to the MCP server
     */
    private async rpc(method: string, params?: any): Promise<any> {
        const id = globalRequestId++;
        const body: any = { jsonrpc: '2.0', id, method };
        if (params) { body.params = params; }
        const response = await httpPost(this.baseUrl, body);
        if (response.error) {
            const err = response.error;
            throw new Error(`MCP error ${err.code}: ${err.message}`);
        }
        return response.result;
    }

    /**
     * Perform the MCP initialize handshake
     */
    async initialize(): Promise<any> {
        const result = await this.rpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.1' },
        });
        this.sessionId = result?.sessionId;
        return result;
    }

    /**
     * List all available MCP tools
     */
    async listTools(): Promise<McpToolDefinition[]> {
        const result = await this.rpc('tools/list');
        return result?.tools || [];
    }

    /**
     * Call an MCP tool by name
     */
    async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
        const result = await this.rpc('tools/call', {
            name,
            arguments: args,
        });
        return result;
    }

    /**
     * Get the session ID assigned during initialize
     */
    getSessionId(): string | undefined {
        return this.sessionId;
    }
}
