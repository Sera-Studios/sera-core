/**
 * @fileoverview In-memory request metrics collector
 * @module sera-core/monitoring/MetricsCollector
 *
 * Tracks per-request metrics in a circular buffer with aggregation queries
 * for health checks, dashboards, and alerting.
 */

export interface RequestMetric {
    timestamp: number;
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    toolName?: string;
}

export interface MetricsSummary {
    period: { minutes: number };
    requests: {
        total: number;
        byStatus: Record<number, number>;
        byPath: Record<string, { count: number; avgLatencyMs: number }>;
    };
    toolCalls: {
        total: number;
        byTool: Record<string, { count: number; avgLatencyMs: number }>;
    };
    errors: Array<{
        timestamp: string;
        path: string;
        tool?: string;
        statusCode: number;
    }>;
}

export class MetricsCollector {
    private metrics: RequestMetric[] = [];
    private readonly maxEntries: number;

    constructor(maxEntries: number = 10000) {
        this.maxEntries = maxEntries;
    }

    /**
     * Record a request metric. Oldest entries are dropped when buffer is full.
     */
    record(metric: RequestMetric): void {
        this.metrics.push(metric);
        if (this.metrics.length > this.maxEntries) {
            this.metrics.shift();
        }
    }

    /**
     * Get recent errors (status >= 500) within a time window.
     */
    getRecentErrors(minutes: number): RequestMetric[] {
        const cutoff = Date.now() - minutes * 60_000;
        return this.metrics.filter(m => m.timestamp >= cutoff && m.statusCode >= 500);
    }

    /**
     * Get average latency for a specific path within a time window.
     */
    getAverageLatency(path: string, minutes: number): number {
        const cutoff = Date.now() - minutes * 60_000;
        const matching = this.metrics.filter(m => m.timestamp >= cutoff && m.path === path);
        if (matching.length === 0) return 0;
        const total = matching.reduce((sum, m) => sum + m.durationMs, 0);
        return total / matching.length;
    }

    /**
     * Get tool call counts within a time window.
     */
    getToolCallCounts(minutes: number): Record<string, number> {
        const cutoff = Date.now() - minutes * 60_000;
        const counts: Record<string, number> = {};
        for (const m of this.metrics) {
            if (m.timestamp >= cutoff && m.toolName) {
                counts[m.toolName] = (counts[m.toolName] || 0) + 1;
            }
        }
        return counts;
    }

    /**
     * Get status code distribution within a time window.
     */
    getStatusCodeDistribution(minutes: number): Record<number, number> {
        const cutoff = Date.now() - minutes * 60_000;
        const dist: Record<number, number> = {};
        for (const m of this.metrics) {
            if (m.timestamp >= cutoff) {
                dist[m.statusCode] = (dist[m.statusCode] || 0) + 1;
            }
        }
        return dist;
    }

    /**
     * Get a complete metrics summary for a time window.
     */
    getSummary(minutes: number): MetricsSummary {
        const cutoff = Date.now() - minutes * 60_000;
        const recent = this.metrics.filter(m => m.timestamp >= cutoff);

        // Status distribution
        const byStatus: Record<number, number> = {};
        for (const m of recent) {
            byStatus[m.statusCode] = (byStatus[m.statusCode] || 0) + 1;
        }

        // Path aggregation
        const pathGroups: Record<string, { durations: number[]; count: number }> = {};
        for (const m of recent) {
            if (!pathGroups[m.path]) {
                pathGroups[m.path] = { durations: [], count: 0 };
            }
            pathGroups[m.path].durations.push(m.durationMs);
            pathGroups[m.path].count++;
        }
        const byPath: Record<string, { count: number; avgLatencyMs: number }> = {};
        for (const [p, group] of Object.entries(pathGroups)) {
            const avg = group.durations.reduce((a, b) => a + b, 0) / group.durations.length;
            byPath[p] = { count: group.count, avgLatencyMs: Math.round(avg * 10) / 10 };
        }

        // Tool call aggregation
        const toolGroups: Record<string, { durations: number[]; count: number }> = {};
        for (const m of recent) {
            if (m.toolName) {
                if (!toolGroups[m.toolName]) {
                    toolGroups[m.toolName] = { durations: [], count: 0 };
                }
                toolGroups[m.toolName].durations.push(m.durationMs);
                toolGroups[m.toolName].count++;
            }
        }
        const byTool: Record<string, { count: number; avgLatencyMs: number }> = {};
        let toolTotal = 0;
        for (const [tool, group] of Object.entries(toolGroups)) {
            const avg = group.durations.reduce((a, b) => a + b, 0) / group.durations.length;
            byTool[tool] = { count: group.count, avgLatencyMs: Math.round(avg * 10) / 10 };
            toolTotal += group.count;
        }

        // Recent errors
        const errors = recent
            .filter(m => m.statusCode >= 500)
            .map(m => ({
                timestamp: new Date(m.timestamp).toISOString(),
                path: m.path,
                ...(m.toolName ? { tool: m.toolName } : {}),
                statusCode: m.statusCode,
            }));

        return {
            period: { minutes },
            requests: { total: recent.length, byStatus, byPath },
            toolCalls: { total: toolTotal, byTool },
            errors,
        };
    }

    /**
     * Get total number of recorded metrics in the buffer.
     */
    get size(): number {
        return this.metrics.length;
    }
}
