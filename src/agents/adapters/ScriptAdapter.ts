/**
 * @fileoverview Script Execution Adapter (stub)
 * @module sera-core/agents/adapters/ScriptAdapter
 *
 * Stub implementation for running agents as single script files.
 * Will be implemented when the first script-based agent is ready.
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

export class ScriptAdapter implements ExecutionAdapter {
    readonly type = 'script' as const;

    async start(_registration: AgentRegistration, _params: AgentLaunchParams): Promise<AgentHandle> {
        throw new Error('Script adapter not yet implemented');
    }

    getStatus(handle: AgentHandle): AgentStatus {
        return handle.status;
    }

    async stop(_handle: AgentHandle, _gracePeriodMs?: number): Promise<void> {
        throw new Error('Script adapter not yet implemented');
    }

    async getOutputs(_handle: AgentHandle): Promise<AgentOutputData> {
        throw new Error('Script adapter not yet implemented');
    }

    async validate(_registration: AgentRegistration): Promise<AdapterValidationResult> {
        return {
            valid: false,
            errors: ['Script execution not yet available'],
            warnings: [],
        };
    }
}
