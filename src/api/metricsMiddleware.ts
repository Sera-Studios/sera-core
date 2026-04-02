/**
 * @fileoverview Express middleware for recording request metrics
 * @module sera-core/api/metricsMiddleware
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { MetricsCollector } from '../monitoring/MetricsCollector';

/**
 * Create an Express middleware that records request metrics.
 */
export function createMetricsMiddleware(collector: MetricsCollector): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        const start = Date.now();

        res.on('finish', () => {
            collector.record({
                timestamp: start,
                method: req.method,
                path: req.path,
                statusCode: res.statusCode,
                durationMs: Date.now() - start,
            });
        });

        next();
    };
}
