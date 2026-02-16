/**
 * @fileoverview Deterministic tool handler - runs external tools (slither, mythril, etc.)
 * @module sera-core/pipeline/handlers/DeterministicToolHandler
 */

import { spawn } from 'child_process';
import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';
import type { NodeHandler } from './NodeHandler';

/**
 * Spawns a deterministic tool (e.g. slither) as a subprocess
 * and captures its output.
 */
export class DeterministicToolHandler implements NodeHandler {
    async execute(node: PipelineNode, _inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput> {
        const toolName = (node.config.toolName as string) ?? '';
        const parameters = (node.config.parameters as Record<string, unknown>) ?? {};

        if (!toolName) {
            throw new Error('Deterministic tool node requires a toolName');
        }

        const args = this.buildArgs(toolName, parameters);
        const cwd = context.workspacePath ?? context.tempDir;

        const result = await this.runProcess(toolName, args, cwd);

        // Try to parse output as JSON
        let parsed: unknown;
        try {
            parsed = JSON.parse(result.stdout);
        } catch {
            parsed = result.stdout;
        }

        if (result.exitCode !== 0 && !(node.config.retryOnFailure as boolean)) {
            throw new Error(`Tool "${toolName}" exited with code ${result.exitCode}: ${result.stderr}`);
        }

        return {
            type: 'tool-output',
            data: { result: parsed, exitCode: result.exitCode },
            metadata: { toolName, stderr: result.stderr.slice(0, 2000) },
        };
    }

    private buildArgs(toolName: string, parameters: Record<string, unknown>): string[] {
        const args: string[] = [];
        for (const [key, value] of Object.entries(parameters)) {
            if (typeof value === 'boolean' && value) {
                args.push(`--${key}`);
            } else if (value !== undefined && value !== null && value !== false) {
                args.push(`--${key}`, String(value));
            }
        }
        return args;
    }

    private runProcess(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return new Promise((resolve) => {
            const proc = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
            proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                resolve({ stdout, stderr, exitCode: code ?? 1 });
            });

            proc.on('error', (err) => {
                resolve({ stdout, stderr: err.message, exitCode: 1 });
            });
        });
    }
}
