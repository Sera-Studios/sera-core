/**
 * @fileoverview Quiz MCP Handler for sera-core (Gatherer role)
 * @module sera-core/mcp/handlers/QuizHandler
 *
 * Handles quiz question submission, grade retrieval, and grading.
 * Writes to sessionbridge_quiz_questions table via HandlerContext.db.
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
    TableSchema,
} from '@sera/types';
import { createLogger } from '../../logging/Logger';

const log = createLogger('quiz-handler');

const QUIZ_SCHEMA: TableSchema = {
    name: 'quiz_questions',
    version: '2',
    fields: [
        { name: 'id', type: 'INTEGER', primaryKey: true, required: true },
        { name: 'questionId', type: 'TEXT', required: true },
        { name: 'sessionId', type: 'TEXT', required: true },
        { name: 'question', type: 'TEXT', required: true },
        { name: 'questionType', type: 'TEXT', required: true },
        { name: 'recommendedAnswer', type: 'TEXT', required: false },
        { name: 'codeContext', type: 'TEXT', required: true },
        { name: 'difficulty', type: 'TEXT', required: true },
        { name: 'options', type: 'TEXT', required: false },
        { name: 'contractPath', type: 'TEXT', required: false },
        { name: 'createdAt', type: 'TEXT', required: true },
        { name: 'answeredAt', type: 'TEXT', required: false },
        { name: 'userAnswer', type: 'TEXT', required: false },
        { name: 'score', type: 'REAL', required: false },
        { name: 'gradedAt', type: 'TEXT', required: false },
        { name: 'gradedBy', type: 'TEXT', required: false },
        { name: 'gradeFeedback', type: 'TEXT', required: false },
    ],
    indexes: [
        { fields: ['questionId'], unique: true },
        { fields: ['sessionId'] },
        { fields: ['questionType'] },
        { fields: ['contractPath'] },
    ],
};

const TOOL_DEFINITIONS: McpToolDefinition[] = [
    {
        name: 'submit_quiz_question',
        description: 'Submit a quiz question to help auditors test their understanding of the protocol.',
        inputSchema: {
            type: 'object',
            properties: {
                question: { type: 'string' },
                question_type: { type: 'string', enum: ['multichoice', 'short_answer', 'code_rewrite', 'code_scramble'] },
                recommended_answer: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                code_context: {
                    type: 'object',
                    properties: { file: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } },
                    required: ['file', 'start_line', 'end_line'],
                },
                difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
                options: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
            },
            required: ['question', 'question_type', 'code_context', 'difficulty'],
        },
    },
    {
        name: 'get_pending_grades',
        description: 'Get quiz answers that need grading.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'grade_quiz_answer',
        description: 'Grade a quiz answer submitted by the auditor.',
        inputSchema: {
            type: 'object',
            properties: {
                question_id: { type: 'string' },
                score: { type: 'number', minimum: 0, maximum: 100 },
                feedback: { type: 'string' },
            },
            required: ['question_id', 'score', 'feedback'],
        },
    },
];

export class QuizHandler implements PortableMcpHandler {
    getToolDefinitions(): McpToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    getRequiredTableSchemas() {
        return [{ appletId: 'sessionbridge', schemas: [QUIZ_SCHEMA] }];
    }

    async handleToolCall(toolName: string, args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> {
        switch (toolName) {
            case 'submit_quiz_question':
                return this.handleSubmitQuestion(args, ctx);
            case 'get_pending_grades':
                return this.handleGetPendingGrades(ctx);
            case 'grade_quiz_answer':
                return this.handleGradeAnswer(args, ctx);
            default:
                throw new Error(`Unknown quiz tool: ${toolName}`);
        }
    }

    private async handleSubmitQuestion(args: Record<string, unknown>, ctx: HandlerContext): Promise<{ question_id: string }> {
        const id = Date.now();
        const questionId = `quiz_${id}`;

        // Extract contractPath from codeContext
        let contractPath: string | null = null;
        const codeContext = args.code_context as Record<string, unknown>;
        if (codeContext?.file) {
            contractPath = codeContext.file as string;
        }

        const recommendedAnswer = args.recommended_answer
            ? (typeof args.recommended_answer === 'string'
                ? args.recommended_answer
                : JSON.stringify(args.recommended_answer))
            : null;

        const options = args.options
            ? (typeof args.options === 'string'
                ? args.options
                : JSON.stringify(args.options))
            : null;

        await ctx.db.write('sessionbridge', 'quiz_questions', {
            id,
            questionId,
            sessionId: ctx.sessionId,
            question: args.question as string,
            questionType: args.question_type as string,
            recommendedAnswer,
            codeContext: JSON.stringify(codeContext),
            difficulty: (args.difficulty as string) || 'medium',
            options,
            contractPath,
            createdAt: new Date().toISOString(),
        });

        log.info('Question submitted', { questionId });
        return { question_id: questionId };
    }

    private async handleGetPendingGrades(ctx: HandlerContext): Promise<{ pending_grades: unknown[]; count: number }> {
        const pending = await ctx.db.sql(
            `SELECT * FROM sessionbridge_quiz_questions WHERE answeredAt IS NOT NULL AND gradedAt IS NULL ORDER BY answeredAt ASC`,
            []
        );

        return {
            pending_grades: pending.map((q: any) => ({
                question_id: q.questionId,
                question: q.question,
                question_type: q.questionType,
                recommended_answer: q.recommendedAnswer,
                user_answer: q.userAnswer,
                code_context: q.codeContext,
                difficulty: q.difficulty,
                answered_at: q.answeredAt,
            })),
            count: pending.length,
        };
    }

    private async handleGradeAnswer(args: Record<string, unknown>, ctx: HandlerContext): Promise<{ success: boolean; question_id: string; score: number }> {
        const questionId = args.question_id as string;
        const score = args.score as number;
        const feedback = args.feedback as string;

        const questions = await ctx.db.sql(
            `SELECT * FROM sessionbridge_quiz_questions WHERE questionId = ?`, [questionId]
        );

        if (questions.length === 0) {
            throw new Error(`Question not found: ${questionId}`);
        }

        await ctx.db.write('sessionbridge', 'quiz_questions', {
            ...questions[0],
            score,
            gradeFeedback: feedback,
            gradedBy: ctx.sessionId,
            gradedAt: new Date().toISOString(),
        });

        log.info('Graded question', { questionId, score });
        return { success: true, question_id: questionId, score };
    }
}
