/**
 * @fileoverview Alert monitoring service for sera-core
 * @module sera-core/monitoring/MonitoringService
 *
 * Periodically evaluates metrics against configured thresholds
 * and fires webhook alerts when breached. Includes a 5-minute
 * cooldown per alert type to prevent storms.
 */

import * as http from 'http';
import * as https from 'https';
import { MetricsCollector } from './MetricsCollector';
import { SeraConfig } from '../config';
import { Logger } from '../logging/Logger';

const CHECK_INTERVAL_MS = 60_000;
const COOLDOWN_MS = 5 * 60_000;

export interface AlertPayload {
    service: string;
    alert: string;
    threshold: number;
    actual: number;
    timestamp: string;
    message: string;
}

export class MonitoringService {
    private collector: MetricsCollector;
    private config: SeraConfig;
    private log: Logger;
    private timer?: ReturnType<typeof setInterval>;
    private lastAlertedAt: Map<string, number> = new Map();

    /** Exposed for testing: override to intercept webhook calls */
    sendWebhook: (url: string, payload: AlertPayload) => void;

    constructor(collector: MetricsCollector, config: SeraConfig, log: Logger) {
        this.collector = collector;
        this.config = config;
        this.log = log;
        this.sendWebhook = this.defaultSendWebhook.bind(this);
    }

    /**
     * Start the periodic check loop.
     */
    start(): void {
        if (!this.config.monitoring?.alerts?.enabled) return;
        this.timer = setInterval(() => this.evaluate(), CHECK_INTERVAL_MS);
        this.log.info('Monitoring service started', {
            interval: CHECK_INTERVAL_MS,
            webhookUrl: this.config.monitoring.alerts.webhookUrl || 'none',
        });
    }

    /**
     * Stop the check loop.
     */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * Evaluate metrics against thresholds and fire alerts if breached.
     * Public for testing.
     */
    evaluate(): void {
        const alerts = this.config.monitoring?.alerts;
        if (!alerts?.enabled) return;

        const thresholds = alerts.thresholds;
        if (!thresholds) return;

        // Check error rate per minute
        if (thresholds.errorRatePerMinute !== undefined) {
            const errors = this.collector.getRecentErrors(1);
            if (errors.length > thresholds.errorRatePerMinute) {
                this.fireAlert('error_rate_exceeded', thresholds.errorRatePerMinute, errors.length,
                    `Error rate exceeded threshold: ${errors.length} errors/min (threshold: ${thresholds.errorRatePerMinute})`);
            }
        }

        // Check average latency
        if (thresholds.avgLatencyMs !== undefined) {
            const summary = this.collector.getSummary(1);
            if (summary.requests.total > 0) {
                const totalDuration = Object.values(summary.requests.byPath)
                    .reduce((sum, p) => sum + p.avgLatencyMs * p.count, 0);
                const avgLatency = totalDuration / summary.requests.total;

                if (avgLatency > thresholds.avgLatencyMs) {
                    this.fireAlert('high_latency', thresholds.avgLatencyMs, Math.round(avgLatency),
                        `Average latency exceeded threshold: ${Math.round(avgLatency)}ms (threshold: ${thresholds.avgLatencyMs}ms)`);
                }
            }
        }
    }

    private fireAlert(alertType: string, threshold: number, actual: number, message: string): void {
        // Cooldown check
        const lastAlerted = this.lastAlertedAt.get(alertType) || 0;
        if (Date.now() - lastAlerted < COOLDOWN_MS) return;

        this.lastAlertedAt.set(alertType, Date.now());

        const webhookUrl = this.config.monitoring?.alerts?.webhookUrl;
        if (!webhookUrl) {
            this.log.warn('Alert triggered but no webhook URL configured', { alert: alertType, actual });
            return;
        }

        const payload: AlertPayload = {
            service: 'sera-core',
            alert: alertType,
            threshold,
            actual,
            timestamp: new Date().toISOString(),
            message,
        };

        this.log.warn('Alert fired', { alert: alertType, threshold, actual });
        this.sendWebhook(webhookUrl, payload);
    }

    private defaultSendWebhook(url: string, payload: AlertPayload): void {
        try {
            const parsed = new URL(url);
            const transport = parsed.protocol === 'https:' ? https : http;
            const body = JSON.stringify(payload);

            const req = transport.request({
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                // Drain response
                res.on('data', () => {});
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        this.log.error('Webhook request failed', { url, statusCode: res.statusCode });
                    }
                });
            });

            req.on('error', (err) => {
                this.log.error('Webhook request error', { url, error: err.message });
            });

            req.write(body);
            req.end();
        } catch (err) {
            this.log.error('Failed to send webhook', { url, error: String(err) });
        }
    }
}
