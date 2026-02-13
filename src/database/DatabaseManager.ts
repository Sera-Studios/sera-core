/**
 * @fileoverview DatabaseManager - opens/closes StorageEngines per audit
 * @module sera-core/database/DatabaseManager
 *
 * Manages the lifecycle of StorageEngine instances. Each active audit
 * gets one StorageEngine. Engines are created on first client connection
 * and shut down when no clients remain (with a grace period).
 */

import { StorageEngine } from './StorageEngine';
import { AuditRegistry } from './AuditRegistry';

export class DatabaseManager {
    private engines: Map<string, StorageEngine> = new Map();
    private registry: AuditRegistry;
    private flushIntervalMs: number;

    constructor(registry: AuditRegistry, flushIntervalMs: number = 30000) {
        this.registry = registry;
        this.flushIntervalMs = flushIntervalMs;
    }

    /**
     * Get or create a StorageEngine for an audit
     * @param slug - Audit slug
     * @returns Initialized StorageEngine
     */
    async getEngine(slug: string): Promise<StorageEngine> {
        const existing = this.engines.get(slug);
        if (existing) {
            this.registry.touchAudit(slug);
            return existing;
        }

        const dbPath = this.registry.getDbPath(slug);
        const engine = new StorageEngine(dbPath, this.flushIntervalMs);
        await engine.initialize();

        this.engines.set(slug, engine);
        this.registry.touchAudit(slug);

        return engine;
    }

    /**
     * Check if an engine is currently active for an audit
     */
    hasEngine(slug: string): boolean {
        return this.engines.has(slug);
    }

    /**
     * Shut down a specific audit's engine
     */
    async closeEngine(slug: string): Promise<void> {
        const engine = this.engines.get(slug);
        if (engine) {
            await engine.shutdown();
            this.engines.delete(slug);
        }
    }

    /**
     * Shut down all engines (used during daemon shutdown)
     */
    async shutdownAll(): Promise<void> {
        const promises = Array.from(this.engines.entries()).map(async ([slug, engine]) => {
            await engine.shutdown();
        });

        await Promise.all(promises);
        this.engines.clear();
    }

    /**
     * Get list of currently active audit slugs
     */
    getActiveAudits(): string[] {
        return Array.from(this.engines.keys());
    }
}
