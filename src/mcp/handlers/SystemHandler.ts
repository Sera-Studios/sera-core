/**
 * @fileoverview MCP handler for system health and metrics tools
 * @module sera-core/mcp/handlers/SystemHandler
 *
 * Provides system_health and system_metrics tools for Claude Code agents
 * to check sera-core status during autonomous operation.
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
} from '@sera/types';
import { MetricsCollector } from '../../monitoring/MetricsCollector';

export interface HealthData {
    status: string;
    uptime: number;
    version: string;
    checks: Record<string, unknown>;
    metrics: {
        requestsLastHour: number;
        errorsLastHour: number;
        avgLatencyMs: number;
        topTools: Array<{ name: string; calls: number }>;
    };
}

const SYSTEM_TOOLS: McpToolDefinition[] = [
    {
        name: 'system_health',
        description: 'Get sera-core health status including dependency checks and recent metrics.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'system_metrics',
        description: 'Get detailed request metrics for a time period.',
        inputSchema: {
            type: 'object',
            properties: {
                minutes: {
                    type: 'number',
                    description: 'Lookback period in minutes (default: 60)',
                },
            },
        },
    },
];

export class SystemHandler implements PortableMcpHandler {
    private metricsCollector: MetricsCollector;
    private getHealthData: () => HealthData;

    constructor(metricsCollector: MetricsCollector, getHealthData: () => HealthData) {
        this.metricsCollector = metricsCollector;
        this.getHealthData = getHealthData;
    }

    getToolDefinitions(): McpToolDefinition[] {
        return SYSTEM_TOOLS;
    }

    async handleToolCall(
        toolName: string,
        args: Record<string, unknown>,
        _context: HandlerContext,
    ): Promise<unknown> {
        switch (toolName) {
            case 'system_health':
                return this.getHealthData();

            case 'system_metrics': {
                const minutes = typeof args.minutes === 'number' ? args.minutes : 60;
                return this.metricsCollector.getSummary(minutes);
            }

            default:
                return { error: `Unknown tool: ${toolName}` };
        }
    }
}
