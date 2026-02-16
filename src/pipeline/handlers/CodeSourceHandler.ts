/**
 * @fileoverview Code source handler - loads source files from workspace
 * @module sera-core/pipeline/handlers/CodeSourceHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';
import type { NodeHandler } from './NodeHandler';

/**
 * Loads source code files from the audit workspace.
 * Supports glob-like file patterns for filtering.
 */
export class CodeSourceHandler implements NodeHandler {
    async execute(node: PipelineNode, _inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput> {
        const config = node.config;
        const workspacePath = context.workspacePath ?? '';
        const filePatterns = (config.filePatterns as string[]) ?? ['**/*.sol'];

        if (!workspacePath || !fs.existsSync(workspacePath)) {
            return {
                type: 'file-set',
                data: { files: [] },
                metadata: { error: `Workspace not found: ${workspacePath}` },
            };
        }

        const files: Array<{ path: string; content: string }> = [];
        this.walkDir(workspacePath, workspacePath, filePatterns, files);

        return {
            type: 'file-set',
            data: { files },
            metadata: { fileCount: files.length, workspacePath },
        };
    }

    private walkDir(
        dir: string,
        rootDir: string,
        patterns: string[],
        results: Array<{ path: string; content: string }>
    ): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(rootDir, fullPath);

            // Skip common non-source directories
            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'out', 'build', 'cache'].includes(entry.name)) continue;
                this.walkDir(fullPath, rootDir, patterns, results);
                continue;
            }

            if (entry.isFile() && this.matchesPatterns(relativePath, patterns)) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    results.push({ path: relativePath, content });
                } catch {
                    // Skip unreadable files
                }
            }
        }
    }

    private matchesPatterns(filePath: string, patterns: string[]): boolean {
        for (const pattern of patterns) {
            // Simple glob matching: ** matches dirs, * matches filenames
            const regex = pattern
                .replace(/\*\*/g, '.*')
                .replace(/\*/g, '[^/]*')
                .replace(/\./g, '\\.');
            if (new RegExp(`^${regex}$`).test(filePath)) return true;
        }
        return false;
    }
}
