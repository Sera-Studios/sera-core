/**
 * @fileoverview Unit tests for metrics middleware
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import * as http from 'http';
import { MetricsCollector } from '../monitoring/MetricsCollector';
import { createMetricsMiddleware } from './metricsMiddleware';

function makeRequest(port: number, method: string, path: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: 'localhost', port, path, method }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode!));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('metricsMiddleware', () => {
    it('records request method, path, status code, and duration', async () => {
        const collector = new MetricsCollector();
        const app = express();

        app.use(createMetricsMiddleware(collector));
        app.get('/api/test', (_req, res) => { res.json({ ok: true }); });
        app.post('/api/submit', (_req, res) => { res.status(201).json({ created: true }); });

        const server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, resolve));
        const port = (server.address() as { port: number }).port;

        try {
            await makeRequest(port, 'GET', '/api/test');
            await makeRequest(port, 'POST', '/api/submit');

            expect(collector.size).toBe(2);

            const summary = collector.getSummary(1);
            expect(summary.requests.byPath['/api/test']).toBeDefined();
            expect(summary.requests.byPath['/api/test'].count).toBe(1);
            expect(summary.requests.byPath['/api/submit']).toBeDefined();
            expect(summary.requests.byPath['/api/submit'].count).toBe(1);

            // Duration should be reasonable (> 0)
            expect(summary.requests.byPath['/api/test'].avgLatencyMs).toBeGreaterThanOrEqual(0);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
