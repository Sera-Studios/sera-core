/**
 * @fileoverview Persistent event audit log for sera-core
 * @module sera-core/monitoring/EventLogStore
 *
 * Stores significant system events (auth, errors, config changes, lifecycle)
 * in a global system.db database using sql.js.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs, { Database } from 'sql.js';

export type EventType =
    | 'auth_success'
    | 'auth_failure'
    | 'server_start'
    | 'server_stop'
    | 'error'
    | 'config_change'
    | 'agent_register';

export interface EventLogEntry {
    id: number;
    timestamp: string;
    eventType: EventType;
    sourceIp?: string;
    detail?: Record<string, unknown>;
}

export interface EventLogQueryOptions {
    eventType?: EventType;
    since?: string;
    limit?: number;
}

export class EventLogStore {
    private db!: Database;
    private dbPath: string;

    constructor(seraHome?: string) {
        const home = seraHome || path.join(os.homedir(), '.sera');
        this.dbPath = path.join(home, 'system.db');
    }

    /**
     * Initialize the database, creating tables if needed.
     */
    async initialize(): Promise<void> {
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const SQL = await initSqlJs();

        if (fs.existsSync(this.dbPath)) {
            const buffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(buffer);
        } else {
            this.db = new SQL.Database();
        }

        this.db.run(`
            CREATE TABLE IF NOT EXISTS event_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                event_type TEXT NOT NULL,
                source_ip TEXT,
                detail TEXT
            )
        `);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp)`);

        this.save();
    }

    /**
     * Log a system event.
     */
    log(eventType: EventType, detail?: Record<string, unknown>, sourceIp?: string): void {
        if (!this.db) return;

        this.db.run(
            `INSERT INTO event_log (timestamp, event_type, source_ip, detail)
             VALUES (?, ?, ?, ?)`,
            [
                new Date().toISOString(),
                eventType,
                sourceIp || null,
                detail ? JSON.stringify(detail) : null,
            ],
        );
        this.save();
    }

    /**
     * Query events with optional filters.
     */
    query(options?: EventLogQueryOptions): EventLogEntry[] {
        if (!this.db) return [];

        let sql = 'SELECT id, timestamp, event_type, source_ip, detail FROM event_log WHERE 1=1';
        const params: (string | number)[] = [];

        if (options?.eventType) {
            sql += ' AND event_type = ?';
            params.push(options.eventType);
        }
        if (options?.since) {
            sql += ' AND timestamp >= ?';
            params.push(options.since);
        }

        sql += ' ORDER BY timestamp DESC';

        if (options?.limit) {
            sql += ' LIMIT ?';
            params.push(options.limit);
        }

        const stmt = this.db.prepare(sql);
        stmt.bind(params);

        const results: EventLogEntry[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as Record<string, unknown>;
            results.push({
                id: row.id as number,
                timestamp: row.timestamp as string,
                eventType: row.event_type as EventType,
                sourceIp: row.source_ip as string | undefined,
                detail: row.detail ? JSON.parse(row.detail as string) : undefined,
            });
        }
        stmt.free();

        return results;
    }

    /**
     * Shut down the store, saving to disk.
     */
    async shutdown(): Promise<void> {
        if (this.db) {
            this.save();
            this.db.close();
        }
    }

    private save(): void {
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
    }
}
