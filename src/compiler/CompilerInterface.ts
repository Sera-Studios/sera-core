/**
 * @fileoverview Pipeline compiler interface
 * @module sera-core/compiler/CompilerInterface
 *
 * Defines the contract for framework-specific pipeline compilers.
 * Each compiler takes a PipelineSpec and generates executable code.
 */

import type { PipelineSpec } from '@sera/types';

/**
 * Result of compiling a pipeline spec to executable code.
 */
export interface CompilerResult {
    /** Generated main script content */
    script: string;
    /** Script filename (e.g. 'pipeline.py') */
    scriptFilename: string;
    /** Additional files to write alongside the script */
    files: Array<{ name: string; content: string }>;
    /** Warnings encountered during compilation */
    warnings: string[];
}

/**
 * Interface for framework-specific pipeline compilers.
 * Each compiler translates a PipelineSpec into runnable code for its target framework.
 */
export interface PipelineCompiler {
    /** Framework identifier (e.g. 'pydantic-ai', 'langgraph') */
    readonly framework: string;

    /**
     * Compile a pipeline spec into executable code.
     * @param spec - Pipeline specification from the visual editor
     * @param variables - Runtime variable overrides
     * @returns Generated code and supporting files
     */
    compile(spec: PipelineSpec, variables?: Record<string, unknown>): CompilerResult;
}
