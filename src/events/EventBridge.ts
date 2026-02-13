/**
 * @fileoverview EventBridge - cross-client event distribution
 * @module sera-core/events/EventBridge
 *
 * Distributes storage updates and bridge events to all connected
 * WebSocket clients subscribed to the relevant audit/table patterns.
 */

import WebSocket from 'ws';
import { BridgeEvent, StorageUpdatePushMessage } from '@sera/types';

interface ClientSubscription {
    ws: WebSocket;
    clientId: string;
    auditSlug: string;
    /** Table patterns this client subscribes to (supports * wildcards) */
    tablePatterns: string[];
}

export class EventBridge {
    private subscriptions: ClientSubscription[] = [];

    /**
     * Register a client's table subscriptions
     */
    subscribe(ws: WebSocket, clientId: string, auditSlug: string, patterns: string[]): void {
        // Remove any existing subscription for this client
        this.unsubscribeClient(clientId);

        this.subscriptions.push({
            ws,
            clientId,
            auditSlug,
            tablePatterns: patterns,
        });
    }

    /**
     * Remove all subscriptions for a client
     */
    unsubscribeClient(clientId: string): void {
        this.subscriptions = this.subscriptions.filter(s => s.clientId !== clientId);
    }

    /**
     * Broadcast a storage update to subscribed clients.
     * @param sourceClientId - Client that caused the change (won't receive the broadcast)
     * @param auditSlug - Which audit the change belongs to
     * @param appletId - Applet that owns the table
     * @param table - Table name
     * @param action - What happened
     * @param data - The changed records
     */
    broadcastStorageUpdate(
        sourceClientId: string,
        auditSlug: string,
        appletId: string,
        table: string,
        action: 'insert' | 'update' | 'delete',
        data: Record<string, any> | Record<string, any>[]
    ): void {
        const tableKey = `${appletId}:${table}`;
        const message: StorageUpdatePushMessage = {
            type: 'storage:update',
            source: sourceClientId,
            appletId,
            table,
            action,
            data,
        };

        const payload = JSON.stringify(message);

        for (const sub of this.subscriptions) {
            // Skip the source client
            if (sub.clientId === sourceClientId) { continue; }
            // Only send to clients on the same audit
            if (sub.auditSlug !== auditSlug) { continue; }
            // Check if client is subscribed to this table
            if (!this.matchesPattern(tableKey, sub.tablePatterns)) { continue; }
            // Send if connection is open
            if (sub.ws.readyState === WebSocket.OPEN) {
                sub.ws.send(payload);
            }
        }
    }

    /**
     * Broadcast a bridge event to all clients on an audit
     */
    broadcastBridgeEvent(event: BridgeEvent): void {
        const payload = JSON.stringify({
            type: 'bridge:event',
            ...event,
        });

        for (const sub of this.subscriptions) {
            if (sub.auditSlug !== event.auditSlug) { continue; }
            if (sub.clientId === event.source) { continue; }
            if (sub.ws.readyState === WebSocket.OPEN) {
                sub.ws.send(payload);
            }
        }
    }

    /**
     * Get count of subscribed clients for an audit
     */
    getClientCount(auditSlug: string): number {
        return this.subscriptions.filter(s => s.auditSlug === auditSlug).length;
    }

    /**
     * Get total number of connected clients
     */
    getTotalClientCount(): number {
        return this.subscriptions.length;
    }

    /**
     * Check if a table key matches any of the subscription patterns
     */
    private matchesPattern(tableKey: string, patterns: string[]): boolean {
        for (const pattern of patterns) {
            if (pattern === '*') { return true; }

            // Convert glob pattern to regex
            const regex = new RegExp(
                '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
            );
            if (regex.test(tableKey)) { return true; }
        }
        return false;
    }
}
