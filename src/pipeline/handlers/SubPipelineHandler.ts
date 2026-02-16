/**
 * @fileoverview Sub-pipeline handler - recursive pipeline execution
 * @module sera-core/pipeline/handlers/SubPipelineHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PipelineNode, PipelineSpec, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';
import type { NodeHandler } from './NodeHandler';

/**
 * Executes a nested pipeline by loading its spec and delegating to PipelineEngine.
 * Prevents infinite recursion via a depth counter.
 */
export class SubPipelineHandler implements NodeHandler {
    private executeFunc: (spec: PipelineSpec, variables: Record<string, unknown>, auditSlug: string, depth: number) => Promise<NodeOutput>;
    private currentDepth: number;

    constructor(
        executeFunc: (spec: PipelineSpec, variables: Record<string, unknown>, auditSlug: string, depth: number) => Promise<NodeOutput>,
        currentDepth: number = 0
    ) {
        this.executeFunc = executeFunc;
        this.currentDepth = currentDepth;
    }

    async execute(node: PipelineNode, _inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput> {
        const pipelineId = (node.config.pipelineId as string) ?? '';
        const maxDepth = (node.config.maxRecursionDepth as number) ?? 3;
        const variableMappings = (node.config.variableMappings as Record<string, string>) ?? {};

        if (!pipelineId) {
            throw new Error('Sub-pipeline node requires a pipelineId or file path');
        }

        if (this.currentDepth >= maxDepth) {
            throw new Error(`Max recursion depth (${maxDepth}) reached for sub-pipeline "${pipelineId}"`);
        }

        // Load sub-pipeline spec
        const spec = this.loadSpec(pipelineId, context.workspacePath ?? '');

        // Resolve variable mappings
        const variables: Record<string, unknown> = {};
        for (const [varName, expression] of Object.entries(variableMappings)) {
            try {
                // Expression authored by pipeline creator
                const fn = new Function('variables', `return ${expression}`);
                variables[varName] = fn(context.variables);
            } catch {
                variables[varName] = expression;
            }
        }

        return this.executeFunc(spec, variables, context.auditSlug, this.currentDepth + 1);
    }

    private loadSpec(pipelineId: string, workspacePath: string): PipelineSpec {
        // Try as file path first
        const filePath = path.isAbsolute(pipelineId)
            ? pipelineId
            : path.join(workspacePath, pipelineId);

        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as PipelineSpec;
        }

        // Try with .pipeline.json extension
        const withExt = filePath.endsWith('.json') ? filePath : `${filePath}.pipeline.json`;
        if (fs.existsSync(withExt)) {
            const content = fs.readFileSync(withExt, 'utf-8');
            return JSON.parse(content) as PipelineSpec;
        }

        throw new Error(`Sub-pipeline spec not found: ${pipelineId}`);
    }
}
