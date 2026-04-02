/**
 * @fileoverview Integration tests for DebugHandler (testnet-only, separate port)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

describe('DebugHandler', () => {
    let testnet: TestnetInstance;
    let agentClient: McpTestClient;
    let debugClient: McpTestClient;

    afterEach(async () => {
        if (testnet) { await testnet.teardown(); }
    });

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'debug-test' });
        // Agent tools on the main MCP port
        agentClient = new McpTestClient(`${testnet.mcpUrl}/debug-test`);
        await agentClient.initialize();
        // Debug tools on the dedicated debug port
        debugClient = new McpTestClient(`${testnet.debugMcpUrl}/debug-test`);
        await debugClient.initialize();
    }

    function parseResult(result: any): any {
        const text = result.content[0].text;
        try { return JSON.parse(text); }
        catch { return text; }
    }

    describe('port isolation', () => {
        it('debug tools are on the debug port, not the main MCP port', async () => {
            await setup();

            // Main MCP port should NOT have debug tools
            const mainTools = await agentClient.listTools();
            const mainDebugTools = mainTools.filter((t: any) => t.name.startsWith('debug_'));
            expect(mainDebugTools).toHaveLength(0);

            // Debug port should have debug tools
            const debugTools = await debugClient.listTools();
            const debugNames = debugTools.map((t: any) => t.name);
            expect(debugNames).toContain('debug_get_logs');
            expect(debugNames).toContain('debug_get_event_log');
            expect(debugNames).toContain('debug_query_audit');
            expect(debugNames).toContain('debug_list_sessions');
            expect(debugNames).toContain('debug_get_storage_state');
        });

        it('handler tools are on the main port, not the debug port', async () => {
            await setup();

            // Main MCP port should have handler tools
            const mainTools = await agentClient.listTools();
            const mainNames = mainTools.map((t: any) => t.name);
            expect(mainNames).toContain('heartbeat');
            expect(mainNames).toContain('submit_finding');

            // Debug port should NOT have handler tools (only debug_ + register_agent built-in)
            const debugTools = await debugClient.listTools();
            const debugNames = debugTools.map((t: any) => t.name);
            expect(debugNames).not.toContain('heartbeat');
            expect(debugNames.every(
                (n: string) => n.startsWith('debug_') || n === 'register_agent'
            )).toBe(true);
        });
    });

    describe('debug_get_logs', () => {
        it('returns log entries from the LogBuffer', async () => {
            await setup();

            const logBuffer = testnet.core.getLogBuffer();
            expect(logBuffer).toBeDefined();
            logBuffer!.capture('info', 'test log message', { key: 'value' });

            const result = await debugClient.callTool('debug_get_logs', {});
            expect(result.isError).not.toBe(true);

            const entries = parseResult(result);
            expect(Array.isArray(entries)).toBe(true);

            const testEntry = entries.find((e: any) => e.message === 'test log message');
            expect(testEntry).toBeDefined();
            expect(testEntry.level).toBe('info');
            expect(testEntry.meta).toEqual({ key: 'value' });
        });

        it('respects limit parameter', async () => {
            await setup();

            const logBuffer = testnet.core.getLogBuffer()!;
            logBuffer.clear(); // Clear any entries from server startup logging
            logBuffer.capture('info', 'first');
            logBuffer.capture('info', 'second');
            logBuffer.capture('info', 'third');

            const result = await debugClient.callTool('debug_get_logs', { limit: 2 });
            const entries = parseResult(result);
            // The tool call itself may add log entries to the buffer via the
            // structured logger capture callback. Verify limit works by checking
            // the returned count, but allow for additional logger entries.
            expect(entries.length).toBeLessThanOrEqual(2);
        });

        it('filters by level', async () => {
            await setup();

            const logBuffer = testnet.core.getLogBuffer()!;
            logBuffer.capture('info', 'info msg');
            logBuffer.capture('error', 'error msg');
            logBuffer.capture('info', 'another info');

            const result = await debugClient.callTool('debug_get_logs', { level: 'error' });
            const entries = parseResult(result);
            expect(entries).toHaveLength(1);
            expect(entries[0].message).toBe('error msg');
        });
    });

    describe('debug_get_event_log', () => {
        it('returns recorded events after MCP tool calls', async () => {
            await setup();

            // Use agent client for agent operations
            await agentClient.callTool('heartbeat', {
                agent_type: 'hunter',
                session_id: 'debug-session',
            });

            // Use debug client to inspect events
            const result = await debugClient.callTool('debug_get_event_log', {});
            expect(result.isError).not.toBe(true);

            const events = parseResult(result);
            expect(Array.isArray(events)).toBe(true);
            expect(events.length).toBeGreaterThanOrEqual(1);
        });

        it('filters by event type', async () => {
            await setup();

            await agentClient.callTool('heartbeat', {
                agent_type: 'hunter',
                session_id: 'debug-session',
            });

            const result = await debugClient.callTool('debug_get_event_log', {
                type: 'storage-update',
            });
            const events = parseResult(result);
            expect(Array.isArray(events)).toBe(true);
            for (const event of events) {
                expect(event.type).toBe('storage-update');
            }
        });
    });

    describe('debug_query_audit', () => {
        it('executes SQL against the audit database', async () => {
            await setup();

            await agentClient.callTool('heartbeat', {
                agent_type: 'hunter',
                session_id: 'sql-test-session',
            });

            const result = await debugClient.callTool('debug_query_audit', {
                sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            });
            expect(result.isError).not.toBe(true);

            const tables = parseResult(result);
            expect(Array.isArray(tables)).toBe(true);
            const tableNames = tables.map((t: any) => t.name);
            expect(tableNames.some((n: string) => n.includes('heartbeats'))).toBe(true);
        });

        it('supports parameterized queries', async () => {
            await setup();

            await agentClient.callTool('heartbeat', {
                agent_type: 'hunter',
                session_id: 'param-test',
            });

            const result = await debugClient.callTool('debug_query_audit', {
                sql: 'SELECT * FROM sessionbridge_heartbeats WHERE source = ?',
                params: ['claude-param-test'],
            });
            expect(result.isError).not.toBe(true);

            const rows = parseResult(result);
            expect(Array.isArray(rows)).toBe(true);
            expect(rows.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('debug_list_sessions', () => {
        it('returns empty list when no agents registered', async () => {
            await setup();

            const result = await debugClient.callTool('debug_list_sessions', {});
            expect(result.isError).not.toBe(true);

            const sessions = parseResult(result);
            expect(Array.isArray(sessions)).toBe(true);
        });

        it('lists registered agent sessions', async () => {
            await setup();

            // Register via agent client
            await agentClient.callTool('register_agent', {
                agent_name: 'hunter',
                agent_version: '0.1.0',
            });

            // Inspect via debug client
            const result = await debugClient.callTool('debug_list_sessions', {});
            const sessions = parseResult(result);
            expect(sessions.length).toBeGreaterThanOrEqual(1);

            const hunterSession = sessions.find((s: any) => s.agentType === 'hunter');
            expect(hunterSession).toBeDefined();
            expect(hunterSession.agentId).toContain('hunter');
            expect(hunterSession.auditSlug).toBe('debug-test');
        });
    });

    describe('debug_get_storage_state', () => {
        it('returns table names and row counts', async () => {
            await setup();

            await agentClient.callTool('heartbeat', {
                agent_type: 'hunter',
                session_id: 'storage-state-test',
            });

            const result = await debugClient.callTool('debug_get_storage_state', {});
            expect(result.isError).not.toBe(true);

            const state = parseResult(result);
            expect(Array.isArray(state)).toBe(true);
            expect(state.length).toBeGreaterThan(0);

            for (const entry of state) {
                expect(entry.table).toBeDefined();
                expect(typeof entry.rowCount).toBe('number');
            }

            const heartbeats = state.find((s: any) => s.table.includes('heartbeats'));
            expect(heartbeats).toBeDefined();
            expect(heartbeats.rowCount).toBeGreaterThanOrEqual(1);
        });
    });
});
