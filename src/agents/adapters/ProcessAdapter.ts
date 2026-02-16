/**
 * @fileoverview Process Execution Adapter (stub)
 * @module sera-core/agents/adapters/ProcessAdapter
 *
 * Stub implementation for running agents as local subprocesses.
 * Will be implemented when the first process-based agent is ready.
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

export class ProcessAdapter implements ExecutionAdapter {
    readonly type = 'process' as const;

    async start(_registration: AgentRegistration, _params: AgentLaunchParams): Promise<AgentHandle> {
        throw new Error('Process adapter not yet implemented');
    }

    getStatus(handle: AgentHandle): AgentStatus {
        return handle.status;
    }

    async stop(_handle: AgentHandle, _gracePeriodMs?: number): Promise<void> {
        throw new Error('Process adapter not yet implemented');
    }

    async getOutputs(_handle: AgentHandle): Promise<AgentOutputData> {
        throw new Error('Process adapter not yet implemented');
    }

    async validate(_registration: AgentRegistration): Promise<AdapterValidationResult> {
        return {
            valid: false,
            errors: ['Process execution not yet available'],
            warnings: [],
        };
    }
}
