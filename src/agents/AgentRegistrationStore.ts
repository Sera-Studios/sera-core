/**
 * @fileoverview Agent Registration Store
 * @module sera-core/agents/AgentRegistrationStore
 *
 * Loads agent registrations from disk (handling both legacy AgentDefinition
 * and new AgentRegistration formats) and supports runtime registration
 * from the designer service.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgentRegistration, AgentRole } from '@sera/types';

import { createLogger } from '../logging/Logger';

const log = createLogger('agents');

export class AgentRegistrationStore {
    private registrations: Map<string, AgentRegistration> = new Map();
    private diskDir: string;

    constructor(resourcesDir?: string) {
        this.diskDir = path.join(
            resourcesDir || path.join(os.homedir(), '.sera'),
            'agents'
        );
        // Ensure directory exists
        if (!fs.existsSync(this.diskDir)) {
            fs.mkdirSync(this.diskDir, { recursive: true });
        }
        this.loadFromDisk();
    }

    /**
     * Load agent registrations from disk.
     * Handles both legacy AgentDefinition format and new AgentRegistration format.
     */
    private loadFromDisk(): void {
        if (!fs.existsSync(this.diskDir)) {
            log.warn('Agents directory not found', { dir: this.diskDir });
            return;
        }

        const files = fs.readdirSync(this.diskDir).filter(f => f.endsWith('.json'));

        for (const file of files) {
            try {
                const filePath = path.join(this.diskDir, file);
                const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

                if (!raw.id || !raw.name || !raw.execution) {
                    log.warn('Skipping invalid file', { file });
                    continue;
                }

                // Backward compat: default missing roles to ['execution']
                if (!raw.roles) {
                    raw.roles = ['execution'];
                }

                this.registrations.set(raw.id, raw as AgentRegistration);
                log.info('Loaded registration', { id: raw.id, name: raw.name });
            } catch (err) {
                log.error('Failed to load registration file', { file, error: String(err) });
            }
        }

        log.info('Agent registrations loaded', { count: this.registrations.size });
    }

    /**
     * Get a specific registration by ID.
     * @param id - Registration ID
     * @returns Registration or undefined
     */
    get(id: string): AgentRegistration | undefined {
        return this.registrations.get(id);
    }

    /**
     * Get all registrations.
     * @returns Array of all registrations
     */
    getAll(): AgentRegistration[] {
        return [...this.registrations.values()];
    }

    /**
     * Get registrations that include a specific role.
     * @param role - Role to filter by
     * @returns Array of registrations whose roles array includes the given role
     */
    getByRole(role: AgentRole): AgentRegistration[] {
        return this.getAll().filter(r => r.roles.includes(role));
    }

    /**
     * List all registration IDs.
     * @returns Array of IDs
     */
    listIds(): string[] {
        return [...this.registrations.keys()];
    }

    /**
     * Register an agent at runtime (e.g. from the designer POST).
     * @param registration - Agent registration
     * @param persist - Whether to write to disk
     */
    register(registration: AgentRegistration, persist = false): void {
        this.registrations.set(registration.id, registration);
        log.info('Registered', { id: registration.id });

        if (persist) {
            const filePath = path.join(this.diskDir, `${registration.id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(registration, null, 4) + '\n');
        }
    }

    /**
     * Unregister an agent (memory only, does not delete from disk).
     * @param id - Registration ID
     * @returns true if removed
     */
    unregister(id: string): boolean {
        const removed = this.registrations.delete(id);
        if (removed) {
            log.info('Unregistered', { id });
        }
        return removed;
    }

    /**
     * Reload all registrations from disk (clears runtime registrations).
     */
    reload(): void {
        this.registrations.clear();
        this.loadFromDisk();
    }

    /**
     * Get the total count of registrations.
     * @returns Number of registrations
     */
    get size(): number {
        return this.registrations.size;
    }

    /**
     * Get the disk directory path where registrations are stored.
     */
    getDiskDir(): string {
        return this.diskDir;
    }

    /**
     * Write script artifacts to disk for a registered agent.
     * Creates ~/.sera/agents/{id}/ and writes each artifact file.
     * @param id - Agent registration ID
     * @param artifacts - Array of {name, content} pairs to write
     * @returns Absolute path to the artifact directory
     */
    writeArtifacts(id: string, artifacts: Array<{ name: string; content: string }>): string {
        const artifactDir = path.join(this.diskDir, id);
        if (!fs.existsSync(artifactDir)) {
            fs.mkdirSync(artifactDir, { recursive: true });
        }

        for (const artifact of artifacts) {
            const filePath = path.join(artifactDir, artifact.name);
            fs.writeFileSync(filePath, artifact.content);
        }

        log.info('Wrote artifacts', { id, count: artifacts.length });
        return artifactDir;
    }
}
