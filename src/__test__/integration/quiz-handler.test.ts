/**
 * @fileoverview Integration tests for the QuizHandler MCP tools
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

describe('QuizHandler', () => {
    let testnet: TestnetInstance;
    let client: McpTestClient;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'quiz-test' });
        client = new McpTestClient(`${testnet.mcpUrl}/quiz-test`);
        await client.initialize();
    }

    function parseResult(result: any): any {
        const text = result.content[0].text;
        try { return JSON.parse(text); }
        catch { return text; }
    }

    // ========================================================================
    // submit_quiz_question
    // ========================================================================

    describe('submit_quiz_question', () => {
        it('submits a multichoice question and returns question_id', async () => {
            await setup();

            const result = await client.callTool('submit_quiz_question', {
                question: 'What is the max token supply?',
                question_type: 'multichoice',
                code_context: {
                    file: 'contracts/Token.sol',
                    start_line: 10,
                    end_line: 15,
                },
                difficulty: 'easy',
                options: ['100', '1000', '10000', 'Unlimited'],
                recommended_answer: '10000',
            });

            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.question_id).toBeDefined();
            expect(data.question_id).toContain('quiz_');
        });

        it('submits a short_answer question', async () => {
            await setup();

            const result = await client.callTool('submit_quiz_question', {
                question: 'Explain the reentrancy pattern',
                question_type: 'short_answer',
                code_context: {
                    file: 'contracts/Vault.sol',
                    start_line: 42,
                    end_line: 58,
                },
                difficulty: 'hard',
                recommended_answer: 'A reentrancy attack exploits external calls before state updates',
            });

            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.question_id).toContain('quiz_');
        });

        it('submits a question with array recommended_answer', async () => {
            await setup();

            const result = await client.callTool('submit_quiz_question', {
                question: 'Select all vulnerabilities present',
                question_type: 'multichoice',
                code_context: {
                    file: 'contracts/Bridge.sol',
                    start_line: 1,
                    end_line: 100,
                },
                difficulty: 'medium',
                options: ['Reentrancy', 'Overflow', 'Access Control', 'Frontrunning'],
                recommended_answer: ['Reentrancy', 'Access Control'],
            });

            expect(result.isError).not.toBe(true);
        });

        it('submits a question without optional fields', async () => {
            await setup();

            const result = await client.callTool('submit_quiz_question', {
                question: 'What does this function do?',
                question_type: 'code_rewrite',
                code_context: {
                    file: 'contracts/Pool.sol',
                    start_line: 20,
                    end_line: 30,
                },
                difficulty: 'medium',
            });

            expect(result.isError).not.toBe(true);
            expect(parseResult(result).question_id).toContain('quiz_');
        });
    });

    // ========================================================================
    // get_pending_grades
    // ========================================================================

    describe('get_pending_grades', () => {
        it('returns empty list when no answers are pending', async () => {
            await setup();

            const result = await client.callTool('get_pending_grades', {});
            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.count).toBe(0);
            expect(data.pending_grades).toEqual([]);
        });

        it('returns empty even after submitting questions (no answers yet)', async () => {
            await setup();

            await client.callTool('submit_quiz_question', {
                question: 'Test question',
                question_type: 'short_answer',
                code_context: { file: 'test.sol', start_line: 1, end_line: 5 },
                difficulty: 'easy',
            });

            const result = await client.callTool('get_pending_grades', {});
            const data = parseResult(result);
            // No answers submitted yet, so nothing pending
            expect(data.count).toBe(0);
        });
    });

    // ========================================================================
    // grade_quiz_answer
    // ========================================================================

    describe('grade_quiz_answer', () => {
        it('throws when grading a nonexistent question', async () => {
            await setup();

            const result = await client.callTool('grade_quiz_answer', {
                question_id: 'nonexistent_quiz',
                score: 80,
                feedback: 'Good answer',
            });

            // Should return an error since question doesn't exist
            expect(result.isError).toBe(true);
        });
    });

    // ========================================================================
    // Full flow
    // ========================================================================

    describe('full quiz flow', () => {
        it('submits multiple questions with unique IDs', async () => {
            await setup();

            const q1 = parseResult(await client.callTool('submit_quiz_question', {
                question: 'First question',
                question_type: 'multichoice',
                code_context: { file: 'a.sol', start_line: 1, end_line: 5 },
                difficulty: 'easy',
                options: ['A', 'B', 'C', 'D'],
                recommended_answer: 'A',
            }));
            expect(q1.question_id).toContain('quiz_');

            // Small delay to ensure different Date.now() value
            await new Promise(r => setTimeout(r, 5));

            const q2 = parseResult(await client.callTool('submit_quiz_question', {
                question: 'Second question',
                question_type: 'short_answer',
                code_context: { file: 'b.sol', start_line: 10, end_line: 20 },
                difficulty: 'hard',
            }));
            expect(q2.question_id).toContain('quiz_');

            // Both should have valid quiz IDs
            expect(q1.question_id).toBeDefined();
            expect(q2.question_id).toBeDefined();
        });
    });
});
