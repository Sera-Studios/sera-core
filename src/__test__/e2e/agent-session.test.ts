/**
 * @fileoverview E2E test: Full agent session lifecycle
 *
 * Simulates a complete agent session from registration through finding
 * submission and data verification via debug tools.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

describe('Agent Session E2E', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) { await testnet.teardown(); }
    });

    function parse(result: any): any {
        return JSON.parse(result.content[0].text);
    }

    it('full hunter session: register, heartbeat, submit finding, verify in DB', async () => {
        testnet = await createTestnet({ auditSlug: 'e2e-session' });
        const agent = new McpTestClient(`${testnet.mcpUrl}/e2e-session`);
        const debug = new McpTestClient(`${testnet.debugMcpUrl}/e2e-session`);
        await agent.initialize();
        await debug.initialize();

        // Step 1: Register agent
        const regResult = await agent.callTool('register_agent', {
            agent_name: 'hunter',
            agent_version: '1.0.0',
        });
        expect(regResult.isError).not.toBe(true);
        const reg = parse(regResult);
        expect(reg.agent_id).toContain('hunter');
        expect(reg.audit_slug).toBe('e2e-session');
        const agentId = reg.agent_id;

        // Step 2: Heartbeat to establish session
        const hbResult = await agent.callTool('heartbeat', {
            agent_type: 'hunter',
            session_id: `agent_${agentId}`,
            agent_id: agentId,
        });
        expect(hbResult.isError).not.toBe(true);
        const hb = parse(hbResult);
        expect(hb.status).toBe('ok');
        expect(hb.session_active).toBe(true);

        // Step 3: Submit a notepad issue (finding)
        const issueResult = await agent.callTool('submit_notepad_issue', {
            agent_id: agentId,
            file: 'contracts/Vault.sol',
            start_line: 42,
            end_line: 50,
            title: 'Reentrancy in withdraw()',
            severity: 'critical',
            description: 'External call to msg.sender before state update allows reentrancy',
            recommendation: 'Use checks-effects-interactions pattern or ReentrancyGuard',
        });
        expect(issueResult.isError).not.toBe(true);
        const issue = parse(issueResult);
        expect(issue.issue_id).toBeDefined();

        // Step 4: Submit a point of interest
        const poiResult = await agent.callTool('submit_poi', {
            agent_id: agentId,
            file: 'contracts/Vault.sol',
            start_line: 10,
            end_line: 15,
            text: 'State variable declarations - check for storage layout issues',
        });
        expect(poiResult.isError).not.toBe(true);

        // Step 5: Log a prompt
        const promptResult = await agent.callTool('log_prompt', {
            agent_id: agentId,
            prompt: 'Analyze contracts/Vault.sol for reentrancy vulnerabilities',
            session_id: `agent_${agentId}`,
            agent_type: 'hunter',
        });
        expect(promptResult.isError).not.toBe(true);

        // Step 6: Verify data via debug tools
        const stateResult = await debug.callTool('debug_get_storage_state', {});
        const state = parse(stateResult);
        expect(state.length).toBeGreaterThan(0);

        // Query the notepad notes table for our finding
        const notesResult = await debug.callTool('debug_query_audit', {
            sql: "SELECT * FROM notepad_notes WHERE type = 'issue'",
        });
        const notes = parse(notesResult);
        expect(notes.length).toBeGreaterThanOrEqual(1);
        const finding = notes.find((n: any) => n.title === 'Reentrancy in withdraw()');
        expect(finding).toBeDefined();
        expect(finding.severity).toBe('critical');
        expect(finding.filePath).toBe('contracts/Vault.sol');

        // Verify the POI was stored
        const poisResult = await debug.callTool('debug_query_audit', {
            sql: "SELECT * FROM notepad_notes WHERE type = 'poi'",
        });
        const pois = parse(poisResult);
        expect(pois.length).toBeGreaterThanOrEqual(1);

        // Verify sessions are tracked
        const sessionsResult = await debug.callTool('debug_list_sessions', {});
        const sessions = parse(sessionsResult);
        expect(sessions.length).toBeGreaterThanOrEqual(1);
        expect(sessions.some((s: any) => s.agentId === agentId)).toBe(true);

        // Verify event recording captured storage writes
        const eventsResult = await debug.callTool('debug_get_event_log', {
            type: 'storage-update',
        });
        const events = parse(eventsResult);
        expect(events.length).toBeGreaterThanOrEqual(2); // At least heartbeat + notepad writes
    });

    it('agent submits quiz question and trace log', async () => {
        testnet = await createTestnet({ auditSlug: 'e2e-quiz-trace' });
        const agent = new McpTestClient(`${testnet.mcpUrl}/e2e-quiz-trace`);
        const debug = new McpTestClient(`${testnet.debugMcpUrl}/e2e-quiz-trace`);
        await agent.initialize();
        await debug.initialize();

        // Register
        const reg = parse(await agent.callTool('register_agent', {
            agent_name: 'gatherer',
            agent_version: '1.0.0',
        }));
        const agentId = reg.agent_id;

        // Submit quiz question
        const tools = await agent.listTools();
        const quizTools = tools.map((t: any) => t.name).filter((n: string) => n.includes('quiz'));

        if (quizTools.includes('submit_quiz_question')) {
            const quizResult = await agent.callTool('submit_quiz_question', {
                agent_id: agentId,
                question: 'What is the max supply of the token?',
                question_type: 'multichoice',
                code_context: {
                    file: 'contracts/Token.sol',
                    start_line: 5,
                    end_line: 10,
                },
                difficulty: 'easy',
                options: ['100', '1000', '10000', 'Unlimited'],
                recommended_answer: '10000',
            });
            expect(quizResult.isError).not.toBe(true);
        }

        // Submit trace log
        const traceTools = tools.map((t: any) => t.name).filter((n: string) => n.includes('trace'));
        if (traceTools.includes('submit_trace_log')) {
            const traceResult = await agent.callTool('submit_trace_log', {
                agent_id: agentId,
                source: 'gatherer',
                action: 'analyzed',
                target: 'contracts/Token.sol',
                details: 'Checked constructor for supply initialization',
            });
            expect(traceResult.isError).not.toBe(true);
        }

        // Verify via debug query
        const tablesResult = await debug.callTool('debug_query_audit', {
            sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        });
        const tables = parse(tablesResult).map((t: any) => t.name);

        // Check quiz data if quiz tables exist
        const quizTable = tables.find((t: string) => t.includes('quiz'));
        if (quizTable) {
            const quizData = await debug.callTool('debug_query_audit', {
                sql: `SELECT * FROM "${quizTable}"`,
            });
            const quizRows = parse(quizData);
            expect(quizRows.length).toBeGreaterThanOrEqual(1);
        }
    });
});
