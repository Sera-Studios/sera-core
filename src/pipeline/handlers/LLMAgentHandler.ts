/**
 * @fileoverview LLM agent handler - launches Claude Code agents via AgentLifecycleManager
 * @module sera-core/pipeline/handlers/LLMAgentHandler
 */

import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';
import type { AgentLifecycleManager } from '../../agents/AgentLifecycleManager';
import type { NodeHandler } from './NodeHandler';

/**
 * Launches an LLM agent (Claude Code subprocess) and waits for completion.
 * Uses the existing AgentLifecycleManager for agent lifecycle.
 */
export class LLMAgentHandler implements NodeHandler {
    private agentManager: AgentLifecycleManager;

    constructor(agentManager: AgentLifecycleManager) {
        this.agentManager = agentManager;
    }

    async execute(node: PipelineNode, inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput> {
        const config = node.config;
        const definitionId = (config.roleFile as string)?.replace('.md', '') ?? 'hunter';
        const timeout = (config.timeout as number) ?? 10800;

        // Serialize inputs as a custom prompt addition
        const inputSummary = this.formatInputs(inputs);

        const instance = await this.agentManager.launch({
            definitionId,
            auditSlug: context.auditSlug,
            workspacePath: context.workspacePath ?? '',
            customPrompt: inputSummary,
            timeout,
        });

        // Poll for completion
        const pollInterval = 5000;
        const maxWait = timeout * 1000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
            const status = this.agentManager.getStatus(instance.instanceId);
            if (!status) break;

            if (status.status === 'completed') {
                const outputs = await this.agentManager.getOutputs(instance.instanceId);
                return {
                    type: 'findings',
                    data: {
                        findings: [],
                        logs: outputs?.stdout ?? '',
                        exitCode: outputs?.exitCode ?? 0,
                    },
                    metadata: {
                        instanceId: instance.instanceId,
                        definitionId,
                        completedAt: status.completedAt,
                    },
                };
            }

            if (status.status === 'failed' || status.status === 'stopped') {
                throw new Error(`Agent ${instance.instanceId} ${status.status}: ${status.error ?? 'unknown error'}`);
            }

            await this.sleep(pollInterval);
        }

        // Timeout - stop the agent
        try { await this.agentManager.stop(instance.instanceId); } catch { /* best effort */ }
        throw new Error(`Agent ${instance.instanceId} timed out after ${timeout}s`);
    }

    private formatInputs(inputs: NodeInput): string {
        const parts: string[] = [];
        for (const [key, output] of Object.entries(inputs)) {
            if (output.type === 'file-set') {
                const files = (output.data as { files: Array<{ path: string }> }).files;
                parts.push(`Input "${key}": ${files.length} source files loaded`);
            } else if (output.type === 'text') {
                const content = (output.data as { content: string }).content;
                parts.push(`Input "${key}" context:\n${content.slice(0, 5000)}`);
            } else {
                parts.push(`Input "${key}": ${JSON.stringify(output.data).slice(0, 1000)}`);
            }
        }
        return parts.length > 0 ? `\n\n---\nPipeline inputs:\n${parts.join('\n\n')}` : '';
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
