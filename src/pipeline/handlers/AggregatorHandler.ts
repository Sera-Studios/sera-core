/**
 * @fileoverview Aggregator handler - merges results from multiple upstream nodes
 * @module sera-core/pipeline/handlers/AggregatorHandler
 */

import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';
import type { NodeHandler } from './NodeHandler';

/**
 * Aggregates outputs from multiple upstream nodes using configurable strategies.
 */
export class AggregatorHandler implements NodeHandler {
    async execute(node: PipelineNode, inputs: NodeInput, _context: NodeExecutionContext): Promise<NodeOutput> {
        const strategy = (node.config.strategy as string) ?? 'concat';
        const inputValues = Object.values(inputs).map(o => o.data);

        let items: unknown[];

        switch (strategy) {
            case 'concat':
                items = this.concat(inputValues);
                break;
            case 'deduplicate': {
                const key = (node.config.deduplicationKey as string) ?? 'id';
                items = this.deduplicate(inputValues, key);
                break;
            }
            case 'vote':
                items = this.vote(inputValues);
                break;
            case 'custom': {
                const expression = (node.config.mergeExpression as string) ?? 'inputs';
                items = this.custom(inputValues, expression);
                break;
            }
            default:
                items = this.concat(inputValues);
        }

        return {
            type: 'aggregated',
            data: { items },
            metadata: { strategy, inputCount: inputValues.length, outputCount: items.length },
        };
    }

    private concat(values: unknown[]): unknown[] {
        const result: unknown[] = [];
        for (const val of values) {
            if (Array.isArray(val)) {
                result.push(...val);
            } else if (val && typeof val === 'object' && 'items' in val) {
                result.push(...(val as { items: unknown[] }).items);
            } else {
                result.push(val);
            }
        }
        return result;
    }

    private deduplicate(values: unknown[], key: string): unknown[] {
        const all = this.concat(values);
        const seen = new Set<string>();
        const result: unknown[] = [];
        for (const item of all) {
            const itemKey = item && typeof item === 'object' ? String((item as Record<string, unknown>)[key] ?? '') : String(item);
            if (!seen.has(itemKey)) {
                seen.add(itemKey);
                result.push(item);
            }
        }
        return result;
    }

    private vote(values: unknown[]): unknown[] {
        // Simple majority: count occurrences by JSON serialization
        const counts = new Map<string, { count: number; value: unknown }>();
        for (const val of values) {
            const key = JSON.stringify(val);
            const entry = counts.get(key);
            if (entry) {
                entry.count++;
            } else {
                counts.set(key, { count: 1, value: val });
            }
        }

        // Return items sorted by vote count (descending)
        return [...counts.values()]
            .sort((a, b) => b.count - a.count)
            .map(e => e.value);
    }

    private custom(values: unknown[], expression: string): unknown[] {
        try {
            // Expression authored by pipeline creator, not untrusted input
            const fn = new Function('inputs', `return ${expression}`);
            const result = fn(values);
            return Array.isArray(result) ? result : [result];
        } catch (err) {
            throw new Error(`Custom merge expression failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
