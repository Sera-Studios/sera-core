/**
 * @fileoverview Unit tests for MetricsCollector
 */

import { describe, it, expect } from 'vitest';
import { MetricsCollector } from './MetricsCollector';

function makeMetric(overrides: Partial<{
    timestamp: number;
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    toolName: string;
}> = {}) {
    return {
        timestamp: Date.now(),
        method: 'GET',
        path: '/api/health',
        statusCode: 200,
        durationMs: 10,
        ...overrides,
    };
}

describe('MetricsCollector', () => {
    it('record() adds metrics', () => {
        const collector = new MetricsCollector();
        collector.record(makeMetric());
        expect(collector.size).toBe(1);
    });

    it('record() respects maxEntries circular buffer', () => {
        const collector = new MetricsCollector(3);
        collector.record(makeMetric({ path: '/a' }));
        collector.record(makeMetric({ path: '/b' }));
        collector.record(makeMetric({ path: '/c' }));
        collector.record(makeMetric({ path: '/d' }));

        expect(collector.size).toBe(3);
        // First entry (/a) should have been dropped
        const summary = collector.getSummary(60);
        expect(summary.requests.byPath['/a']).toBeUndefined();
        expect(summary.requests.byPath['/d']).toBeDefined();
    });

    it('getRecentErrors() filters by status and time window', () => {
        const collector = new MetricsCollector();
        collector.record(makeMetric({ statusCode: 200 }));
        collector.record(makeMetric({ statusCode: 500 }));
        collector.record(makeMetric({ statusCode: 502 }));
        // Old error (outside window)
        collector.record(makeMetric({ statusCode: 500, timestamp: Date.now() - 120_000 }));

        const errors = collector.getRecentErrors(1); // last 1 minute
        expect(errors).toHaveLength(2);
        expect(errors.every(e => e.statusCode >= 500)).toBe(true);
    });

    it('getAverageLatency() computes correct mean for a path', () => {
        const collector = new MetricsCollector();
        collector.record(makeMetric({ path: '/mcp', durationMs: 10 }));
        collector.record(makeMetric({ path: '/mcp', durationMs: 20 }));
        collector.record(makeMetric({ path: '/mcp', durationMs: 30 }));
        collector.record(makeMetric({ path: '/api/health', durationMs: 5 }));

        expect(collector.getAverageLatency('/mcp', 60)).toBe(20);
        expect(collector.getAverageLatency('/api/health', 60)).toBe(5);
    });

    it('getAverageLatency() returns 0 for unknown path', () => {
        const collector = new MetricsCollector();
        expect(collector.getAverageLatency('/unknown', 60)).toBe(0);
    });

    it('getToolCallCounts() counts by tool name', () => {
        const collector = new MetricsCollector();
        collector.record(makeMetric({ toolName: 'submit_finding' }));
        collector.record(makeMetric({ toolName: 'submit_finding' }));
        collector.record(makeMetric({ toolName: 'list_findings' }));
        collector.record(makeMetric()); // no toolName

        const counts = collector.getToolCallCounts(60);
        expect(counts['submit_finding']).toBe(2);
        expect(counts['list_findings']).toBe(1);
        expect(Object.keys(counts)).toHaveLength(2);
    });

    it('getStatusCodeDistribution() groups by status code', () => {
        const collector = new MetricsCollector();
        collector.record(makeMetric({ statusCode: 200 }));
        collector.record(makeMetric({ statusCode: 200 }));
        collector.record(makeMetric({ statusCode: 400 }));
        collector.record(makeMetric({ statusCode: 500 }));

        const dist = collector.getStatusCodeDistribution(60);
        expect(dist[200]).toBe(2);
        expect(dist[400]).toBe(1);
        expect(dist[500]).toBe(1);
    });

    it('getSummary() returns complete summary object', () => {
        const collector = new MetricsCollector();
        collector.record(makeMetric({ path: '/mcp', durationMs: 15, toolName: 'submit_finding', statusCode: 200 }));
        collector.record(makeMetric({ path: '/mcp', durationMs: 25, toolName: 'list_findings', statusCode: 200 }));
        collector.record(makeMetric({ path: '/api/resources', durationMs: 8, statusCode: 200 }));
        collector.record(makeMetric({ path: '/mcp', durationMs: 100, toolName: 'submit_finding', statusCode: 500 }));

        const summary = collector.getSummary(60);
        expect(summary.period.minutes).toBe(60);
        expect(summary.requests.total).toBe(4);
        expect(summary.requests.byStatus[200]).toBe(3);
        expect(summary.requests.byStatus[500]).toBe(1);
        expect(summary.requests.byPath['/mcp'].count).toBe(3);
        expect(summary.requests.byPath['/api/resources'].count).toBe(1);
        expect(summary.toolCalls.total).toBe(3);
        expect(summary.toolCalls.byTool['submit_finding'].count).toBe(2);
        expect(summary.toolCalls.byTool['list_findings'].count).toBe(1);
        expect(summary.errors).toHaveLength(1);
        expect(summary.errors[0].statusCode).toBe(500);
        expect(summary.errors[0].tool).toBe('submit_finding');
    });

    it('empty collector returns zero/empty results', () => {
        const collector = new MetricsCollector();
        expect(collector.getRecentErrors(60)).toEqual([]);
        expect(collector.getAverageLatency('/mcp', 60)).toBe(0);
        expect(collector.getToolCallCounts(60)).toEqual({});
        expect(collector.getStatusCodeDistribution(60)).toEqual({});

        const summary = collector.getSummary(60);
        expect(summary.requests.total).toBe(0);
        expect(summary.toolCalls.total).toBe(0);
        expect(summary.errors).toEqual([]);
    });
});
