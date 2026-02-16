/**
 * @fileoverview Agent Lifecycle Manager
 * @module sera-core/agents/AgentLifecycleManager
 *
 * Thin dispatcher that routes agent launch/stop/status requests
 * to the appropriate execution adapter. No framework-specific logic -
 * all execution details are delegated to adapters.
 */

import {
    AgentInstance,
    AgentLaunchConfig,
    AgentHandle,
    AgentLaunchParams,
    AgentOutputData,
} from '@sera/types';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { AgentRegistrationStore } from './AgentRegistrationStore';
import { convertLegacyLaunchConfig } from './legacy/LegacyConverter';

export class AgentLifecycleManager {
    private adapters: AdapterRegistry;
    private store: AgentRegistrationStore;
    private handles: Map<string, AgentHandle> = new Map();
    private auditSlugs: Map<string, string> = new Map();
    private mcpPort: number;

    constructor(
        adapters: AdapterRegistry,
        store: AgentRegistrationStore,
        mcpPort: number = 9877
    ) {
        this.adapters = adapters;
        this.store = store;
        this.mcpPort = mcpPort;
    }

    /**
     * Launch an agent using the new registration model.
     * @param registrationId - ID of the agent registration
     * @param params - Launch parameters
     * @returns The agent handle
     */
    async launchRegistered(registrationId: string, params: AgentLaunchParams): Promise<AgentHandle> {
        const registration = this.store.get(registrationId);
        if (!registration) {
            throw new Error(`Agent registration not found: ${registrationId}`);
        }

        const adapter = this.adapters.get(registration.execution.type);

        // Validate before starting
        const validation = await adapter.validate(registration);
        if (!validation.valid) {
            throw new Error(
                `Agent validation failed for ${registrationId}: ${validation.errors.join('; ')}`
            );
        }

        const timeout = params.timeout || registration.defaultTimeout;
        const handle = await adapter.start(registration, params);
        this.handles.set(params.instanceId, handle);
        this.auditSlugs.set(params.instanceId, params.auditSlug);

        // Set timeout
        if (timeout > 0) {
            setTimeout(() => {
                if (handle.status === 'running') {
                    console.log(`[AgentLifecycleManager] Agent ${params.instanceId} timed out after ${timeout}s`);
                    this.stop(params.instanceId);
                }
            }, timeout * 1000);
        }

        console.log(`[AgentLifecycleManager] Launched ${registrationId}: ${params.instanceId} (timeout: ${timeout}s)`);
        return handle;
    }

    /**
     * Launch an agent using the legacy AgentLaunchConfig format.
     * Converts to the new model and delegates to launchRegistered().
     * @param config - Legacy launch configuration
     * @returns Agent instance in the legacy format
     */
    async launch(config: AgentLaunchConfig): Promise<AgentInstance> {
        const params = convertLegacyLaunchConfig(config, this.mcpPort);
        const handle = await this.launchRegistered(config.definitionId, params);
        return this.handleToInstance(handle, config.auditSlug);
    }

    /**
     * Stop a running agent instance.
     * @param instanceId - Instance to stop
     */
    async stop(instanceId: string): Promise<void> {
        const handle = this.handles.get(instanceId);
        if (!handle) {
            throw new Error(`Agent instance not found: ${instanceId}`);
        }

        if (handle.status !== 'running' && handle.status !== 'starting') {
            return;
        }

        const registration = this.store.get(handle.registrationId);
        if (!registration) {
            throw new Error(`Registration not found for running instance: ${handle.registrationId}`);
        }

        const adapter = this.adapters.get(registration.execution.type);
        await adapter.stop(handle);
        console.log(`[AgentLifecycleManager] Stopped agent: ${instanceId}`);
    }

    /**
     * Get status of a specific agent instance (legacy format).
     * @param instanceId - Instance ID
     * @returns Agent instance or null
     */
    getStatus(instanceId: string): AgentInstance | null {
        const handle = this.handles.get(instanceId);
        if (!handle) return null;
        const auditSlug = this.auditSlugs.get(instanceId) || '';
        return this.handleToInstance(handle, auditSlug);
    }

    /**
     * Get the raw handle for an instance.
     * @param instanceId - Instance ID
     * @returns Agent handle or null
     */
    getHandle(instanceId: string): AgentHandle | null {
        return this.handles.get(instanceId) || null;
    }

    /**
     * Get outputs from a completed agent.
     * @param instanceId - Instance ID
     * @returns Outputs or null
     */
    async getOutputs(instanceId: string): Promise<AgentOutputData | null> {
        const handle = this.handles.get(instanceId);
        if (!handle) return null;

        const registration = this.store.get(handle.registrationId);
        if (!registration) return null;

        const adapter = this.adapters.get(registration.execution.type);
        return adapter.getOutputs(handle);
    }

    /**
     * List all agent instances, optionally filtered by audit.
     * @param auditSlug - Optional audit filter
     * @returns Array of agent instances
     */
    listInstances(auditSlug?: string): AgentInstance[] {
        const instances: AgentInstance[] = [];
        for (const [instanceId, handle] of this.handles) {
            const slug = this.auditSlugs.get(instanceId) || '';
            if (auditSlug && slug !== auditSlug) continue;
            instances.push(this.handleToInstance(handle, slug));
        }
        return instances;
    }

    /**
     * Get count of currently running agents.
     * @returns Number of running agents
     */
    getRunningCount(): number {
        return [...this.handles.values()].filter(
            h => h.status === 'running' || h.status === 'starting'
        ).length;
    }

    /**
     * Stop all running agents (for shutdown).
     */
    async stopAll(): Promise<void> {
        const running = [...this.handles.entries()].filter(
            ([_, h]) => h.status === 'running' || h.status === 'starting'
        );
        for (const [id] of running) {
            await this.stop(id);
        }
    }

    // ========================================================================
    // PRIVATE HELPERS
    // ========================================================================

    /**
     * Convert an AgentHandle to the legacy AgentInstance format.
     * Maintains backwards compatibility with REST API consumers.
     */
    private handleToInstance(handle: AgentHandle, auditSlug: string): AgentInstance {
        return {
            instanceId: handle.instanceId,
            definitionId: handle.registrationId,
            auditSlug,
            status: handle.status,
            pid: handle.pid,
            startedAt: handle.startedAt,
            completedAt: handle.completedAt,
            exitCode: handle.exitCode,
            error: handle.error,
        };
    }
}
