/**
 * @fileoverview Build pipeline for packaging agent pipelines
 * @module sera-core/packaging/BuildPipeline
 *
 * Orchestrates the full build process: validate spec, generate artifacts
 * (Dockerfile, entrypoint, manifest), write to output dir, and optionally
 * run docker build.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { PipelineSpec, BuildResult, PackagingFormat } from '@sera/types';
import { generateDockerfileFromSpec } from './DockerfileGenerator';
import { generateEntrypoint } from './EntrypointGenerator';
import { generateManifest } from './ManifestGenerator';
import { CompilerRegistry } from '../compiler/CompilerRegistry';
import { PydanticAICompiler } from '../compiler/PydanticAICompiler';

export interface BuildOptions {
    /** Docker image tag */
    tag?: string;
    /** Push to registry after build */
    push?: boolean;
    /** Generate files without building */
    dryRun?: boolean;
    /** Output format */
    format?: PackagingFormat;
    /** Output directory (defaults to temp dir) */
    outputDir?: string;
}

/**
 * Build a packaged pipeline from a spec.
 * @param spec - Pipeline specification
 * @param options - Build options
 * @returns Build result
 */
export async function build(spec: PipelineSpec, options: BuildOptions = {}): Promise<BuildResult> {
    const format = options.format ?? 'docker';
    const warnings: string[] = [];

    // Validate spec
    if (!spec.id || !spec.name || !spec.version) {
        return { success: false, format, warnings: ['Pipeline spec must have id, name, and version'] };
    }
    if (!spec.nodes || spec.nodes.length === 0) {
        return { success: false, format, warnings: ['Pipeline spec must have at least one node'] };
    }
    if (!spec.entryNodeId) {
        return { success: false, format, warnings: ['Pipeline spec must have an entryNodeId'] };
    }

    // Create output directory
    const outputDir = options.outputDir ?? path.join(os.tmpdir(), 'sera-build', `${spec.id}-${Date.now()}`);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write pipeline spec
    fs.writeFileSync(
        path.join(outputDir, 'pipeline.json'),
        JSON.stringify(spec, null, 2),
        'utf-8'
    );

    // Generate manifest
    const manifest = generateManifest(spec, format);
    fs.writeFileSync(
        path.join(outputDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
    );

    // Generate executable code
    const framework = spec.framework;
    if (framework) {
        // Use compiler to generate Python script
        const registry = new CompilerRegistry();
        registry.register(new PydanticAICompiler());

        const compiler = registry.getCompiler(framework);
        const compiled = compiler.compile(spec);

        if (compiled.warnings.length > 0) {
            warnings.push(...compiled.warnings);
        }

        // Write compiled script and supporting files
        fs.writeFileSync(path.join(outputDir, compiled.scriptFilename), compiled.script, 'utf-8');
        for (const file of compiled.files) {
            fs.writeFileSync(path.join(outputDir, file.name), file.content, 'utf-8');
        }
    } else {
        // Legacy: generate Node.js entrypoint for specs without a framework
        const entrypoint = generateEntrypoint(spec);
        fs.writeFileSync(path.join(outputDir, 'entrypoint.js'), entrypoint, 'utf-8');

        const packageJson = {
            name: `sera-pipeline-${spec.id}`,
            version: spec.version,
            private: true,
            main: 'entrypoint.js',
        };
        fs.writeFileSync(
            path.join(outputDir, 'package.json'),
            JSON.stringify(packageJson, null, 2),
            'utf-8'
        );
    }

    if (format === 'docker') {
        // Generate Dockerfile
        const dockerfile = generateDockerfileFromSpec(spec);
        fs.writeFileSync(path.join(outputDir, 'Dockerfile'), dockerfile, 'utf-8');

        if (!options.dryRun) {
            const tag = options.tag ?? `sera-pipeline/${spec.id}:${spec.version}`;
            try {
                execSync(`docker build -t ${tag} .`, { cwd: outputDir, stdio: 'inherit' });

                if (options.push) {
                    execSync(`docker push ${tag}`, { cwd: outputDir, stdio: 'inherit' });
                }

                return {
                    success: true,
                    format,
                    imageTag: tag,
                    artifactPath: outputDir,
                    warnings,
                };
            } catch (err) {
                return {
                    success: false,
                    format,
                    artifactPath: outputDir,
                    warnings: [...warnings, `Docker build failed: ${err instanceof Error ? err.message : String(err)}`],
                };
            }
        }
    }

    // For process/script formats or dry run, just return the output dir
    console.log(`Build artifacts written to: ${outputDir}`);
    console.log(`Files:`);
    for (const file of fs.readdirSync(outputDir)) {
        const stat = fs.statSync(path.join(outputDir, file));
        console.log(`  ${file} (${stat.size} bytes)`);
    }

    return {
        success: true,
        format,
        artifactPath: outputDir,
        warnings,
    };
}
