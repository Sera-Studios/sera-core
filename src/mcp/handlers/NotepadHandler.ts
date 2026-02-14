/**
 * @fileoverview Notepad MCP Handler (servlet) for sera-core
 * @module sera-core/mcp/handlers/NotepadHandler
 *
 * Handles note CRUD (POIs, issues, comments, questions) and protocol
 * documentation. Pure database operations - no VS Code dependencies.
 * The extension's NotepadApplet reacts to storage:update events to
 * refresh decorations and comment threads.
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
    TableSchema,
} from '@sera/types';

// ============================================================================
// TABLE SCHEMAS
// ============================================================================

const NOTES_SCHEMA: TableSchema = {
    name: 'notes',
    version: '6',
    fields: [
        { name: 'id', type: 'TEXT', primaryKey: true, required: true },
        { name: 'type', type: 'TEXT', required: true },
        { name: 'filePath', type: 'TEXT', required: true },
        { name: 'startLine', type: 'INTEGER', required: true },
        { name: 'endLine', type: 'INTEGER', required: true },
        { name: 'codeSnippet', type: 'TEXT', required: false },
        { name: 'createdAt', type: 'INTEGER', required: true },
        { name: 'updatedAt', type: 'INTEGER', required: true },
        // POI and Comment fields
        { name: 'text', type: 'TEXT', required: false },
        // Question fields
        { name: 'question', type: 'TEXT', required: false },
        { name: 'answer', type: 'TEXT', required: false },
        // Issue fields
        { name: 'title', type: 'TEXT', required: false },
        { name: 'severity', type: 'TEXT', required: false },
        { name: 'description', type: 'TEXT', required: false },
        { name: 'recommendation', type: 'TEXT', required: false },
        { name: 'clientResponse', type: 'TEXT', required: false },
        // Tracking
        { name: 'submittedBy', type: 'TEXT', required: false },
        { name: 'answeredBy', type: 'TEXT', required: false },
        { name: 'protocolDocRef', type: 'TEXT', required: false },
        // Resolution
        { name: 'resolved', type: 'INTEGER', required: false, defaultValue: 0 },
        { name: 'resolvedAt', type: 'INTEGER', required: false },
        // Validation
        { name: 'validated', type: 'INTEGER', required: false, defaultValue: 0 },
        { name: 'validatedAt', type: 'INTEGER', required: false },
        // Reply thread (JSON array)
        { name: 'replies', type: 'TEXT', required: false },
        // Already submitted by teammate
        { name: 'alreadySubmittedBy', type: 'TEXT', required: false },
    ],
    indexes: [
        { fields: ['filePath'] },
        { fields: ['type'] },
        { fields: ['filePath', 'startLine'] },
        { fields: ['resolved'] },
    ],
};

const PROTOCOL_DOCS_SCHEMA: TableSchema = {
    name: 'protocol_docs',
    fields: [
        { name: 'slug', type: 'TEXT', primaryKey: true, required: true },
        { name: 'title', type: 'TEXT', required: true },
        { name: 'content', type: 'TEXT', required: true },
        { name: 'tags', type: 'TEXT', required: false },
        { name: 'submittedBy', type: 'TEXT', required: false },
        { name: 'createdAt', type: 'INTEGER', required: true },
        { name: 'updatedAt', type: 'INTEGER', required: true },
    ],
    indexes: [
        { fields: ['submittedBy'] },
    ],
};

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOL_DEFINITIONS: McpToolDefinition[] = [
    {
        name: 'submit_poi',
        description: 'Submit a Point of Interest to the notepad. POIs are displayed inline in the editor.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Relative file path from workspace root' },
                start_line: { type: 'number', description: 'Starting line number (1-based)' },
                end_line: { type: 'number', description: 'Ending line number (1-based)' },
                text: { type: 'string', description: 'Brief description (1-2 sentences)' },
                protocol_doc_ref: { type: 'string', description: 'Optional slug of a protocol doc' },
            },
            required: ['file', 'start_line', 'end_line', 'text'],
        },
    },
    {
        name: 'submit_notepad_issue',
        description: 'Submit an issue to the notepad. Issues are displayed inline with severity-colored highlighting.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Relative file path from workspace root' },
                start_line: { type: 'number', description: 'Starting line number (1-based)' },
                end_line: { type: 'number', description: 'Ending line number (1-based)' },
                title: { type: 'string', description: 'Brief issue title' },
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational', 'gas'] },
                description: { type: 'string', description: 'Concise issue description' },
                recommendation: { type: 'string', description: 'Suggested fix' },
                protocol_doc_ref: { type: 'string', description: 'Optional slug of a protocol doc' },
            },
            required: ['file', 'start_line', 'end_line', 'title', 'severity', 'description', 'recommendation'],
        },
    },
    {
        name: 'submit_comment',
        description: 'Submit a comment to the notepad. Comments are displayed inline.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Relative file path from workspace root' },
                start_line: { type: 'number', description: 'Starting line number (1-based)' },
                end_line: { type: 'number', description: 'Ending line number (1-based)' },
                text: { type: 'string', description: 'Brief comment text' },
                protocol_doc_ref: { type: 'string', description: 'Optional slug of a protocol doc' },
            },
            required: ['file', 'start_line', 'end_line', 'text'],
        },
    },
    {
        name: 'submit_protocol_doc',
        description: 'Create protocol documentation for detailed analysis or architecture notes.',
        inputSchema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'URL-friendly identifier (e.g., "staking-flow")' },
                title: { type: 'string', description: 'Human-readable title' },
                content: { type: 'string', description: 'Full markdown content' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional categorization tags' },
            },
            required: ['slug', 'title', 'content'],
        },
    },
    {
        name: 'list_protocol_docs',
        description: 'List all protocol documentation files.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'get_protocol_doc',
        description: 'Get the full content of a protocol doc by slug.',
        inputSchema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'The slug of the protocol doc' },
            },
            required: ['slug'],
        },
    },
    {
        name: 'get_open_questions',
        description: 'Get all unanswered questions from the notepad.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'answer_question',
        description: 'Answer an open question in the notepad.',
        inputSchema: {
            type: 'object',
            properties: {
                question_id: { type: 'string', description: 'ID of the question' },
                answer: { type: 'string', description: 'Your answer' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['question_id', 'answer', 'confidence'],
        },
    },
    {
        name: 'reply_to_note',
        description: 'Reply to any note (POI, issue, comment, or question). Creates a threaded conversation.',
        inputSchema: {
            type: 'object',
            properties: {
                note_id: { type: 'string', description: 'ID of the note to reply to' },
                body: { type: 'string', description: 'The reply text' },
            },
            required: ['note_id', 'body'],
        },
    },
    {
        name: 'clear_hunter_data',
        description: 'Clear all POIs, issues, and comments submitted by the hunter agent.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class NotepadHandler implements PortableMcpHandler {
    getToolDefinitions(): McpToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    getRequiredTableSchemas() {
        return [{ appletId: 'notepad', schemas: [NOTES_SCHEMA, PROTOCOL_DOCS_SCHEMA] }];
    }

    async handleToolCall(toolName: string, args: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> {
        switch (toolName) {
            case 'submit_poi':
                return this.handleSubmitNote('poi', args, ctx);
            case 'submit_notepad_issue':
                return this.handleSubmitIssue(args, ctx);
            case 'submit_comment':
                return this.handleSubmitNote('comment', args, ctx);
            case 'submit_protocol_doc':
                return this.handleSubmitProtocolDoc(args, ctx);
            case 'list_protocol_docs':
                return this.handleListProtocolDocs(ctx);
            case 'get_protocol_doc':
                return this.handleGetProtocolDoc(args, ctx);
            case 'get_open_questions':
                return this.handleGetOpenQuestions(ctx);
            case 'answer_question':
                return this.handleAnswerQuestion(args, ctx);
            case 'reply_to_note':
                return this.handleReplyToNote(args, ctx);
            case 'clear_hunter_data':
                return this.handleClearHunterData(ctx);
            default:
                throw new Error(`Unknown notepad tool: ${toolName}`);
        }
    }

    // ========================================================================
    // NOTE CRUD
    // ========================================================================

    private async handleSubmitNote(
        type: 'poi' | 'comment',
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ note_id: string; displayed_in_editor: boolean }> {
        const now = Date.now();
        const id = `${type}-${now}-${Math.random().toString(36).slice(2, 8)}`;
        const submitter = this.resolveSubmitter(ctx.agentType);

        await ctx.db.write('notepad', 'notes', {
            id,
            type,
            filePath: args.file as string,
            startLine: args.start_line as number,
            endLine: args.end_line as number,
            text: args.text as string,
            protocolDocRef: (args.protocol_doc_ref as string) || null,
            submittedBy: submitter,
            createdAt: now,
            updatedAt: now,
            resolved: 0,
            validated: 0,
        });

        console.log(`[NotepadHandler] ${type} submitted: ${id}`);
        return { note_id: id, displayed_in_editor: true };
    }

    private async handleSubmitIssue(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ issue_id: string; displayed_in_editor: boolean }> {
        const now = Date.now();
        const id = `issue-${now}-${Math.random().toString(36).slice(2, 8)}`;
        const submitter = this.resolveSubmitter(ctx.agentType);

        await ctx.db.write('notepad', 'notes', {
            id,
            type: 'issue',
            filePath: args.file as string,
            startLine: args.start_line as number,
            endLine: args.end_line as number,
            title: args.title as string,
            severity: args.severity as string,
            description: args.description as string,
            recommendation: args.recommendation as string,
            protocolDocRef: (args.protocol_doc_ref as string) || null,
            submittedBy: submitter,
            createdAt: now,
            updatedAt: now,
            resolved: 0,
            validated: 0,
        });

        // Emit bridge event for critical/high issues so VS Code can show a notification
        const severity = args.severity as string;
        if (severity === 'critical' || severity === 'high') {
            ctx.bridge.emit('notepad:issue-submitted', {
                id,
                title: args.title as string,
                severity,
                file: args.file as string,
            });
        }

        console.log(`[NotepadHandler] issue submitted: ${id} (${severity})`);
        return { issue_id: id, displayed_in_editor: true };
    }

    // ========================================================================
    // PROTOCOL DOCS
    // ========================================================================

    private async handleSubmitProtocolDoc(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ slug: string; created: boolean; message: string }> {
        const slug = args.slug as string;
        const now = Date.now();
        const submitter = this.resolveSubmitter(ctx.agentType);

        await ctx.db.write('notepad', 'protocol_docs', {
            slug,
            title: args.title as string,
            content: args.content as string,
            tags: args.tags ? JSON.stringify(args.tags) : null,
            submittedBy: submitter,
            createdAt: now,
            updatedAt: now,
        });

        console.log(`[NotepadHandler] Protocol doc created: ${slug}`);
        return {
            slug,
            created: true,
            message: `Protocol doc created: ${args.title}. Reference it with protocol_doc_ref: "${slug}"`,
        };
    }

    private async handleListProtocolDocs(
        ctx: HandlerContext
    ): Promise<{ count: number; docs: unknown[] }> {
        const docs = await ctx.db.sql(
            `SELECT slug, title, tags, submittedBy, createdAt FROM notepad_protocol_docs ORDER BY createdAt DESC`,
            []
        );

        return {
            count: docs.length,
            docs: docs.map((d: any) => ({
                slug: d.slug,
                title: d.title,
                tags: d.tags ? JSON.parse(d.tags) : [],
                submitted_by: d.submittedBy,
                created_at: d.createdAt,
            })),
        };
    }

    private async handleGetProtocolDoc(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<unknown> {
        const slug = args.slug as string;
        const docs = await ctx.db.sql(
            `SELECT * FROM notepad_protocol_docs WHERE slug = ?`,
            [slug]
        );

        if (docs.length === 0) {
            throw new Error(`Protocol doc not found: ${slug}`);
        }

        const doc = docs[0];
        return {
            slug: doc.slug,
            title: doc.title,
            content: doc.content,
            tags: doc.tags ? JSON.parse(doc.tags) : [],
            submitted_by: doc.submittedBy,
            created_at: doc.createdAt,
        };
    }

    // ========================================================================
    // QUESTIONS & REPLIES
    // ========================================================================

    private async handleGetOpenQuestions(
        ctx: HandlerContext
    ): Promise<{ count: number; questions: unknown[] }> {
        const questions = await ctx.db.sql(
            `SELECT * FROM notepad_notes WHERE type = 'question' AND (answer IS NULL OR answer = '') ORDER BY createdAt DESC`,
            []
        );

        return {
            count: questions.length,
            questions: questions.map((q: any) => ({
                id: q.id,
                file: q.filePath,
                start_line: q.startLine,
                end_line: q.endLine,
                question: q.question,
                code_snippet: q.codeSnippet,
                created_at: q.createdAt,
            })),
        };
    }

    private async handleAnswerQuestion(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ success: boolean; question_id: string }> {
        const questionId = args.question_id as string;

        const questions = await ctx.db.sql(
            `SELECT * FROM notepad_notes WHERE id = ? AND type = 'question'`,
            [questionId]
        );

        if (questions.length === 0) {
            throw new Error(`Question not found: ${questionId}`);
        }

        const question = questions[0];
        const submitter = this.resolveSubmitter(ctx.agentType);

        await ctx.db.write('notepad', 'notes', {
            ...question,
            answer: args.answer as string,
            answeredBy: submitter,
            updatedAt: Date.now(),
        });

        console.log(`[NotepadHandler] Question answered: ${questionId}`);
        return { success: true, question_id: questionId };
    }

    private async handleReplyToNote(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ success: boolean; note_id: string; reply_id: string }> {
        const noteId = args.note_id as string;

        const notes = await ctx.db.sql(
            `SELECT * FROM notepad_notes WHERE id = ?`,
            [noteId]
        );

        if (notes.length === 0) {
            throw new Error(`Note not found: ${noteId}`);
        }

        const note = notes[0];
        const submitter = this.resolveSubmitter(ctx.agentType);
        const replyId = `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Parse existing replies or start fresh
        let replies: any[] = [];
        if (note.replies) {
            try { replies = JSON.parse(note.replies); } catch { /* start fresh */ }
        }

        replies.push({
            id: replyId,
            author: submitter,
            body: args.body as string,
            createdAt: Date.now(),
        });

        await ctx.db.write('notepad', 'notes', {
            ...note,
            replies: JSON.stringify(replies),
            updatedAt: Date.now(),
        });

        console.log(`[NotepadHandler] Reply added to ${noteId}: ${replyId}`);
        return { success: true, note_id: noteId, reply_id: replyId };
    }

    // ========================================================================
    // CLEAR DATA
    // ========================================================================

    private async handleClearHunterData(
        ctx: HandlerContext
    ): Promise<{ cleared_notes: number; cleared_docs: number }> {
        const submitter = this.resolveSubmitter(ctx.agentType);

        // Count before deleting
        const notesBefore = await ctx.db.sql(
            `SELECT COUNT(*) as count FROM notepad_notes WHERE submittedBy = ?`,
            [submitter]
        );
        const docsBefore = await ctx.db.sql(
            `SELECT COUNT(*) as count FROM notepad_protocol_docs WHERE submittedBy = ?`,
            [submitter]
        );

        const noteCount = notesBefore[0]?.count || 0;
        const docCount = docsBefore[0]?.count || 0;

        if (noteCount > 0) {
            await ctx.db.delete('notepad', 'notes', { submittedBy: submitter });
        }
        if (docCount > 0) {
            await ctx.db.delete('notepad', 'protocol_docs', { submittedBy: submitter });
        }

        console.log(`[NotepadHandler] Cleared ${noteCount} notes, ${docCount} docs for ${submitter}`);
        return { cleared_notes: noteCount, cleared_docs: docCount };
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    private resolveSubmitter(agentType: string): string {
        switch (agentType) {
            case 'hunter': return 'claude-hunter';
            case 'gatherer': return 'claude-gatherer';
            case 'alchemist': return 'claude-alchemist';
            case 'visualizer': return 'claude-visualizer';
            default: return `claude-${agentType}`;
        }
    }
}
