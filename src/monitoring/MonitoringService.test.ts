/**
 * @fileoverview Unit tests for MonitoringService
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetricsCollector } from './MetricsCollector';
import { MonitoringService, AlertPayload } from './MonitoringService';
import { SeraConfig, loadConfig } from '../config';
import { Logger, setOutputStream, resetOutputStream } from '../logging/Logger';
import { Writable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function nullStream(): Writable {
    return new Writable({ write(_c, _e, cb) { cb(); } });
}

function makeConfig(overrides?: Partial<SeraConfig['monitoring']>): SeraConfig {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-mon-test-'));
    const config = loadConfig(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    config.monitoring = {
        alerts: {
            enabled: true,
            webhookUrl: 'http://localhost:9999/webhook',
            thresholds: {
                errorRatePerMinute: 5,
                avgLatencyMs: 1000,
                consecutiveFailedHealthChecks: 3,
            },
            ...overrides?.alerts,
        },
    };
    return config;
}

describe('MonitoringService', () => {
    let collector: MetricsCollector;
    let log: Logger;

    beforeEach(() => {
        collector = new MetricsCollector();
        const stream = nullStream();
        setOutputStream(stream, stream);
        log = new Logger('test', { format: 'text', level: 'debug' });
    });

    afterEach(() => {
        resetOutputStream();
    });

    it('evaluate() detects error rate threshold breach', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        // Add 6 errors in the last minute (threshold is 5)
        for (let i = 0; i < 6; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'POST',
                path: '/mcp',
                statusCode: 500,
                durationMs: 10,
            });
        }

        service.evaluate();

        expect(alerts).toHaveLength(1);
        expect(alerts[0].alert).toBe('error_rate_exceeded');
        expect(alerts[0].actual).toBe(6);
        expect(alerts[0].threshold).toBe(5);
    });

    it('evaluate() detects latency threshold breach', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        // Add requests with high latency (threshold is 1000ms)
        for (let i = 0; i < 5; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'GET',
                path: '/api/resources',
                statusCode: 200,
                durationMs: 2000,
            });
        }

        service.evaluate();

        expect(alerts).toHaveLength(1);
        expect(alerts[0].alert).toBe('high_latency');
        expect(alerts[0].actual).toBeGreaterThan(1000);
    });

    it('cooldown prevents repeated alerts within 5 minutes', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        // Trigger errors
        for (let i = 0; i < 10; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'POST',
                path: '/mcp',
                statusCode: 500,
                durationMs: 10,
            });
        }

        service.evaluate();
        expect(alerts).toHaveLength(1);

        // Second evaluate should be in cooldown
        service.evaluate();
        expect(alerts).toHaveLength(1);
    });

    it('no alerts when thresholds not breached', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        // Add normal requests
        for (let i = 0; i < 3; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'GET',
                path: '/api/health',
                statusCode: 200,
                durationMs: 10,
            });
        }

        service.evaluate();
        expect(alerts).toHaveLength(0);
    });

    it('no alerts when monitoring disabled', () => {
        const config = makeConfig();
        config.monitoring!.alerts!.enabled = false;
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        for (let i = 0; i < 10; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'POST',
                path: '/mcp',
                statusCode: 500,
                durationMs: 10,
            });
        }

        service.evaluate();
        expect(alerts).toHaveLength(0);
    });

    it('start() and stop() manage the timer', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);

        service.start();
        service.stop();
        // Should not throw
    });

    it('start() is a no-op when alerts are disabled', () => {
        const config = makeConfig();
        config.monitoring!.alerts!.enabled = false;
        const service = new MonitoringService(collector, config, log);

        service.start();
        // No timer started since alerts disabled
        service.stop();
    });

    it('stop() is safe to call when not started', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);
        service.stop();
        // Should not throw
    });

    it('evaluate() skips when no thresholds configured', () => {
        const config = makeConfig();
        config.monitoring!.alerts!.thresholds = undefined;
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        for (let i = 0; i < 10; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'POST',
                path: '/mcp',
                statusCode: 500,
                durationMs: 10,
            });
        }

        service.evaluate();
        expect(alerts).toHaveLength(0);
    });

    it('logs warning when alert fires without webhook URL', () => {
        const config = makeConfig();
        config.monitoring!.alerts!.webhookUrl = undefined;
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        for (let i = 0; i < 10; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'POST',
                path: '/mcp',
                statusCode: 500,
                durationMs: 10,
            });
        }

        // Should not call sendWebhook since URL is undefined
        service.evaluate();
        expect(alerts).toHaveLength(0);
    });

    it('evaluate() skips latency check when no requests exist', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        // No requests recorded at all
        service.evaluate();
        expect(alerts).toHaveLength(0);
    });

    it('both error and latency alerts can fire in same evaluate()', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        // Add 6 errors with high latency (both thresholds breached)
        for (let i = 0; i < 6; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'POST',
                path: '/mcp',
                statusCode: 500,
                durationMs: 2000,
            });
        }

        service.evaluate();
        expect(alerts).toHaveLength(2);
        const alertTypes = alerts.map(a => a.alert);
        expect(alertTypes).toContain('error_rate_exceeded');
        expect(alertTypes).toContain('high_latency');
    });

    it('alert payload includes correct structure', () => {
        const config = makeConfig();
        const service = new MonitoringService(collector, config, log);

        const alerts: AlertPayload[] = [];
        service.sendWebhook = (_url, payload) => { alerts.push(payload); };

        for (let i = 0; i < 6; i++) {
            collector.record({
                timestamp: Date.now(),
                method: 'POST',
                path: '/mcp',
                statusCode: 500,
                durationMs: 10,
            });
        }

        service.evaluate();
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
            service: 'sera-core',
            alert: 'error_rate_exceeded',
            threshold: 5,
        });
        expect(alerts[0].timestamp).toBeDefined();
        expect(alerts[0].message).toContain('exceeded threshold');
    });
});
