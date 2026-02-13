/**
 * @fileoverview WebSocketAPI - client connection handling for sera-core
 * @module sera-core/api/WebSocketAPI
 *
 * Handles WebSocket connections from VS Code instances, web dashboards,
 * and CLI tools. Routes storage operations to the correct audit database.
 */

import WebSocket from 'ws';
import { Server as HttpServer } from 'http';
import {
    ClientMessage,
    ConnectMessage,
    AuditSelectedMessage,
    AuditCreateMessage,
    StorageRegisterMessage,
    StorageWriteMessage,
    StorageQueryMessage,
    StorageDeleteMessage,
    SubscribeMessage,
    ConnectedMessage,
    SelectAuditMessage,
    StorageRegisteredMessage,
    StorageWrittenMessage,
    StorageResultMessage,
    StorageDeletedMessage,
} from '@sera/types';
import { DatabaseManager } from '../database/DatabaseManager';
import { AuditRegistry } from '../database/AuditRegistry';
import { EventBridge } from '../events/EventBridge';

interface ClientState {
    clientId: string;
    clientType: string;
    auditSlug: string | null;
    workspacePath: string | null;
    ws: WebSocket;
}

export class WebSocketAPI {
    private wss!: WebSocket.Server;
    private clients: Map<string, ClientState> = new Map();
    private dbManager: DatabaseManager;
    private registry: AuditRegistry;
    private bridge: EventBridge;

    constructor(dbManager: DatabaseManager, registry: AuditRegistry, bridge: EventBridge) {
        this.dbManager = dbManager;
        this.registry = registry;
        this.bridge = bridge;
    }

    /**
     * Attach WebSocket server to an HTTP server
     */
    attach(server: HttpServer): void {
        this.wss = new WebSocket.Server({ server });

        this.wss.on('connection', (ws: WebSocket) => {
            this.handleConnection(ws);
        });
    }

    /**
     * Get count of connected clients
     */
    getClientCount(): number {
        return this.clients.size;
    }

    /**
     * Shut down all client connections
     */
    shutdown(): void {
        for (const [, client] of this.clients) {
            client.ws.close(1001, 'Server shutting down');
        }
        this.clients.clear();
        if (this.wss) {
            this.wss.close();
        }
    }

    // ========================================================================
    // CONNECTION HANDLING
    // ========================================================================

    private handleConnection(ws: WebSocket): void {
        let clientState: ClientState | null = null;

        ws.on('message', async (raw: WebSocket.RawData) => {
            try {
                const message = JSON.parse(raw.toString()) as ClientMessage;

                switch (message.type) {
                    case 'connect':
                        clientState = await this.handleConnect(ws, message as ConnectMessage);
                        break;
                    case 'audit-selected':
                        if (clientState) {
                            await this.handleAuditSelected(clientState, message as AuditSelectedMessage);
                        }
                        break;
                    case 'audit-create':
                        if (clientState) {
                            await this.handleAuditCreate(clientState, message as AuditCreateMessage);
                        }
                        break;
                    case 'storage:register':
                        if (clientState?.auditSlug) {
                            await this.handleStorageRegister(clientState, message as StorageRegisterMessage);
                        }
                        break;
                    case 'storage:write':
                        if (clientState?.auditSlug) {
                            await this.handleStorageWrite(clientState, message as StorageWriteMessage);
                        }
                        break;
                    case 'storage:query':
                        if (clientState?.auditSlug) {
                            await this.handleStorageQuery(clientState, message as StorageQueryMessage);
                        }
                        break;
                    case 'storage:delete':
                        if (clientState?.auditSlug) {
                            await this.handleStorageDelete(clientState, message as StorageDeleteMessage);
                        }
                        break;
                    case 'subscribe':
                        if (clientState?.auditSlug) {
                            this.handleSubscribe(clientState, message as SubscribeMessage);
                        }
                        break;
                }
            } catch (err) {
                console.error('[sera-core] WebSocket message error:', err);
                ws.send(JSON.stringify({ type: 'error', error: String(err) }));
            }
        });

        ws.on('close', () => {
            if (clientState) {
                this.bridge.unsubscribeClient(clientState.clientId);
                this.clients.delete(clientState.clientId);
                console.log(`[sera-core] Client disconnected: ${clientState.clientId}`);
            }
        });

        ws.on('error', (err) => {
            console.error('[sera-core] WebSocket error:', err);
        });
    }

    // ========================================================================
    // MESSAGE HANDLERS
    // ========================================================================

    private async handleConnect(ws: WebSocket, msg: ConnectMessage): Promise<ClientState> {
        const state: ClientState = {
            clientId: msg.clientId,
            clientType: msg.clientType,
            auditSlug: null,
            workspacePath: msg.workspacePath,
            ws,
        };

        this.clients.set(msg.clientId, state);
        console.log(`[sera-core] Client connected: ${msg.clientId} (${msg.clientType}) workspace=${msg.workspacePath}`);

        // Look up workspace in registry
        const slug = this.registry.lookupWorkspace(msg.workspacePath);

        if (slug && this.registry.auditExists(slug)) {
            // Known workspace - connect to audit
            state.auditSlug = slug;
            await this.dbManager.getEngine(slug);

            const meta = this.registry.getAuditMeta(slug);
            const response: ConnectedMessage = {
                type: 'connected',
                auditSlug: slug,
                auditName: meta?.name || slug,
            };
            ws.send(JSON.stringify(response));
        } else {
            // Unknown workspace - ask client to select or create
            const audits = this.registry.listAudits();
            const response: SelectAuditMessage = {
                type: 'select-audit',
                audits,
                allowCreate: true,
            };
            ws.send(JSON.stringify(response));
        }

        return state;
    }

    private async handleAuditSelected(state: ClientState, msg: AuditSelectedMessage): Promise<void> {
        if (!this.registry.auditExists(msg.slug)) {
            state.ws.send(JSON.stringify({ type: 'error', error: `Audit '${msg.slug}' not found` }));
            return;
        }

        state.auditSlug = msg.slug;
        await this.dbManager.getEngine(msg.slug);

        // Register workspace mapping
        if (msg.workspacePath) {
            this.registry.registerWorkspace(msg.workspacePath, msg.slug);
        }

        const meta = this.registry.getAuditMeta(msg.slug);
        const response: ConnectedMessage = {
            type: 'connected',
            auditSlug: msg.slug,
            auditName: meta?.name || msg.slug,
        };
        state.ws.send(JSON.stringify(response));
    }

    private async handleAuditCreate(state: ClientState, msg: AuditCreateMessage): Promise<void> {
        const slug = AuditRegistry.slugify(msg.name);

        if (this.registry.auditExists(slug)) {
            state.ws.send(JSON.stringify({ type: 'error', error: `Audit '${slug}' already exists` }));
            return;
        }

        // Create audit
        const dbPath = this.registry.createAudit(slug, msg.name, msg.workspacePath);

        // If migrating from an existing database, copy it
        if (msg.migrateFrom) {
            const fs = await import('fs');
            if (fs.existsSync(msg.migrateFrom)) {
                fs.copyFileSync(msg.migrateFrom, dbPath);
                // Rename source as backup
                fs.renameSync(msg.migrateFrom, msg.migrateFrom + '.migrated');
                console.log(`[sera-core] Migrated database from ${msg.migrateFrom} to ${dbPath}`);
            }
        }

        state.auditSlug = slug;
        await this.dbManager.getEngine(slug);

        const response: ConnectedMessage = {
            type: 'connected',
            auditSlug: slug,
            auditName: msg.name,
        };
        state.ws.send(JSON.stringify(response));
    }

    private async handleStorageRegister(state: ClientState, msg: StorageRegisterMessage): Promise<void> {
        const engine = await this.dbManager.getEngine(state.auditSlug!);
        const results = engine.registerTables(msg.appletId, msg.tables);

        const response: StorageRegisteredMessage = {
            type: 'storage:registered',
            nonce: msg.nonce,
            results,
        };
        state.ws.send(JSON.stringify(response));
    }

    private async handleStorageWrite(state: ClientState, msg: StorageWriteMessage): Promise<void> {
        const engine = await this.dbManager.getEngine(state.auditSlug!);
        engine.write(msg.appletId, msg.table, msg.data);

        const response: StorageWrittenMessage = {
            type: 'storage:written',
            nonce: msg.nonce,
        };
        state.ws.send(JSON.stringify(response));

        // Broadcast update to other clients
        this.bridge.broadcastStorageUpdate(
            state.clientId,
            state.auditSlug!,
            msg.appletId,
            msg.table,
            'insert',
            msg.data
        );
    }

    private async handleStorageQuery(state: ClientState, msg: StorageQueryMessage): Promise<void> {
        const engine = await this.dbManager.getEngine(state.auditSlug!);

        let results: any[];
        if (msg.sql) {
            results = engine.sql(msg.sql, msg.params);
        } else {
            results = engine.query(msg.appletId, msg.table, msg.query);
        }

        const response: StorageResultMessage = {
            type: 'storage:result',
            nonce: msg.nonce,
            results,
        };
        state.ws.send(JSON.stringify(response));
    }

    private async handleStorageDelete(state: ClientState, msg: StorageDeleteMessage): Promise<void> {
        const engine = await this.dbManager.getEngine(state.auditSlug!);
        const count = engine.delete(msg.appletId, msg.table, msg.key);

        const response: StorageDeletedMessage = {
            type: 'storage:deleted',
            nonce: msg.nonce,
            count,
        };
        state.ws.send(JSON.stringify(response));

        // Broadcast deletion to other clients
        this.bridge.broadcastStorageUpdate(
            state.clientId,
            state.auditSlug!,
            msg.appletId,
            msg.table,
            'delete',
            msg.key
        );
    }

    private handleSubscribe(state: ClientState, msg: SubscribeMessage): void {
        this.bridge.subscribe(state.ws, state.clientId, state.auditSlug!, msg.tables);
    }
}
