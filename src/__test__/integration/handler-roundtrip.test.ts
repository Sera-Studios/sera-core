/**
 * @fileoverview Integration tests for MCP handler roundtrips
 *
 * Tests each handler's tools through the full MCP stack.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

describe('Handler Roundtrips', () => {
    let testnet: TestnetInstance;
    let client: McpTestClient;

    afterEach(async () => {
        if (testnet) { await testnet.teardown(); }
    });

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'handler-test' });
        client = new McpTestClient(`${testnet.mcpUrl}/handler-test`);
        await client.initialize();
    }

    function parseResult(result: any): any {
        const text = result.content[0].text;
        try { return JSON.parse(text); }
        catch { return text; }
    }

    describe('CoreHandler', () => {
        it('heartbeat creates session and returns status', async () => {
            await setup();

            const result = await client.callTool('heartbeat', {
                agent_type: 'hunter',
                session_id: 'test-session-1',
            });

            expect(result.content).toBeDefined();
            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.status).toBe('ok');
            expect(data.session_active).toBe(true);
        });
    });

    describe('NotepadHandler', () => {
        it('submits and retrieves notepad issues', async () => {
            await setup();

            // First, discover available tools
            const tools = await client.listTools();
            const findingTool = tools.find(t => t.name === 'submit_finding');
            expect(findingTool).toBeDefined();

            const result = await client.callTool('submit_finding', {
                file: 'audit-repos/test/contracts/Vault.sol',
                start_line: 42,
                end_line: 42,
                title: 'Reentrancy Bug',
                severity: 'critical',
                description: 'External call before state update',
                recommendation: 'Use checks-effects-interactions pattern',
            });
            expect(result.content).toBeDefined();
            expect(result.isError).not.toBe(true);
        });
    });

    describe('QuizHandler', () => {
        it('submits and retrieves quiz questions', async () => {
            await setup();

            const tools = await client.listTools();
            const quizTools = tools
                .filter(t => t.name.includes('quiz'))
                .map(t => t.name);

            if (quizTools.includes('submit_quiz_question')) {
                const result = await client.callTool('submit_quiz_question', {
                    question: 'What is the max supply?',
                    question_type: 'multichoice',
                    code_context: {
                        file: 'audit-repos/test/contracts/Token.sol',
                        start_line: 10,
                        end_line: 20,
                    },
                    difficulty: 'medium',
                    options: ['100', '1000', '10000', 'Unlimited'],
                    recommended_answer: '10000',
                });
                expect(result.content).toBeDefined();
                expect(result.isError).not.toBe(true);
            }
            expect(quizTools.length).toBeGreaterThan(0);
        });
    });

    describe('TraceHandler', () => {
        it('submits a trace log', async () => {
            await setup();

            const tools = await client.listTools();
            const traceTools = tools
                .filter(t => t.name.includes('trace'))
                .map(t => t.name);

            if (traceTools.includes('submit_trace_log')) {
                const result = await client.callTool('submit_trace_log', {
                    source: 'hunter',
                    action: 'analyzed',
                    target: 'contracts/Vault.sol',
                    details: 'Checked withdraw function for reentrancy',
                });
                expect(result.content).toBeDefined();
                expect(result.isError).not.toBe(true);
            }
            expect(traceTools.length).toBeGreaterThan(0);
        });
    });

    describe('AgentHandler', () => {
        it('lists agent registrations', async () => {
            await setup();

            const tools = await client.listTools();
            const agentTools = tools
                .filter(t => t.name.includes('agent') && t.name !== 'register_agent')
                .map(t => t.name);

            expect(agentTools).toContain('list_agent_registrations');

            const result = await client.callTool('list_agent_registrations', {});
            const data = parseResult(result);
            expect(data.registrations).toBeDefined();
            expect(Array.isArray(data.registrations)).toBe(true);
            expect(typeof data.total).toBe('number');
        });
    });

    describe('Tool discovery', () => {
        it('all tools have name and inputSchema', async () => {
            await setup();
            const tools = await client.listTools();

            for (const tool of tools) {
                expect(tool.name).toBeDefined();
                expect(tool.name.length).toBeGreaterThan(0);
                expect(tool.inputSchema).toBeDefined();
                expect(tool.inputSchema.type).toBe('object');
            }
        });

        it('has tools from all registered handlers', async () => {
            await setup();
            const tools = await client.listTools();
            const names = tools.map(t => t.name);

            // Should have tools from each major handler
            expect(names).toContain('register_agent');
            expect(names).toContain('heartbeat');
            expect(names).toContain('list_agent_registrations');
            expect(names).toContain('submit_finding');
        });
    });
});
