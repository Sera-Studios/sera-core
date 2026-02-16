/**
 * @fileoverview Docker Execution Adapter (stub)
 * @module sera-core/agents/adapters/DockerAdapter
 *
 * Stub implementation for running agents as Docker containers.
 * Will be implemented when the first Docker-based agent is ready.
 */

import {
    AgentRegistration,
    AgentLaunchParams,
    AgentHandle,
    AgentStatus,
    AgentOutputData,
    AdapterValidationResult,
} from '@sera/types';
import { ExecutionAdapter } from './ExecutionAdapter';

export class DockerAdapter implements ExecutionAdapter {
    readonly type = 'docker' as const;

    async start(_registration: AgentRegistration, _params: AgentLaunchParams): Promise<AgentHandle> {
        throw new Error('Docker adapter not yet implemented');
    }

    getStatus(handle: AgentHandle): AgentStatus {
        return handle.status;
    }

    async stop(_handle: AgentHandle, _gracePeriodMs?: number): Promise<void> {
        throw new Error('Docker adapter not yet implemented');
    }

    async getOutputs(_handle: AgentHandle): Promise<AgentOutputData> {
        throw new Error('Docker adapter not yet implemented');
    }

    async validate(_registration: AgentRegistration): Promise<AdapterValidationResult> {
        return {
            valid: false,
            errors: ['Docker execution not yet available'],
            warnings: [],
        };
    }
}
