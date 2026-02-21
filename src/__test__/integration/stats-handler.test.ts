/**
 * @fileoverview Integration tests for the StatsHandler MCP tools
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestnet, TestnetInstance } from '../TestHarness';
import { McpTestClient } from '../McpTestClient';

describe('StatsHandler', () => {
    let testnet: TestnetInstance;
    let client: McpTestClient;

    afterEach(async () => {
        if (testnet) await testnet.teardown();
    });

    async function setup(): Promise<void> {
        testnet = await createTestnet({ auditSlug: 'stats-test' });
        client = new McpTestClient(`${testnet.mcpUrl}/stats-test`);
        await client.initialize();
    }

    function parseResult(result: any): any {
        const text = result.content[0].text;
        try { return JSON.parse(text); }
        catch { return text; }
    }

    // ========================================================================
    // save_stats / get_stats
    // ========================================================================

    describe('save_stats + get_stats', () => {
        it('saves and retrieves aggregate stats', async () => {
            await setup();

            const saveResult = await client.callTool('save_stats', {
                totalTime: 120000,
                totalPoints: 350,
                nonce: 3,
            });
            expect(saveResult.isError).not.toBe(true);
            expect(parseResult(saveResult).success).toBe(true);

            const getResult = await client.callTool('get_stats', {});
            expect(getResult.isError).not.toBe(true);
            const stats = parseResult(getResult);
            expect(stats.totalTime).toBe(120000);
            expect(stats.totalPoints).toBe(350);
            expect(stats.nonce).toBe(3);
        });

        it('returns zeroes when no stats have been saved', async () => {
            await setup();

            const getResult = await client.callTool('get_stats', {});
            expect(getResult.isError).not.toBe(true);
            const stats = parseResult(getResult);
            expect(stats.totalTime).toBe(0);
            expect(stats.totalPoints).toBe(0);
            expect(stats.nonce).toBe(0);
        });

        it('overwrites stats on subsequent saves', async () => {
            await setup();

            await client.callTool('save_stats', {
                totalTime: 100,
                totalPoints: 50,
                nonce: 1,
            });

            await client.callTool('save_stats', {
                totalTime: 200,
                totalPoints: 100,
                nonce: 2,
            });

            const stats = parseResult(await client.callTool('get_stats', {}));
            expect(stats.totalTime).toBe(200);
            expect(stats.totalPoints).toBe(100);
            expect(stats.nonce).toBe(2);
        });
    });

    // ========================================================================
    // save_session / get_sessions
    // ========================================================================

    describe('save_session + get_sessions', () => {
        it('saves and retrieves a session', async () => {
            await setup();

            const saveResult = await client.callTool('save_session', {
                nonce: 1,
                startTime: 1700000000000,
                lastActivityTime: 1700001800000,
                duration: 1800000,
                points: 120,
                peakMultiplier: 2.5,
                idle: false,
            });
            expect(saveResult.isError).not.toBe(true);
            expect(parseResult(saveResult).nonce).toBe(1);

            const getResult = await client.callTool('get_sessions', {});
            expect(getResult.isError).not.toBe(true);
            const data = parseResult(getResult);
            expect(data.count).toBe(1);
            expect(data.sessions[0].nonce).toBe(1);
            expect(data.sessions[0].duration).toBe(1800000);
            expect(data.sessions[0].points).toBe(120);
            expect(data.sessions[0].peakMultiplier).toBe(2.5);
            expect(data.sessions[0].idle).toBe(false);
        });

        it('saves session with metadata', async () => {
            await setup();

            await client.callTool('save_session', {
                nonce: 1,
                startTime: 1700000000000,
                lastActivityTime: 1700001800000,
                duration: 1800000,
                points: 50,
                peakMultiplier: 1.0,
                idle: true,
                metadata: '{"reason":"user-afk"}',
            });

            const data = parseResult(await client.callTool('get_sessions', {}));
            expect(data.sessions[0].idle).toBe(true);
            expect(data.sessions[0].metadata).toBe('{"reason":"user-afk"}');
        });

        it('returns sessions in descending nonce order', async () => {
            await setup();

            for (let i = 1; i <= 3; i++) {
                await client.callTool('save_session', {
                    nonce: i,
                    startTime: 1700000000000 + i * 1000,
                    lastActivityTime: 1700000000000 + i * 2000,
                    duration: 60000 * i,
                    points: 10 * i,
                    peakMultiplier: 1.0,
                    idle: false,
                });
            }

            const data = parseResult(await client.callTool('get_sessions', {}));
            expect(data.count).toBe(3);
            expect(data.sessions[0].nonce).toBe(3);
            expect(data.sessions[1].nonce).toBe(2);
            expect(data.sessions[2].nonce).toBe(1);
        });

        it('respects limit parameter', async () => {
            await setup();

            for (let i = 1; i <= 5; i++) {
                await client.callTool('save_session', {
                    nonce: i,
                    startTime: 1700000000000,
                    lastActivityTime: 1700000000000,
                    duration: 1000,
                    points: 0,
                    peakMultiplier: 1.0,
                    idle: false,
                });
            }

            const data = parseResult(await client.callTool('get_sessions', { limit: 2 }));
            expect(data.count).toBe(2);
            expect(data.sessions[0].nonce).toBe(5);
            expect(data.sessions[1].nonce).toBe(4);
        });

        it('returns empty list when no sessions exist', async () => {
            await setup();

            const data = parseResult(await client.callTool('get_sessions', {}));
            expect(data.count).toBe(0);
            expect(data.sessions).toEqual([]);
        });
    });

    // ========================================================================
    // save_intervention
    // ========================================================================

    describe('save_intervention', () => {
        it('saves an intervention record', async () => {
            await setup();

            const result = await client.callTool('save_intervention', {
                id: 'int-001',
                sessionNonce: 1,
                strategyId: 'streak-reward',
                strategyName: 'Streak Reward',
                triggeredAt: 1700000900000,
                outcome: 'success',
                contextSnapshot: '{"streak":5,"multiplier":2.0}',
            });
            expect(result.isError).not.toBe(true);
            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.id).toBe('int-001');
        });

        it('saves intervention with optional fields', async () => {
            await setup();

            const result = await client.callTool('save_intervention', {
                id: 'int-002',
                sessionNonce: 2,
                strategyId: 'break-nudge',
                strategyName: 'Break Nudge',
                triggeredAt: 1700001000000,
                outcome: 'failure',
                extensionDurationSec: 300,
                contextSnapshot: '{"elapsed":7200}',
                strategyMetadata: '{"attempt":3}',
            });
            expect(result.isError).not.toBe(true);
            expect(parseResult(result).success).toBe(true);
        });
    });

    // ========================================================================
    // Error handling
    // ========================================================================

    describe('error handling', () => {
        it('rejects unknown tool names', async () => {
            await setup();

            const result = await client.callTool('nonexistent_stats_tool', {});
            expect(result.isError).toBe(true);
        });
    });
});
