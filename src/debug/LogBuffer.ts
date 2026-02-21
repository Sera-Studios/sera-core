/**
 * @fileoverview Circular log buffer for testnet debugging
 * @module sera-core/debug/LogBuffer
 *
 * Captures server log output into a fixed-size ring buffer.
 * Only active when sera-core runs in testnet mode.
 */

export interface LogEntry {
    level: string;
    message: string;
    meta?: Record<string, any>;
    timestamp: string;
}

export class LogBuffer {
    private entries: LogEntry[] = [];
    private maxEntries: number;

    constructor(maxEntries: number = 1000) {
        this.maxEntries = maxEntries;
    }

    /**
     * Add a log entry to the buffer.
     * If the buffer is full, the oldest entry is dropped.
     */
    capture(level: string, message: string, meta?: Record<string, any>): void {
        const entry: LogEntry = {
            level,
            message,
            meta,
            timestamp: new Date().toISOString(),
        };

        this.entries.push(entry);

        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }
    }

    /**
     * Get the most recent log entries.
     * @param limit - Max entries to return (default: all)
     */
    getEntries(limit?: number): LogEntry[] {
        if (limit === undefined || limit >= this.entries.length) {
            return [...this.entries];
        }
        return this.entries.slice(-limit);
    }

    /**
     * Clear all captured entries.
     */
    clear(): void {
        this.entries = [];
    }

    /**
     * Get current buffer size.
     */
    get size(): number {
        return this.entries.length;
    }
}
