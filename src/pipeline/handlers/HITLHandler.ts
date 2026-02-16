/**
 * @fileoverview Human-in-the-loop handler - pauses for manual approval
 * @module sera-core/pipeline/handlers/HITLHandler
 */

import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext, PipelineExecutionEvent } from '@sera/types';
import type { NodeHandler } from './NodeHandler';

/** Callback for emitting pipeline events */
export type EventEmitter = (event: Omit<PipelineExecutionEvent, 'id' | 'timestamp'>) => void;

/**
 * Pauses pipeline execution and waits for human approval.
 * Emits hitl:waiting event, then blocks until approved/rejected/timed out.
 */
export class HITLHandler implements NodeHandler {
    private emitEvent: EventEmitter;
    private pendingApprovals: Map<string, {
        resolve: (approved: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = new Map();

    constructor(emitEvent: EventEmitter) {
        this.emitEvent = emitEvent;
    }

    async execute(node: PipelineNode, inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput> {
        const prompt = (node.config.prompt as string) ?? 'Approve to continue';
        const timeoutMinutes = (node.config.timeoutMinutes as number) ?? 60;
        const autoApprove = (node.config.autoApprove as boolean) ?? false;
        const showInputData = (node.config.showInputData as boolean) ?? true;

        // Auto-approve for testing/CI
        if (autoApprove) {
            return {
                type: 'approval',
                data: { approved: true, autoApproved: true },
                metadata: { prompt },
            };
        }

        // Emit waiting event
        this.emitEvent({
            runId: context.runId,
            type: 'hitl:waiting',
            nodeId: node.id,
            payload: {
                prompt,
                inputSummary: showInputData ? this.summarizeInputs(inputs) : undefined,
            },
        });

        // Wait for approval
        const approved = await this.waitForApproval(
            `${context.runId}:${node.id}`,
            timeoutMinutes * 60 * 1000
        );

        // Emit result event
        this.emitEvent({
            runId: context.runId,
            type: approved ? 'hitl:approved' : 'hitl:rejected',
            nodeId: node.id,
        });

        if (!approved) {
            throw new Error('HITL review rejected');
        }

        return {
            type: 'approval',
            data: { approved: true },
            metadata: { prompt },
        };
    }

    /**
     * Resolve a pending HITL approval from an external source (REST API).
     * @param key - Format: "runId:nodeId"
     * @param approved - Whether the review was approved
     */
    resolveApproval(key: string, approved: boolean): boolean {
        const pending = this.pendingApprovals.get(key);
        if (!pending) return false;
        clearTimeout(pending.timer);
        pending.resolve(approved);
        this.pendingApprovals.delete(key);
        return true;
    }

    private waitForApproval(key: string, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingApprovals.delete(key);
                resolve(false);
            }, timeoutMs);

            this.pendingApprovals.set(key, { resolve, timer });
        });
    }

    private summarizeInputs(inputs: NodeInput): string {
        const parts: string[] = [];
        for (const [key, output] of Object.entries(inputs)) {
            parts.push(`${key} (${output.type}): ${JSON.stringify(output.data).slice(0, 500)}`);
        }
        return parts.join('\n');
    }
}
