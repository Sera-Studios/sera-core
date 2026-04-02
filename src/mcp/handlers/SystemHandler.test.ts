/**
 * @fileoverview Unit tests for SystemHandler
 */

import { describe, it, expect } from 'vitest';
import { SystemHandler, HealthData } from './SystemHandler';
import { MetricsCollector } from '../../monitoring/MetricsCollector';
import { HandlerContext } from '@sera/types';

const mockContext: HandlerContext = {
    auditSlug: 'test',
    sessionId: 'test-session',
    agentType: 'hunter',
    workspacePath: '/tmp',
    db: {
        write: async () => {},
        query: async () => [],
        sql: async () => [],
        delete: async () => 0,
    },
    bridge: {
        emit: () => {},
        broadcastStorageUpdate: () => {},
    },
};

function makeHealthData(): HealthData {
    return {
        status: 'healthy',
        uptime: 3600,
        version: '0.1.0',
        checks: {
            database: { status: 'healthy', activeAudits: 2 },
            credentialStore: { status: 'healthy' },
        },
        metrics: {
            requestsLastHour: 100,
            errorsLastHour: 1,
            avgLatencyMs: 12.5,
            topTools: [
                { name: 'submit_finding', calls: 50 },
            ],
        },
    };
}

describe('SystemHandler', () => {
    it('getToolDefinitions returns system_health and system_metrics', () => {
        const collector = new MetricsCollector();
        const handler = new SystemHandler(collector, makeHealthData);
        const tools = handler.getToolDefinitions();
        expect(tools.map(t => t.name)).toEqual(['system_health', 'system_metrics']);
    });

    it('system_health returns health structure', async () => {
        const collector = new MetricsCollector();
        const handler = new SystemHandler(collector, makeHealthData);

        const result = await handler.handleToolCall('system_health', {}, mockContext) as HealthData;
        expect(result.status).toBe('healthy');
        expect(result.uptime).toBe(3600);
        expect(result.version).toBe('0.1.0');
        expect(result.checks).toBeDefined();
        expect(result.metrics.requestsLastHour).toBe(100);
    });

    it('system_metrics returns metrics summary', async () => {
        const collector = new MetricsCollector();
        collector.record({
            timestamp: Date.now(),
            method: 'POST',
            path: '/mcp',
            statusCode: 200,
            durationMs: 15,
            toolName: 'submit_finding',
        });

        const handler = new SystemHandler(collector, makeHealthData);
        const result = await handler.handleToolCall('system_metrics', {}, mockContext) as any;

        expect(result.period.minutes).toBe(60);
        expect(result.requests.total).toBe(1);
        expect(result.toolCalls.total).toBe(1);
    });

    it('system_metrics respects minutes parameter', async () => {
        const collector = new MetricsCollector();
        // Add metric from 2 hours ago
        collector.record({
            timestamp: Date.now() - 2 * 60 * 60_000,
            method: 'GET',
            path: '/api/health',
            statusCode: 200,
            durationMs: 5,
        });
        // Add recent metric
        collector.record({
            timestamp: Date.now(),
            method: 'POST',
            path: '/mcp',
            statusCode: 200,
            durationMs: 15,
        });

        const handler = new SystemHandler(collector, makeHealthData);
        const result = await handler.handleToolCall('system_metrics', { minutes: 60 }, mockContext) as any;

        // Only the recent metric should be in the 60-minute window
        expect(result.requests.total).toBe(1);
        expect(result.period.minutes).toBe(60);
    });

    it('returns error for unknown tool name', async () => {
        const collector = new MetricsCollector();
        const handler = new SystemHandler(collector, makeHealthData);

        const result = await handler.handleToolCall('nonexistent_tool', {}, mockContext) as any;
        expect(result.error).toBe('Unknown tool: nonexistent_tool');
    });
});
