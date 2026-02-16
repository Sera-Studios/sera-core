/**
 * @fileoverview Execution Adapter interface
 * @module sera-core/agents/adapters/ExecutionAdapter
 *
 * Standard lifecycle interface for all execution adapters.
 * Each execution type (docker, process, claude-code, script) implements this.
 */

import {
    AgentRegistration,
    AgentLaunchParams,
    AgentHandle,
    AgentStatus,
    AgentOutputData,
    AdapterValidationResult,
    ExecutionType,
} from '@sera/types';

export interface ExecutionAdapter {
    /** Execution type this adapter handles */
    readonly type: ExecutionType;

    /**
     * Start an agent instance.
     * @param registration - The agent registration
     * @param params - Runtime parameters (workspace, audit, env vars, etc.)
     * @returns A running agent handle
     */
    start(registration: AgentRegistration, params: AgentLaunchParams): Promise<AgentHandle>;

    /**
     * Get the current status of a running agent.
     * @param handle - The agent handle from start()
     * @returns Current status
     */
    getStatus(handle: AgentHandle): AgentStatus;

    /**
     * Stop a running agent.
     * @param handle - The agent handle from start()
     * @param gracePeriodMs - How long to wait before force kill (default: 5000)
     */
    stop(handle: AgentHandle, gracePeriodMs?: number): Promise<void>;

    /**
     * Retrieve outputs from a completed agent.
     * @param handle - The agent handle from start()
     * @returns Collected outputs
     */
    getOutputs(handle: AgentHandle): Promise<AgentOutputData>;

    /**
     * Validate that the execution config is viable before attempting to start.
     * @param registration - The agent registration to validate
     * @returns Validation result with error details if invalid
     */
    validate(registration: AgentRegistration): Promise<AdapterValidationResult>;
}
