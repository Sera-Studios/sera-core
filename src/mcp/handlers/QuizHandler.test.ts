/**
 * @fileoverview Unit tests for QuizHandler
 *
 * Tests submit_quiz_question, get_pending_grades, grade_quiz_answer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QuizHandler } from './QuizHandler';
import { HandlerContext } from '@sera/types';

interface MockRow {
    [key: string]: unknown;
}

function buildMockContext(): {
    ctx: HandlerContext;
    tables: Record<string, MockRow[]>;
} {
    const tables: Record<string, MockRow[]> = {
        sessionbridge_quiz_questions: [],
    };

    const ctx: HandlerContext = {
        auditSlug: 'test-audit',
        sessionId: 'test-session-1',
        agentType: 'gatherer',
        workspacePath: '/tmp',
        db: {
            write: async (_appletId: string, tableName: string, row: Record<string, unknown>) => {
                const fullTable = `sessionbridge_${tableName}`;
                if (!tables[fullTable]) tables[fullTable] = [];
                const existing = tables[fullTable].findIndex(r => r.questionId === row.questionId);
                if (existing >= 0) {
                    tables[fullTable][existing] = row;
                } else {
                    tables[fullTable].push(row);
                }
            },
            query: async () => [],
            sql: async (query: string, params: unknown[]) => {
                if (query.includes('quiz_questions') && query.includes('answeredAt IS NOT NULL AND gradedAt IS NULL')) {
                    return tables.sessionbridge_quiz_questions.filter(
                        r => r.answeredAt != null && r.gradedAt == null
                    );
                }
                if (query.includes('quiz_questions') && query.includes('questionId = ?')) {
                    return tables.sessionbridge_quiz_questions.filter(
                        r => r.questionId === params[0]
                    );
                }
                return [];
            },
            delete: async () => 0,
        },
        bridge: {
            emit: () => {},
            broadcastStorageUpdate: () => {},
        },
    };

    return { ctx, tables };
}

describe('QuizHandler', () => {
    let handler: QuizHandler;

    beforeEach(() => {
        handler = new QuizHandler();
    });

    describe('getToolDefinitions', () => {
        it('returns 3 tool definitions', () => {
            const tools = handler.getToolDefinitions();
            expect(tools).toHaveLength(3);
            const names = tools.map(t => t.name);
            expect(names).toContain('submit_quiz_question');
            expect(names).toContain('get_pending_grades');
            expect(names).toContain('grade_quiz_answer');
        });
    });

    describe('getRequiredTableSchemas', () => {
        it('returns quiz_questions schema under sessionbridge', () => {
            const schemas = handler.getRequiredTableSchemas();
            expect(schemas).toHaveLength(1);
            expect(schemas[0].appletId).toBe('sessionbridge');
            expect(schemas[0].schemas[0].name).toBe('quiz_questions');
        });
    });

    describe('submit_quiz_question', () => {
        it('creates a quiz question and returns question_id', async () => {
            const { ctx, tables } = buildMockContext();

            const result = await handler.handleToolCall('submit_quiz_question', {
                question: 'What is reentrancy?',
                question_type: 'short_answer',
                code_context: { file: 'Vault.sol', start_line: 10, end_line: 20 },
                difficulty: 'medium',
            }, ctx) as { question_id: string };

            expect(result.question_id).toMatch(/^quiz_\d+$/);
            expect(tables.sessionbridge_quiz_questions).toHaveLength(1);

            const row = tables.sessionbridge_quiz_questions[0];
            expect(row.question).toBe('What is reentrancy?');
            expect(row.questionType).toBe('short_answer');
            expect(row.difficulty).toBe('medium');
            expect(row.contractPath).toBe('Vault.sol');
            expect(row.sessionId).toBe('test-session-1');
        });

        it('handles recommended_answer as string', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('submit_quiz_question', {
                question: 'What modifier prevents reentrancy?',
                question_type: 'short_answer',
                recommended_answer: 'nonReentrant',
                code_context: { file: 'Lock.sol', start_line: 1, end_line: 5 },
                difficulty: 'easy',
            }, ctx);

            expect(tables.sessionbridge_quiz_questions[0].recommendedAnswer).toBe('nonReentrant');
        });

        it('handles recommended_answer as array (JSON stringified)', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('submit_quiz_question', {
                question: 'Which are valid?',
                question_type: 'multichoice',
                recommended_answer: ['A', 'B'],
                code_context: { file: 'Test.sol', start_line: 1, end_line: 5 },
                difficulty: 'medium',
            }, ctx);

            expect(tables.sessionbridge_quiz_questions[0].recommendedAnswer).toBe('["A","B"]');
        });

        it('handles options as array (JSON stringified)', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('submit_quiz_question', {
                question: 'Pick the right one',
                question_type: 'multichoice',
                options: ['A', 'B', 'C', 'D'],
                code_context: { file: 'Test.sol', start_line: 1, end_line: 5 },
                difficulty: 'hard',
            }, ctx);

            expect(tables.sessionbridge_quiz_questions[0].options).toBe('["A","B","C","D"]');
        });

        it('sets null for missing recommended_answer and options', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('submit_quiz_question', {
                question: 'Explain this code',
                question_type: 'short_answer',
                code_context: { file: 'X.sol', start_line: 1, end_line: 2 },
                difficulty: 'easy',
            }, ctx);

            expect(tables.sessionbridge_quiz_questions[0].recommendedAnswer).toBeNull();
            expect(tables.sessionbridge_quiz_questions[0].options).toBeNull();
        });

        it('extracts contractPath from code_context.file', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('submit_quiz_question', {
                question: 'What does this do?',
                question_type: 'code_rewrite',
                code_context: { file: 'contracts/Token.sol', start_line: 50, end_line: 60 },
                difficulty: 'hard',
            }, ctx);

            expect(tables.sessionbridge_quiz_questions[0].contractPath).toBe('contracts/Token.sol');
        });

        it('sets null contractPath when code_context has no file', async () => {
            const { ctx, tables } = buildMockContext();

            await handler.handleToolCall('submit_quiz_question', {
                question: 'General question',
                question_type: 'short_answer',
                code_context: { start_line: 1, end_line: 5 },
                difficulty: 'easy',
            }, ctx);

            expect(tables.sessionbridge_quiz_questions[0].contractPath).toBeNull();
        });
    });

    describe('get_pending_grades', () => {
        it('returns questions that have been answered but not graded', async () => {
            const { ctx, tables } = buildMockContext();

            // Insert an answered-but-ungraded question
            tables.sessionbridge_quiz_questions.push({
                questionId: 'quiz_100',
                question: 'What is reentrancy?',
                questionType: 'short_answer',
                recommendedAnswer: 'CEI pattern violation',
                userAnswer: 'When a contract calls back',
                codeContext: '{"file":"V.sol","start_line":1,"end_line":5}',
                difficulty: 'medium',
                answeredAt: '2025-01-01T00:00:00Z',
                gradedAt: null,
            });

            const result = await handler.handleToolCall('get_pending_grades', {}, ctx) as {
                pending_grades: unknown[];
                count: number;
            };

            expect(result.count).toBe(1);
            expect(result.pending_grades).toHaveLength(1);

            const grade = result.pending_grades[0] as Record<string, unknown>;
            expect(grade.question_id).toBe('quiz_100');
            expect(grade.user_answer).toBe('When a contract calls back');
            expect(grade.recommended_answer).toBe('CEI pattern violation');
        });

        it('returns empty array when no pending grades', async () => {
            const { ctx } = buildMockContext();

            const result = await handler.handleToolCall('get_pending_grades', {}, ctx) as {
                pending_grades: unknown[];
                count: number;
            };

            expect(result.count).toBe(0);
            expect(result.pending_grades).toEqual([]);
        });
    });

    describe('grade_quiz_answer', () => {
        it('grades an existing question', async () => {
            const { ctx, tables } = buildMockContext();

            // Insert a question to grade
            tables.sessionbridge_quiz_questions.push({
                questionId: 'quiz_200',
                question: 'What is reentrancy?',
                questionType: 'short_answer',
                userAnswer: 'CEI pattern violation',
                answeredAt: '2025-01-01T00:00:00Z',
                gradedAt: null,
            });

            const result = await handler.handleToolCall('grade_quiz_answer', {
                question_id: 'quiz_200',
                score: 85,
                feedback: 'Good answer but could be more specific',
            }, ctx) as { success: boolean; question_id: string; score: number };

            expect(result.success).toBe(true);
            expect(result.question_id).toBe('quiz_200');
            expect(result.score).toBe(85);

            // Verify the row was updated
            const row = tables.sessionbridge_quiz_questions[0];
            expect(row.score).toBe(85);
            expect(row.gradeFeedback).toBe('Good answer but could be more specific');
            expect(row.gradedBy).toBe('test-session-1');
            expect(row.gradedAt).toBeDefined();
        });

        it('throws for nonexistent question', async () => {
            const { ctx } = buildMockContext();

            await expect(
                handler.handleToolCall('grade_quiz_answer', {
                    question_id: 'nonexistent',
                    score: 50,
                    feedback: 'N/A',
                }, ctx)
            ).rejects.toThrow('Question not found: nonexistent');
        });
    });

    describe('unknown tool', () => {
        it('throws for unknown tool name', async () => {
            const { ctx } = buildMockContext();

            await expect(
                handler.handleToolCall('invalid_tool', {}, ctx)
            ).rejects.toThrow('Unknown quiz tool: invalid_tool');
        });
    });
});
