/**
 * @fileoverview Output format handler - formats pipeline results
 * @module sera-core/pipeline/handlers/OutputFormatHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PipelineNode, NodeInput, NodeOutput, NodeExecutionContext } from '@sera/types';
import type { NodeHandler } from './NodeHandler';

/**
 * Formats collected pipeline outputs into the desired format.
 * Supports JSON, markdown, text, and notepad-issues formats.
 */
export class OutputFormatHandler implements NodeHandler {
    async execute(node: PipelineNode, inputs: NodeInput, context: NodeExecutionContext): Promise<NodeOutput> {
        const format = (node.config.format as string) ?? 'json';
        const template = (node.config.template as string) ?? '';
        const outputPath = (node.config.outputPath as string) ?? '';

        // Collect all input data
        const allData: unknown[] = [];
        for (const output of Object.values(inputs)) {
            allData.push(output.data);
        }

        let content: string;
        switch (format) {
            case 'json':
                content = JSON.stringify(allData.length === 1 ? allData[0] : allData, null, 2);
                break;
            case 'markdown':
                content = template ? this.applyTemplate(template, allData) : this.toMarkdown(allData);
                break;
            case 'text':
                content = template ? this.applyTemplate(template, allData) : this.toText(allData);
                break;
            case 'notepad-issues':
                content = JSON.stringify(this.toNotepadIssues(allData), null, 2);
                break;
            default:
                content = JSON.stringify(allData, null, 2);
        }

        // Write to file if outputPath configured
        if (outputPath) {
            const resolved = path.isAbsolute(outputPath)
                ? outputPath
                : path.join(context.tempDir, outputPath);
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolved, content, 'utf-8');
        }

        return {
            type: 'formatted',
            data: { content, format },
            metadata: { charCount: content.length, outputPath: outputPath || undefined },
        };
    }

    private applyTemplate(template: string, data: unknown[]): string {
        // Simple template replacement: {{data}} -> JSON, {{count}} -> length
        return template
            .replace(/\{\{data\}\}/g, JSON.stringify(data, null, 2))
            .replace(/\{\{count\}\}/g, String(data.length));
    }

    private toMarkdown(data: unknown[]): string {
        const sections: string[] = ['# Pipeline Output\n'];
        for (const item of data) {
            if (typeof item === 'string') {
                sections.push(item);
            } else {
                sections.push('```json\n' + JSON.stringify(item, null, 2) + '\n```');
            }
        }
        return sections.join('\n\n');
    }

    private toText(data: unknown[]): string {
        return data.map(item =>
            typeof item === 'string' ? item : JSON.stringify(item, null, 2)
        ).join('\n\n');
    }

    private toNotepadIssues(data: unknown[]): unknown[] {
        // Extract findings arrays from data
        const issues: unknown[] = [];
        for (const item of data) {
            if (Array.isArray(item)) {
                issues.push(...item);
            } else if (item && typeof item === 'object') {
                const obj = item as Record<string, unknown>;
                if (Array.isArray(obj.findings)) {
                    issues.push(...obj.findings);
                } else if (Array.isArray(obj.items)) {
                    issues.push(...obj.items);
                } else {
                    issues.push(obj);
                }
            }
        }
        return issues;
    }
}
