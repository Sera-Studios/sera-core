/**
 * @fileoverview Node handler interface for pipeline execution
 * @module sera-core/pipeline/handlers/NodeHandler
 */

import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';

/**
 * Interface implemented by each node type handler.
 * Handlers are stateless - all state flows through inputs and context.
 */
export interface NodeHandler {
    /**
     * Execute a pipeline node.
     * @param node - The pipeline node definition
     * @param inputs - Resolved inputs from upstream nodes
     * @param context - Execution context with run metadata and services
     * @returns Output produced by this node
     */
    execute(node: PipelineNode, inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput>;
}
