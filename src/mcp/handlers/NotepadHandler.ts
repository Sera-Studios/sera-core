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
import { createLogger } from '../../logging/Logger';

const log = createLogger('notepad-handler');

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
        name: 'submit_finding',
        description: 'Submit a security finding. This is your initial report - use finalise_finding once you have confirmed the vulnerability.',
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
                already_submitted_by: { type: 'string', description: 'Optional auditor handle who originally submitted this finding (e.g. from an external platform)' },
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
                already_submitted_by: { type: 'string', description: 'Optional auditor handle who originally submitted this comment (e.g. from an external platform)' },
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
                author: { type: 'string', description: 'Optional author name override (e.g. for syncing external platform comments)' },
            },
            required: ['note_id', 'body'],
        },
    },
    {
        name: 'clear_hunter_data',
        description: 'Clear all POIs, issues, and comments submitted by the hunter agent.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'finalise_finding',
        description: 'Finalise a previously submitted finding, confirming it as a validated vulnerability. Call this after you have verified the finding with evidence from the codebase.',
        inputSchema: {
            type: 'object',
            properties: {
                finding_id: {
                    type: 'string',
                    description: 'The finding ID returned by submit_finding',
                },
            },
            required: ['finding_id'],
        },
    },
    {
        name: 'list_findings',
        description: 'List all submitted findings for the current audit. Returns finding ID, title, severity, file, validation status, and timestamps.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                status: {
                    type: 'string',
                    enum: ['all', 'validated', 'unvalidated'],
                    description: 'Filter by validation status. Default: all',
                },
            },
        },
    },
    {
        name: 'list_comments',
        description: 'List all comments in the notepad. Optionally filter by file path or submitter.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Filter by file path (exact match)' },
                submitter: { type: 'string', description: 'Filter by submittedBy value (e.g. "claude-hunter", "cantina-sync")' },
            },
        },
    },
    {
        name: 'get_note',
        description: 'Get a single note by ID with its full reply thread. Works for any note type (POI, issue, comment, question).',
        inputSchema: {
            type: 'object',
            properties: {
                note_id: { type: 'string', description: 'ID of the note to retrieve' },
            },
            required: ['note_id'],
        },
    },
    {
        name: 'list_notes',
        description: 'List notes across all types (POI, issue, comment, question). Optionally filter by file path, note type, or submitter.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Filter by file path (exact match)' },
                type: { type: 'string', enum: ['poi', 'issue', 'comment', 'question'], description: 'Filter by note type' },
                submitter: { type: 'string', description: 'Filter by submittedBy value' },
            },
        },
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
            case 'submit_finding':
                return this.handleSubmitFinding(args, ctx);
            case 'finalise_finding':
                return this.handleFinaliseFinding(args, ctx);
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
            case 'list_findings':
                return this.handleListFindings(args, ctx);
            case 'list_comments':
                return this.handleListComments(args, ctx);
            case 'get_note':
                return this.handleGetNote(args, ctx);
            case 'list_notes':
                return this.handleListNotes(args, ctx);
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
            alreadySubmittedBy: (args.already_submitted_by as string) || null,
            submittedBy: submitter,
            createdAt: now,
            updatedAt: now,
            resolved: 0,
            validated: 0,
        });

        log.info('Note submitted', { type, id });
        return { note_id: id, displayed_in_editor: true };
    }

    private async handleSubmitFinding(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ finding_id: string; displayed_in_editor: boolean }> {
        const now = Date.now();
        const id = `issue-${now}-${Math.random().toString(36).slice(2, 8)}`;
        const submitter = this.resolveSubmitter(ctx.agentType);
        const severity = args.severity as string;

        await ctx.db.write('notepad', 'notes', {
            id,
            type: 'issue',
            filePath: args.file as string,
            startLine: args.start_line as number,
            endLine: args.end_line as number,
            title: args.title as string,
            severity,
            description: args.description as string,
            recommendation: args.recommendation as string,
            protocolDocRef: (args.protocol_doc_ref as string) || null,
            alreadySubmittedBy: (args.already_submitted_by as string) || null,
            submittedBy: submitter,
            createdAt: now,
            updatedAt: now,
            resolved: 0,
            validated: 0,
        });

        // Emit bridge event for all findings so external services can track submissions
        ctx.bridge.emit('finding:submitted', {
            id,
            title: args.title as string,
            severity,
            file: args.file as string,
            submittedBy: submitter,
        });

        log.info('Finding submitted', { id, severity });
        return { finding_id: id, displayed_in_editor: true };
    }

    private async handleFinaliseFinding(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ finding_id: string; finalised: boolean }> {
        const findingId = args.finding_id as string;

        const rows = await ctx.db.sql(
            `SELECT * FROM notepad_notes WHERE id = ? AND type = 'issue'`,
            [findingId]
        );

        if (rows.length === 0) {
            throw new Error(`Finding not found: ${findingId}`);
        }

        const finding = rows[0] as Record<string, any>;

        if (finding.validated === 1) {
            throw new Error(`Finding already finalised: ${findingId}`);
        }

        const now = Date.now();
        await ctx.db.write('notepad', 'notes', {
            ...finding,
            validated: 1,
            validatedAt: now,
            updatedAt: now,
        });

        ctx.bridge.emit('finding:finalised', {
            id: findingId,
            title: finding.title,
            severity: finding.severity,
            file: finding.filePath,
            description: finding.description,
            recommendation: finding.recommendation,
            submittedBy: finding.submittedBy,
        });

        log.info('Finding finalised', { findingId });
        return { finding_id: findingId, finalised: true };
    }

    private async handleListFindings(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ count: number; findings: unknown[] }> {
        const status = (args.status as string) || 'all';
        let query = `SELECT id, title, severity, filePath, startLine, endLine,
                            description, recommendation, submittedBy,
                            validated, validatedAt, createdAt
                     FROM notepad_notes WHERE type = 'issue'`;

        if (status === 'validated') query += ` AND validated = 1`;
        else if (status === 'unvalidated') query += ` AND validated = 0`;

        query += ` ORDER BY createdAt DESC`;

        const rows = await ctx.db.sql(query, []);
        return { count: rows.length, findings: rows };
    }

    // ========================================================================
    // COMMENTS & NOTES QUERIES
    // ========================================================================

    private async handleListComments(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ count: number; comments: unknown[] }> {
        let query = `SELECT id, filePath, startLine, endLine, text, submittedBy,
                            alreadySubmittedBy, replies, createdAt
                     FROM notepad_notes WHERE type = 'comment'`;
        const params: unknown[] = [];

        if (args.file) {
            query += ` AND filePath = ?`;
            params.push(args.file as string);
        }
        if (args.submitter) {
            query += ` AND submittedBy = ?`;
            params.push(args.submitter as string);
        }

        query += ` ORDER BY createdAt DESC`;

        const rows = await ctx.db.sql(query, params);
        return {
            count: rows.length,
            comments: rows.map((r: any) => ({
                id: r.id,
                file: r.filePath,
                start_line: r.startLine,
                end_line: r.endLine,
                text: r.text,
                submitted_by: r.submittedBy,
                already_submitted_by: r.alreadySubmittedBy,
                replies: r.replies ? JSON.parse(r.replies) : [],
                created_at: r.createdAt,
            })),
        };
    }

    private async handleGetNote(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<unknown> {
        const noteId = args.note_id as string;

        const rows = await ctx.db.sql(
            `SELECT * FROM notepad_notes WHERE id = ?`,
            [noteId]
        );

        if (rows.length === 0) {
            throw new Error(`Note not found: ${noteId}`);
        }

        const row = rows[0] as any;
        const note: Record<string, unknown> = {
            id: row.id,
            type: row.type,
            file: row.filePath,
            start_line: row.startLine,
            end_line: row.endLine,
            submitted_by: row.submittedBy,
            already_submitted_by: row.alreadySubmittedBy || null,
            resolved: row.resolved === 1,
            validated: row.validated === 1,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            replies: row.replies ? JSON.parse(row.replies) : [],
        };

        // Include type-specific fields
        if (row.type === 'poi' || row.type === 'comment') {
            note.text = row.text;
        }
        if (row.type === 'issue') {
            note.title = row.title;
            note.severity = row.severity;
            note.description = row.description;
            note.recommendation = row.recommendation;
            note.client_response = row.clientResponse || null;
        }
        if (row.type === 'question') {
            note.question = row.question;
            note.answer = row.answer || null;
            note.answered_by = row.answeredBy || null;
        }
        if (row.protocolDocRef) {
            note.protocol_doc_ref = row.protocolDocRef;
        }

        return note;
    }

    private async handleListNotes(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<{ count: number; notes: unknown[] }> {
        let query = `SELECT id, type, filePath, startLine, endLine, text, title, severity,
                            question, answer, submittedBy, alreadySubmittedBy,
                            resolved, validated, replies, createdAt
                     FROM notepad_notes WHERE 1=1`;
        const params: unknown[] = [];

        if (args.type) {
            query += ` AND type = ?`;
            params.push(args.type as string);
        }
        if (args.file) {
            query += ` AND filePath = ?`;
            params.push(args.file as string);
        }
        if (args.submitter) {
            query += ` AND submittedBy = ?`;
            params.push(args.submitter as string);
        }

        query += ` ORDER BY createdAt DESC`;

        const rows = await ctx.db.sql(query, params);
        return {
            count: rows.length,
            notes: rows.map((r: any) => {
                const note: Record<string, unknown> = {
                    id: r.id,
                    type: r.type,
                    file: r.filePath,
                    start_line: r.startLine,
                    end_line: r.endLine,
                    submitted_by: r.submittedBy,
                    already_submitted_by: r.alreadySubmittedBy || null,
                    resolved: r.resolved === 1,
                    validated: r.validated === 1,
                    reply_count: r.replies ? JSON.parse(r.replies).length : 0,
                    created_at: r.createdAt,
                };

                // Include summary fields per type
                if (r.type === 'poi' || r.type === 'comment') {
                    note.text = r.text;
                }
                if (r.type === 'issue') {
                    note.title = r.title;
                    note.severity = r.severity;
                }
                if (r.type === 'question') {
                    note.question = r.question;
                    note.has_answer = !!(r.answer && r.answer.trim());
                }

                return note;
            }),
        };
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

        log.info('Protocol doc created', { slug });
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

        log.info('Question answered', { questionId });
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
        const author = (args.author as string) || this.resolveSubmitter(ctx.agentType);
        const replyId = `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Parse existing replies or start fresh
        let replies: any[] = [];
        if (note.replies) {
            try { replies = JSON.parse(note.replies); } catch { /* start fresh */ }
        }

        replies.push({
            id: replyId,
            author,
            body: args.body as string,
            createdAt: Date.now(),
        });

        await ctx.db.write('notepad', 'notes', {
            ...note,
            replies: JSON.stringify(replies),
            updatedAt: Date.now(),
        });

        log.info('Reply added', { noteId, replyId });
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

        log.info('Cleared hunter data', { noteCount, docCount, submitter });
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
