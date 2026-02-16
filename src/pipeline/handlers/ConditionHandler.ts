/**
 * @fileoverview Condition handler - evaluates branching expressions
 * @module sera-core/pipeline/handlers/ConditionHandler
 */

import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';
import type { NodeHandler } from './NodeHandler';

/**
 * Evaluates a condition expression against inputs.
 * The expression result determines which conditional edges fire.
 */
export class ConditionHandler implements NodeHandler {
    async execute(node: PipelineNode, inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput> {
        const expression = (node.config.expression as string) ?? 'true';

        // Flatten inputs for expression evaluation
        const flatInputs: Record<string, unknown> = {};
        for (const [key, output] of Object.entries(inputs)) {
            flatInputs[key] = output.data;
        }

        let result: boolean;
        try {
            // Expression authored by pipeline creator, not untrusted input
            const fn = new Function('inputs', 'variables', `return Boolean(${expression})`);
            result = fn(flatInputs, context.variables);
        } catch (err) {
            throw new Error(`Condition expression failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        return {
            type: 'boolean',
            data: { result },
            metadata: { expression, evaluatedTo: result },
        };
    }
}
