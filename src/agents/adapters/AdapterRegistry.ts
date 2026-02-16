/**
 * @fileoverview Adapter Registry
 * @module sera-core/agents/adapters/AdapterRegistry
 *
 * Registry of execution adapters keyed by execution type.
 * sera-core registers adapters at startup; the lifecycle manager
 * looks them up when launching agents.
 */

import { ExecutionType } from '@sera/types';
import { ExecutionAdapter } from './ExecutionAdapter';

export class AdapterRegistry {
    private adapters: Map<ExecutionType, ExecutionAdapter> = new Map();

    /**
     * Register an execution adapter.
     * @param adapter - Adapter to register
     */
    register(adapter: ExecutionAdapter): void {
        this.adapters.set(adapter.type, adapter);
    }

    /**
     * Get the adapter for a given execution type.
     * @param type - Execution type
     * @returns The registered adapter
     * @throws Error if no adapter is registered for the type
     */
    get(type: ExecutionType): ExecutionAdapter {
        const adapter = this.adapters.get(type);
        if (!adapter) {
            throw new Error(
                `No execution adapter registered for type: ${type}. ` +
                `Available: ${[...this.adapters.keys()].join(', ')}`
            );
        }
        return adapter;
    }

    /**
     * Check if an adapter exists for a given type.
     * @param type - Execution type
     * @returns true if an adapter is registered
     */
    has(type: ExecutionType): boolean {
        return this.adapters.has(type);
    }

    /**
     * List all registered execution types.
     * @returns Array of registered execution types
     */
    listTypes(): ExecutionType[] {
        return [...this.adapters.keys()];
    }
}
