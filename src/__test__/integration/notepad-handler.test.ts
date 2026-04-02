/**
 * @fileoverview Integration tests for the NotepadHandler MCP tools
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

describe('NotepadHandler', () => {
    let testnet: TestnetInstance;
    let client: McpTestClient;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'notepad-test' });
        client = new McpTestClient(`${testnet.mcpUrl}/notepad-test`);
        await client.initialize();
    }

    function parseResult(result: any): any {
        const text = result.content[0].text;
        try { return JSON.parse(text); }
        catch { return text; }
    }

    // ========================================================================
    // submit_poi
    // ========================================================================

    describe('submit_poi', () => {
        it('submits a POI and returns note_id', async () => {
            await setup();

            const result = await client.callTool('submit_poi', {
                file: 'contracts/Vault.sol',
                start_line: 42,
                end_line: 42,
                text: 'External call before state update',
            });

            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.note_id).toBeDefined();
            expect(data.note_id).toContain('poi-');
            expect(data.displayed_in_editor).toBe(true);
        });

        it('submits a POI with protocol doc reference', async () => {
            await setup();

            const result = await client.callTool('submit_poi', {
                file: 'contracts/Pool.sol',
                start_line: 10,
                end_line: 20,
                text: 'Important state variable',
                protocol_doc_ref: 'staking-flow',
            });

            expect(result.isError).not.toBe(true);
            expect(parseResult(result).note_id).toContain('poi-');
        });
    });

    // ========================================================================
    // submit_finding
    // ========================================================================

    describe('submit_finding', () => {
        it('submits a critical finding', async () => {
            await setup();

            const result = await client.callTool('submit_finding', {
                file: 'contracts/Vault.sol',
                start_line: 42,
                end_line: 58,
                title: 'Reentrancy in withdraw',
                severity: 'critical',
                description: 'External call before state update allows reentrancy',
                recommendation: 'Use checks-effects-interactions pattern',
            });

            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.finding_id).toBeDefined();
            expect(data.finding_id).toContain('issue-');
            expect(data.displayed_in_editor).toBe(true);
        });

        it('submits a medium severity finding', async () => {
            await setup();

            const result = await client.callTool('submit_finding', {
                file: 'contracts/Token.sol',
                start_line: 10,
                end_line: 15,
                title: 'Missing input validation',
                severity: 'medium',
                description: 'No check on amount parameter',
                recommendation: 'Add require(amount > 0)',
            });

            expect(result.isError).not.toBe(true);
        });
    });

    // ========================================================================
    // finalise_finding
    // ========================================================================

    describe('finalise_finding', () => {
        it('finalises a previously submitted finding', async () => {
            await setup();

            // Submit a finding first
            const submitResult = await client.callTool('submit_finding', {
                file: 'contracts/Vault.sol',
                start_line: 42,
                end_line: 58,
                title: 'Reentrancy in withdraw',
                severity: 'critical',
                description: 'External call before state update allows reentrancy',
                recommendation: 'Use CEI pattern',
            });
            const { finding_id } = parseResult(submitResult);

            // Finalise it
            const result = await client.callTool('finalise_finding', {
                finding_id,
            });

            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.finding_id).toBe(finding_id);
            expect(data.finalised).toBe(true);
        });

        it('throws when finding does not exist', async () => {
            await setup();

            const result = await client.callTool('finalise_finding', {
                finding_id: 'nonexistent-finding',
            });
            expect(result.isError).toBe(true);
        });

        it('throws when finding already finalised', async () => {
            await setup();

            // Submit and finalise
            const submitResult = await client.callTool('submit_finding', {
                file: 'contracts/Vault.sol',
                start_line: 1,
                end_line: 5,
                title: 'Test finding',
                severity: 'high',
                description: 'Test',
                recommendation: 'Fix',
            });
            const { finding_id } = parseResult(submitResult);
            await client.callTool('finalise_finding', { finding_id });

            // Try to finalise again
            const result = await client.callTool('finalise_finding', { finding_id });
            expect(result.isError).toBe(true);
        });
    });

    // ========================================================================
    // list_findings
    // ========================================================================

    describe('list_findings', () => {
        it('returns empty list when no findings exist', async () => {
            await setup();

            const result = await client.callTool('list_findings', {});
            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.count).toBe(0);
            expect(data.findings).toEqual([]);
        });

        it('returns all findings by default', async () => {
            await setup();

            // Submit two findings
            await client.callTool('submit_finding', {
                file: 'contracts/A.sol',
                start_line: 1,
                end_line: 5,
                title: 'Finding A',
                severity: 'high',
                description: 'Desc A',
                recommendation: 'Fix A',
            });
            await client.callTool('submit_finding', {
                file: 'contracts/B.sol',
                start_line: 10,
                end_line: 20,
                title: 'Finding B',
                severity: 'medium',
                description: 'Desc B',
                recommendation: 'Fix B',
            });

            const result = await client.callTool('list_findings', {});
            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.count).toBe(2);
            expect(data.findings[0].title).toBeDefined();
            expect(data.findings[0].severity).toBeDefined();
        });

        it('filters by validated status', async () => {
            await setup();

            // Submit two findings, finalise one
            const r1 = await client.callTool('submit_finding', {
                file: 'contracts/A.sol',
                start_line: 1,
                end_line: 5,
                title: 'Validated finding',
                severity: 'critical',
                description: 'Desc',
                recommendation: 'Fix',
            });
            const { finding_id } = parseResult(r1);
            await client.callTool('finalise_finding', { finding_id });

            await client.callTool('submit_finding', {
                file: 'contracts/B.sol',
                start_line: 1,
                end_line: 5,
                title: 'Unvalidated finding',
                severity: 'low',
                description: 'Desc',
                recommendation: 'Fix',
            });

            // Filter validated
            const validatedResult = await client.callTool('list_findings', { status: 'validated' });
            const validatedData = parseResult(validatedResult);
            expect(validatedData.count).toBe(1);
            expect(validatedData.findings[0].title).toBe('Validated finding');
            expect(validatedData.findings[0].validated).toBe(1);

            // Filter unvalidated
            const unvalidatedResult = await client.callTool('list_findings', { status: 'unvalidated' });
            const unvalidatedData = parseResult(unvalidatedResult);
            expect(unvalidatedData.count).toBe(1);
            expect(unvalidatedData.findings[0].title).toBe('Unvalidated finding');
            expect(unvalidatedData.findings[0].validated).toBe(0);

            // All
            const allResult = await client.callTool('list_findings', { status: 'all' });
            const allData = parseResult(allResult);
            expect(allData.count).toBe(2);
        });

        it('does not include non-issue notes', async () => {
            await setup();

            // Submit a POI and a comment (should not appear in findings)
            await client.callTool('submit_poi', {
                file: 'contracts/A.sol',
                start_line: 1,
                end_line: 1,
                text: 'A POI',
            });
            await client.callTool('submit_comment', {
                file: 'contracts/A.sol',
                start_line: 1,
                end_line: 1,
                text: 'A comment',
            });

            // Submit one finding
            await client.callTool('submit_finding', {
                file: 'contracts/A.sol',
                start_line: 1,
                end_line: 5,
                title: 'Only finding',
                severity: 'high',
                description: 'Desc',
                recommendation: 'Fix',
            });

            const result = await client.callTool('list_findings', {});
            const data = parseResult(result);
            expect(data.count).toBe(1);
            expect(data.findings[0].title).toBe('Only finding');
        });
    });

    // ========================================================================
    // submit_comment
    // ========================================================================

    describe('submit_comment', () => {
        it('submits a comment', async () => {
            await setup();

            const result = await client.callTool('submit_comment', {
                file: 'contracts/Factory.sol',
                start_line: 1,
                end_line: 5,
                text: 'This follows a factory pattern',
            });

            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.note_id).toContain('comment-');
        });
    });

    // ========================================================================
    // Protocol docs
    // ========================================================================

    describe('submit_protocol_doc + list + get', () => {
        it('creates and retrieves a protocol doc', async () => {
            await setup();

            // Create
            const createResult = await client.callTool('submit_protocol_doc', {
                slug: 'staking-flow',
                title: 'Staking Flow Analysis',
                content: '# Staking Flow\n\nUsers deposit tokens...',
                tags: ['staking', 'defi'],
            });
            expect(createResult.isError).not.toBe(true);
            const createData = parseResult(createResult);
            expect(createData.slug).toBe('staking-flow');
            expect(createData.created).toBe(true);

            // List
            const listResult = await client.callTool('list_protocol_docs', {});
            expect(listResult.isError).not.toBe(true);
            const listData = parseResult(listResult);
            expect(listData.count).toBe(1);
            expect(listData.docs[0].slug).toBe('staking-flow');
            expect(listData.docs[0].title).toBe('Staking Flow Analysis');
            expect(listData.docs[0].tags).toEqual(['staking', 'defi']);

            // Get by slug
            const getResult = await client.callTool('get_protocol_doc', {
                slug: 'staking-flow',
            });
            expect(getResult.isError).not.toBe(true);
            const doc = parseResult(getResult);
            expect(doc.title).toBe('Staking Flow Analysis');
            expect(doc.content).toContain('Staking Flow');
        });

        it('throws when getting a nonexistent protocol doc', async () => {
            await setup();

            const result = await client.callTool('get_protocol_doc', {
                slug: 'nonexistent',
            });
            expect(result.isError).toBe(true);
        });

        it('returns empty list when no docs exist', async () => {
            await setup();

            const listResult = await client.callTool('list_protocol_docs', {});
            const data = parseResult(listResult);
            expect(data.count).toBe(0);
            expect(data.docs).toEqual([]);
        });
    });

    // ========================================================================
    // Questions
    // ========================================================================

    describe('get_open_questions', () => {
        it('returns empty when no questions exist', async () => {
            await setup();

            const result = await client.callTool('get_open_questions', {});
            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.count).toBe(0);
            expect(data.questions).toEqual([]);
        });
    });

    describe('answer_question', () => {
        it('throws when question does not exist', async () => {
            await setup();

            const result = await client.callTool('answer_question', {
                question_id: 'nonexistent-question',
                answer: 'Some answer',
                confidence: 'high',
            });
            expect(result.isError).toBe(true);
        });
    });

    // ========================================================================
    // Replies
    // ========================================================================

    describe('reply_to_note', () => {
        it('adds a reply to an existing POI', async () => {
            await setup();

            // Create a POI first
            const poiResult = await client.callTool('submit_poi', {
                file: 'contracts/Vault.sol',
                start_line: 42,
                end_line: 42,
                text: 'Interesting pattern here',
            });
            const poi = parseResult(poiResult);

            // Reply to it
            const replyResult = await client.callTool('reply_to_note', {
                note_id: poi.note_id,
                body: 'I agree, this looks suspicious',
            });

            expect(replyResult.isError).not.toBe(true);
            const reply = parseResult(replyResult);
            expect(reply.success).toBe(true);
            expect(reply.note_id).toBe(poi.note_id);
            expect(reply.reply_id).toContain('reply-');
        });

        it('throws when replying to nonexistent note', async () => {
            await setup();

            const result = await client.callTool('reply_to_note', {
                note_id: 'nonexistent-note',
                body: 'Some reply',
            });
            expect(result.isError).toBe(true);
        });
    });

    // ========================================================================
    // Clear data
    // ========================================================================

    describe('clear_hunter_data', () => {
        it('clears data for current agent and returns counts', async () => {
            await setup();

            // Submit some data first
            await client.callTool('submit_poi', {
                file: 'a.sol',
                start_line: 1,
                end_line: 1,
                text: 'POI 1',
            });

            await client.callTool('submit_finding', {
                file: 'b.sol',
                start_line: 1,
                end_line: 1,
                title: 'Issue 1',
                severity: 'high',
                description: 'Test',
                recommendation: 'Fix it',
            });

            // Clear
            const clearResult = await client.callTool('clear_hunter_data', {});
            expect(clearResult.isError).not.toBe(true);
            const data = parseResult(clearResult);
            expect(data.cleared_notes).toBeGreaterThanOrEqual(2);
        });

        it('returns zero counts when nothing to clear', async () => {
            await setup();

            const result = await client.callTool('clear_hunter_data', {});
            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.cleared_notes).toBe(0);
            expect(data.cleared_docs).toBe(0);
        });
    });
});
