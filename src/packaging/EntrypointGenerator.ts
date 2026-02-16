/**
 * @fileoverview Entrypoint script generator for packaged pipelines
 * @module sera-core/packaging/EntrypointGenerator
 *
 * Generates a Node.js entrypoint script that:
 * - Parses CLI args as pipeline variables
 * - Loads the pipeline spec from pipeline.json
 * - Connects to sera-core MCP to execute the pipeline
 * - Streams events to stdout
 * - Exits with appropriate code
 */

import type { PipelineSpec } from '@sera/types';

/**
 * Generate entrypoint.js content for a packaged pipeline.
 */
export function generateEntrypoint(spec: PipelineSpec): string {
    const variableNames = spec.variables ? Object.keys(spec.variables) : [];

    return `#!/usr/bin/env node
/**
 * Auto-generated entrypoint for pipeline: ${spec.name}
 * Version: ${spec.version}
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Parse CLI arguments as --key=value pairs
function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const eqIdx = arg.indexOf('=');
            if (eqIdx !== -1) {
                args[arg.substring(2, eqIdx)] = arg.substring(eqIdx + 1);
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                args[arg.substring(2)] = argv[++i];
            } else {
                args[arg.substring(2)] = 'true';
            }
        }
    }
    return args;
}

// Build variables from CLI args and environment
function resolveVariables(cliArgs) {
    const variables = {};
    const varNames = ${JSON.stringify(variableNames)};

    for (const name of varNames) {
        // CLI args take priority, then env vars, then spec defaults
        if (cliArgs[name] !== undefined) {
            variables[name] = cliArgs[name];
        } else {
            const envKey = 'PIPELINE_VAR_' + name.toUpperCase();
            if (process.env[envKey]) {
                variables[name] = process.env[envKey];
            }
        }
    }

    return variables;
}

// POST JSON to sera-core
function postJson(url, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const parsed = new URL(url);
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let result = '';
            res.on('data', (chunk) => { result += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(result)); }
                catch { reject(new Error('Invalid JSON response: ' + result)); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// GET JSON from sera-core
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response: ' + data)); }
            });
        }).on('error', reject);
    });
}

// Poll run status until complete
async function pollStatus(baseUrl, runId, auditSlug) {
    const pollInterval = 2000;
    while (true) {
        await new Promise(r => setTimeout(r, pollInterval));
        const status = await getJson(baseUrl + '/api/pipelines/runs/' + runId + '?auditSlug=' + auditSlug);

        if (status.run) {
            const state = status.run.state;
            const progress = Math.round((status.run.progress || 0) * 100);
            console.log('[pipeline] State: ' + state + ' | Progress: ' + progress + '%');

            if (state === 'completed' || state === 'failed' || state === 'cancelled') {
                return status;
            }
        }
    }
}

async function main() {
    const cliArgs = parseArgs(process.argv);
    const variables = resolveVariables(cliArgs);

    const seraHost = process.env.SERA_CORE_HOST || 'localhost';
    const seraPort = process.env.SERA_CORE_PORT || '9800';
    const baseUrl = 'http://' + seraHost + ':' + seraPort;
    const auditSlug = cliArgs.audit || process.env.AUDIT_SLUG || 'default';

    // Load pipeline spec
    const specPath = path.join(__dirname, 'pipeline.json');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));

    console.log('[pipeline] Executing: ' + spec.name + ' v' + spec.version);
    console.log('[pipeline] Audit: ' + auditSlug);
    console.log('[pipeline] Variables: ' + JSON.stringify(variables));

    // Execute pipeline
    const result = await postJson(baseUrl + '/api/pipelines/execute', {
        spec,
        variables,
        auditSlug,
    });

    const runId = result.runId;
    console.log('[pipeline] Run ID: ' + runId);

    // Poll until complete
    const final = await pollStatus(baseUrl, runId, auditSlug);

    if (final.run && final.run.state === 'completed') {
        console.log('[pipeline] Completed successfully');
        process.exit(0);
    } else {
        console.error('[pipeline] Failed: ' + (final.run && final.run.error || 'Unknown error'));
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('[pipeline] Fatal error:', err.message || err);
    process.exit(1);
});
`;
}
