/**
 * @fileoverview Handler registry mapping node types to handlers
 * @module sera-core/pipeline/handlers
 */

import type { PipelineNodeType } from '@sera/types';
import type { NodeHandler } from './NodeHandler';
import type { AgentLifecycleManager } from '../../agents/AgentLifecycleManager';
import type { EventEmitter } from './HITLHandler';
import { CodeSourceHandler } from './CodeSourceHandler';
import { ContextLoaderHandler } from './ContextLoaderHandler';
import { LLMAgentHandler } from './LLMAgentHandler';
import { DeterministicToolHandler } from './DeterministicToolHandler';
import { ConditionHandler } from './ConditionHandler';
import { AggregatorHandler } from './AggregatorHandler';
import { SubPipelineHandler } from './SubPipelineHandler';
import { HITLHandler } from './HITLHandler';
import { OutputFormatHandler } from './OutputFormatHandler';

import type { PipelineSpec, NodeOutput } from '@sera/types';

/**
 * Registry that maps PipelineNodeType to NodeHandler instances.
 * Constructed with all required dependencies.
 */
export class HandlerRegistry {
    private handlers: Map<PipelineNodeType, NodeHandler> = new Map();
    private hitlHandler: HITLHandler;

    constructor(
        agentManager: AgentLifecycleManager,
        emitEvent: EventEmitter,
        subPipelineExecute: (spec: PipelineSpec, variables: Record<string, unknown>, auditSlug: string, depth: number) => Promise<NodeOutput>
    ) {
        this.hitlHandler = new HITLHandler(emitEvent);

        this.handlers.set('code-source', new CodeSourceHandler());
        this.handlers.set('context-loader', new ContextLoaderHandler());
        this.handlers.set('llm-agent', new LLMAgentHandler(agentManager));
        this.handlers.set('deterministic-tool', new DeterministicToolHandler());
        this.handlers.set('condition', new ConditionHandler());
        this.handlers.set('aggregator', new AggregatorHandler());
        this.handlers.set('sub-pipeline', new SubPipelineHandler(subPipelineExecute));
        this.handlers.set('human-in-the-loop', this.hitlHandler);
        this.handlers.set('output-format', new OutputFormatHandler());
    }

    /**
     * Get the handler for a node type.
     * @param type - Pipeline node type
     * @returns The handler, or throws if unknown type
     */
    get(type: PipelineNodeType): NodeHandler {
        const handler = this.handlers.get(type);
        if (!handler) {
            throw new Error(`No handler registered for node type: ${type}`);
        }
        return handler;
    }

    /**
     * Get the HITL handler for resolving approvals.
     */
    getHITLHandler(): HITLHandler {
        return this.hitlHandler;
    }
}
