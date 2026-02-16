/**
 * @fileoverview Context loader handler - loads additional context (primers, files)
 * @module sera-core/pipeline/handlers/ContextLoaderHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';
import type { NodeHandler } from './NodeHandler';

interface ContextSource {
    type: 'file' | 'primer' | 'findings';
    path: string;
}

/**
 * Loads context from configured sources (primers, CLAUDE.md, previous findings).
 * Concatenates all loaded content into a single text output.
 */
export class ContextLoaderHandler implements NodeHandler {
    async execute(node: PipelineNode, inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput> {
        const sources = (node.config.sources as ContextSource[]) ?? [];
        const maxTokens = (node.config.maxTokens as number) ?? Infinity;
        const parts: string[] = [];

        // Include upstream file data if available
        const upstreamFiles = inputs.default?.data as { files?: Array<{ path: string; content: string }> } | undefined;
        if (upstreamFiles?.files) {
            for (const file of upstreamFiles.files) {
                parts.push(`## ${file.path}\n\`\`\`\n${file.content}\n\`\`\``);
            }
        }

        for (const source of sources) {
            const content = this.loadSource(source, context.workspacePath ?? '');
            if (content) parts.push(content);
        }

        let combined = parts.join('\n\n');
        // Rough token limit (4 chars per token approximation)
        if (combined.length > maxTokens * 4) {
            combined = combined.slice(0, maxTokens * 4);
        }

        return {
            type: 'text',
            data: { content: combined },
            metadata: { sourceCount: sources.length, charCount: combined.length },
        };
    }

    private loadSource(source: ContextSource, workspacePath: string): string | null {
        const resolvedPath = path.isAbsolute(source.path)
            ? source.path
            : path.join(workspacePath, source.path);

        try {
            if (fs.existsSync(resolvedPath)) {
                return fs.readFileSync(resolvedPath, 'utf-8');
            }
        } catch {
            // Skip unreadable sources
        }
        return null;
    }
}
