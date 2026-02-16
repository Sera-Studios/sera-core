/**
 * @fileoverview Registry mapping framework names to compiler instances
 * @module sera-core/compiler/CompilerRegistry
 */

import type { PipelineCompiler } from './CompilerInterface';

/**
 * Registry of pipeline compilers keyed by framework name.
 */
export class CompilerRegistry {
    private compilers = new Map<string, PipelineCompiler>();

    /**
     * Register a compiler for a framework.
     * @param compiler - Compiler instance
     */
    register(compiler: PipelineCompiler): void {
        this.compilers.set(compiler.framework, compiler);
    }

    /**
     * Get the compiler for a given framework.
     * @param framework - Framework identifier
     * @returns Compiler instance
     * @throws If no compiler is registered for the framework
     */
    getCompiler(framework: string): PipelineCompiler {
        const compiler = this.compilers.get(framework);
        if (!compiler) {
            const available = Array.from(this.compilers.keys()).join(', ');
            throw new Error(
                `No compiler registered for framework '${framework}'. Available: ${available || 'none'}`
            );
        }
        return compiler;
    }

    /**
     * List registered framework names.
     */
    listFrameworks(): string[] {
        return Array.from(this.compilers.keys());
    }
}
