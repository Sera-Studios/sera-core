#!/usr/bin/env node
/**
 * @fileoverview sera-core CLI entry point
 * @module sera-core/cli
 *
 * Usage:
 *   sera-core start          Start daemon (foreground)
 *   sera-core start -d       Start daemon (background/detached)
 *   sera-core stop           Stop daemon
 *   sera-core status         Show running state
 *   sera-core list           List all audits
 *   sera-core health         Check daemon health
 *   sera-core migrate <path> Migrate workspace database to sera-core
 */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { loadConfig, getSeraHome } from './config';

const config = loadConfig();
const PID_FILE = path.join(getSeraHome(), 'sera-core.pid');

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'start':
            if (args.includes('-d') || args.includes('--detached')) {
                await startDetached();
            } else {
                await startForeground();
            }
            break;
        case 'stop':
            await stopDaemon();
            break;
        case 'status':
            await showStatus();
            break;
        case 'list':
            await listAudits();
            break;
        case 'health':
            await checkHealth();
            break;
        case 'migrate':
            await migrateWorkspace(args[1]);
            break;
        case 'build':
            await buildPipeline(args.slice(1));
            break;
        default:
            printUsage();
            break;
    }
}

async function startForeground(): Promise<void> {
    // Import and run server (SeraCore constructor calls ensureSeraHome)
    const { SeraCore } = await import('./server');
    const core = new SeraCore();

    // Write PID file (after ensureSeraHome created ~/.sera/)
    fs.writeFileSync(PID_FILE, String(process.pid));

    const shutdown = async () => {
        await core.stop();
        if (fs.existsSync(PID_FILE)) { fs.unlinkSync(PID_FILE); }
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await core.start();
}

async function startDetached(): Promise<void> {
    // Check if already running
    if (await isDaemonRunning()) {
        console.log('sera-core is already running');
        return;
    }

    const serverScript = path.join(__dirname, 'server.js');
    const logFile = path.join(getSeraHome(), 'logs', 'sera-core.log');

    // Ensure log directory exists
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) { fs.mkdirSync(logDir, { recursive: true }); }

    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');

    const child = spawn('node', [serverScript], {
        detached: true,
        stdio: ['ignore', out, err],
    });

    // Write PID
    if (child.pid) {
        fs.writeFileSync(PID_FILE, String(child.pid));
        console.log(`sera-core started (PID: ${child.pid})`);
        console.log(`  Logs: ${logFile}`);
        console.log(`  Port: ${config.ports.client}`);
    }

    child.unref();
}

async function stopDaemon(): Promise<void> {
    if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
        try {
            process.kill(pid, 'SIGTERM');
            console.log(`sera-core stopped (PID: ${pid})`);
        } catch {
            console.log('sera-core is not running (stale PID file)');
        }
        fs.unlinkSync(PID_FILE);
    } else {
        console.log('sera-core is not running');
    }
}

async function showStatus(): Promise<void> {
    const running = await isDaemonRunning();
    if (!running) {
        console.log('sera-core: not running');
        return;
    }

    try {
        const health = await fetchHealth();
        console.log('sera-core: running');
        console.log(`  Version: ${health.version}`);
        console.log(`  Uptime: ${formatUptime(health.uptime)}`);
        console.log(`  Audits: ${health.audits}`);
        console.log(`  Clients: ${health.clients}`);
        console.log(`  Port: ${config.ports.client}`);
    } catch {
        console.log('sera-core: running (health check failed)');
    }
}

async function listAudits(): Promise<void> {
    try {
        const data = await fetchJson(`http://localhost:${config.ports.client}/api/audits`);
        if (data.audits.length === 0) {
            console.log('No audits registered');
            return;
        }

        console.log(`${data.audits.length} audit(s):\n`);
        for (const audit of data.audits) {
            console.log(`  ${audit.slug}`);
            console.log(`    Name: ${audit.name}`);
            console.log(`    Last accessed: ${audit.lastAccessed}`);
            console.log(`    Workspaces: ${audit.workspacePaths.join(', ')}`);
            console.log();
        }
    } catch {
        console.log('sera-core is not running. Start it with: sera-core start');
    }
}

async function checkHealth(): Promise<void> {
    try {
        const health = await fetchHealth();
        console.log(JSON.stringify(health, null, 2));
    } catch {
        console.log('sera-core is not responding');
        process.exit(1);
    }
}

async function migrateWorkspace(workspacePath?: string): Promise<void> {
    if (!workspacePath) {
        console.error('Usage: sera-core migrate <workspace-path>');
        console.error('  Migrates .vscode/sera-studio.db from a workspace to sera-core');
        process.exit(1);
    }

    const resolved = path.resolve(workspacePath);
    const dbSource = path.join(resolved, '.vscode', 'sera-studio.db');

    if (!fs.existsSync(resolved)) {
        console.error(`Workspace not found: ${resolved}`);
        process.exit(1);
    }

    if (!fs.existsSync(dbSource)) {
        console.error(`No database found at: ${dbSource}`);
        process.exit(1);
    }

    const { ensureSeraHome } = await import('./config');
    ensureSeraHome();

    const { AuditRegistry } = await import('./database/AuditRegistry');
    const registry = new AuditRegistry();
    registry.load();

    // Check if workspace is already registered
    const existingSlug = registry.lookupWorkspace(resolved);
    if (existingSlug) {
        console.log(`Workspace already registered as audit '${existingSlug}'`);
        return;
    }

    // Derive audit name from folder name
    const folderName = path.basename(resolved);
    const slug = AuditRegistry.slugify(folderName);

    if (registry.auditExists(slug)) {
        console.error(`Audit '${slug}' already exists. Register workspace manually.`);
        process.exit(1);
    }

    // Create audit and copy database
    const dbDest = registry.createAudit(slug, folderName, resolved);
    fs.copyFileSync(dbSource, dbDest);

    // Backup original
    const backupPath = dbSource + '.migrated';
    fs.renameSync(dbSource, backupPath);

    console.log(`Migrated successfully:`);
    console.log(`  Audit:    ${slug}`);
    console.log(`  From:     ${dbSource}`);
    console.log(`  To:       ${dbDest}`);
    console.log(`  Backup:   ${backupPath}`);
}

async function buildPipeline(args: string[]): Promise<void> {
    let specPath: string | undefined;
    let tag: string | undefined;
    let format: string = 'docker';
    let dryRun = false;
    let push = false;
    let outputDir: string | undefined;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--spec':
                specPath = args[++i];
                break;
            case '--tag':
                tag = args[++i];
                break;
            case '--format':
                format = args[++i];
                break;
            case '--dry-run':
                dryRun = true;
                break;
            case '--push':
                push = true;
                break;
            case '--output':
                outputDir = args[++i];
                break;
        }
    }

    if (!specPath) {
        console.error('Usage: sera-core build --spec <path> [--tag <tag>] [--format docker|process|script] [--dry-run] [--push] [--output <dir>]');
        process.exit(1);
    }

    const resolved = path.resolve(specPath);
    if (!fs.existsSync(resolved)) {
        console.error(`Pipeline spec not found: ${resolved}`);
        process.exit(1);
    }

    const spec = JSON.parse(fs.readFileSync(resolved, 'utf-8'));

    const { build } = await import('./packaging/BuildPipeline');
    const result = await build(spec, {
        tag,
        format: format as 'docker' | 'process' | 'script',
        dryRun,
        push,
        outputDir,
    });

    if (result.success) {
        console.log('\nBuild succeeded');
        if (result.imageTag) console.log(`  Image: ${result.imageTag}`);
        if (result.artifactPath) console.log(`  Artifacts: ${result.artifactPath}`);
    } else {
        console.error('\nBuild failed');
        for (const w of result.warnings) {
            console.error(`  ${w}`);
        }
        process.exit(1);
    }

    if (result.warnings.length > 0) {
        console.log('Warnings:');
        for (const w of result.warnings) {
            console.log(`  ${w}`);
        }
    }
}

// ============================================================================
// HELPERS
// ============================================================================

async function isDaemonRunning(): Promise<boolean> {
    if (!fs.existsSync(PID_FILE)) { return false; }

    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
        process.kill(pid, 0); // Check if process exists
        return true;
    } catch {
        return false;
    }
}

async function fetchHealth(): Promise<any> {
    return fetchJson(`http://localhost:${config.ports.client}/api/health`);
}

function fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON')); }
            });
        }).on('error', reject);
    });
}

function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) { return `${h}h ${m}m ${s}s`; }
    if (m > 0) { return `${m}m ${s}s`; }
    return `${s}s`;
}

function printUsage(): void {
    console.log('Usage: sera-core <command>\n');
    console.log('Commands:');
    console.log('  start              Start daemon (foreground)');
    console.log('  start -d           Start daemon (background/detached)');
    console.log('  stop               Stop daemon');
    console.log('  status             Show running state, connected clients, active audits');
    console.log('  list               List all audits with metadata');
    console.log('  health             Show health check JSON');
    console.log('  migrate <path>     Migrate workspace database to sera-core');
    console.log('  build              Build a packaged pipeline');
    console.log('    --spec <path>    Path to pipeline spec JSON (required)');
    console.log('    --tag <tag>      Docker image tag');
    console.log('    --format <fmt>   Output format: docker|process|script (default: docker)');
    console.log('    --dry-run        Generate files without building');
    console.log('    --push           Push Docker image after build');
    console.log('    --output <dir>   Output directory for build artifacts');
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
