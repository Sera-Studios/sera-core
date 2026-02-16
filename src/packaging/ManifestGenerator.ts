/**
 * @fileoverview Manifest generator for packaged pipelines
 * @module sera-core/packaging/ManifestGenerator
 *
 * Generates an AgentManifest from a PipelineSpec, deriving execution
 * config, tool requirements, and variable definitions.
 */

import type { PipelineSpec, AgentManifest, PackagingFormat } from '@sera/types';

/**
 * Generate an AgentManifest from a pipeline spec.
 * @param spec - Pipeline specification
 * @param format - Target packaging format
 * @returns Generated manifest
 */
export function generateManifest(spec: PipelineSpec, format: PackagingFormat): AgentManifest {
    // Collect unique tools from all nodes
    const tools = new Set<string>();
    for (const node of spec.nodes) {
        if (node.type === 'deterministic-tool') {
            const toolName = node.config.toolName as string;
            if (toolName) tools.add(toolName);
        }
        if (node.type === 'llm-agent') {
            const nodeTools = node.config.tools as string[] | undefined;
            if (nodeTools) {
                for (const t of nodeTools) tools.add(t);
            }
        }
    }

    // Build variable definitions
    const variables: AgentManifest['variables'] = {};
    if (spec.variables) {
        for (const [key, def] of Object.entries(spec.variables)) {
            variables[key] = {
                type: def.type,
                required: def.default === undefined,
                default: def.default,
            };
        }
    }

    // Derive environment variables
    const environment: Record<string, string> = {
        SERA_CORE_HOST: 'localhost',
        SERA_CORE_PORT: '9800',
    };

    return {
        name: spec.name,
        version: spec.version,
        format,
        pipelineSpec: 'pipeline.json',
        execution: {
            type: format,
            config: getExecutionConfig(format),
        },
        environment,
        tools: Array.from(tools),
        variables,
    };
}

function getExecutionConfig(format: PackagingFormat): Record<string, unknown> {
    switch (format) {
        case 'docker':
            return { network: 'host', restartPolicy: 'no' };
        case 'process':
            return { command: 'node', args: ['entrypoint.js'] };
        case 'script':
            return { interpreter: 'node', script: 'entrypoint.js' };
    }
}
