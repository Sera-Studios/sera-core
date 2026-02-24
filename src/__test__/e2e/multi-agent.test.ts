/**
 * @fileoverview E2E test: Multiple agents on the same audit
 *
 * Verifies that two different agent roles can operate on the same audit
 * simultaneously, each submitting data with correct attribution.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

describe('Multi-Agent E2E', () => {
    let testnet: TestnetInstance;

    afterEach(async () => {
        if (testnet) { await testnet.teardown(); }
    });

    function parse(result: any): any {
        return JSON.parse(result.content[0].text);
    }

    it('two agents submit findings to the same audit with correct attribution', async () => {
        testnet = await createTestnet({ auditSlug: 'multi-agent' });

        // Two separate MCP sessions (simulating two agents)
        const hunter = new McpTestClient(`${testnet.mcpUrl}/multi-agent`);
        const gatherer = new McpTestClient(`${testnet.mcpUrl}/multi-agent`);
        const debug = new McpTestClient(`${testnet.debugMcpUrl}/multi-agent`);
        await hunter.initialize();
        await gatherer.initialize();
        await debug.initialize();

        // Register both agents
        const hunterReg = parse(await hunter.callTool('register_agent', {
            agent_name: 'hunter',
            agent_version: '1.0.0',
        }));
        const gathererReg = parse(await gatherer.callTool('register_agent', {
            agent_name: 'gatherer',
            agent_version: '1.0.0',
        }));

        expect(hunterReg.agent_id).toContain('hunter');
        expect(gathererReg.agent_id).toContain('gatherer');

        // Hunter submits an issue
        const hunterIssue = await hunter.callTool('submit_finding', {
            agent_id: hunterReg.agent_id,
            file: 'contracts/Vault.sol',
            start_line: 42,
            end_line: 50,
            title: 'Reentrancy Bug',
            severity: 'critical',
            description: 'Withdraw is vulnerable to reentrancy',
            recommendation: 'Add ReentrancyGuard',
        });
        expect(hunterIssue.isError).not.toBe(true);

        // Gatherer submits a POI
        const gathererPoi = await gatherer.callTool('submit_poi', {
            agent_id: gathererReg.agent_id,
            file: 'contracts/Token.sol',
            start_line: 1,
            end_line: 5,
            text: 'Token contract uses OpenZeppelin ERC20',
        });
        expect(gathererPoi.isError).not.toBe(true);

        // Hunter submits another issue
        const hunterIssue2 = await hunter.callTool('submit_finding', {
            agent_id: hunterReg.agent_id,
            file: 'contracts/Token.sol',
            start_line: 20,
            end_line: 25,
            title: 'Missing access control on mint',
            severity: 'high',
            description: 'mint() function has no access restriction',
            recommendation: 'Add onlyOwner modifier',
        });
        expect(hunterIssue2.isError).not.toBe(true);

        // Verify all data in the database
        const allNotes = parse(await debug.callTool('debug_query_audit', {
            sql: 'SELECT * FROM notepad_notes ORDER BY createdAt',
        }));

        expect(allNotes.length).toBe(3);

        // Check hunter's issues are attributed correctly
        const issues = allNotes.filter((n: any) => n.type === 'issue');
        expect(issues).toHaveLength(2);
        for (const issue of issues) {
            expect(issue.submittedBy).toContain('hunter');
        }

        // Check gatherer's POI is attributed correctly
        const pois = allNotes.filter((n: any) => n.type === 'poi');
        expect(pois).toHaveLength(1);
        expect(pois[0].submittedBy).toContain('gatherer');

        // Verify both agents show up in sessions
        const sessions = parse(await debug.callTool('debug_list_sessions', {}));
        expect(sessions.length).toBeGreaterThanOrEqual(2);
        expect(sessions.some((s: any) => s.agentId === hunterReg.agent_id)).toBe(true);
        expect(sessions.some((s: any) => s.agentId === gathererReg.agent_id)).toBe(true);
    });
});
