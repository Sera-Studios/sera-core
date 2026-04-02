/**
 * @fileoverview Unit tests for AgentExecutor
 *
 * Tests subprocess spawning, credential injection, timeout handling,
 * and process lifecycle management. Uses real temp Python scripts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentExecutor } from './AgentExecutor';
import { AgentRegistrationStore } from '../agents/AgentRegistrationStore';
import { CredentialStore } from '../credentials/CredentialStore';
import type { AgentRegistration, AgentLaunchParams } from '@sera/types';

let seraHome: string;
let scriptDir: string;
let registrationStore: AgentRegistrationStore;
let credentialStore: CredentialStore;
let executor: AgentExecutor;

function makeLaunchParams(overrides?: Partial<AgentLaunchParams>): AgentLaunchParams {
    return {
        instanceId: `test-${Date.now().toString(36)}`,
        auditSlug: 'test-audit',
        workspacePath: '/tmp/test-workspace',
        mcpServerUrl: '',
        ...overrides,
    };
}

/** Write a Python script to the temp dir and return its absolute path */
function writeScript(name: string, code: string): string {
    const filePath = path.join(scriptDir, name);
    fs.writeFileSync(filePath, code);
    return filePath;
}

function registerScriptAgent(
    store: AgentRegistrationStore,
    id: string,
    scriptPath: string,
    overrides?: Partial<AgentRegistration>,
): void {
    store.register({
        id,
        name: `Test Agent ${id}`,
        version: '0.1.0',
        description: 'Test agent',
        roles: ['execution'],
        execution: {
            type: 'script',
            interpreter: 'python3',
            scriptPath,
        },
        interface: { inputs: [], outputs: [] },
        defaultTimeout: 30,
        ...overrides,
    } as AgentRegistration);
}

/** Wait for an execution to reach a terminal state */
async function waitForDone(exec: AgentExecutor, instanceId: string, maxMs = 10000): Promise<void> {
    const deadline = Date.now() + maxMs;
    return new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
            if (Date.now() > deadline) {
                clearInterval(check);
                reject(new Error(`Execution ${instanceId} did not complete within ${maxMs}ms`));
                return;
            }
            const h = exec.get(instanceId);
            if (h && h.status !== 'running' && h.status !== 'starting') {
                clearInterval(check);
                resolve();
            }
        }, 50);
    });
}

beforeEach(() => {
    seraHome = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-test-'));
    scriptDir = path.join(seraHome, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const resourcesDir = path.join(seraHome, 'resources');
    fs.mkdirSync(path.join(resourcesDir, 'agents'), { recursive: true });

    registrationStore = new AgentRegistrationStore(resourcesDir);
    credentialStore = new CredentialStore(seraHome);
    executor = new AgentExecutor(credentialStore, registrationStore);
});

afterEach(() => {
    if (seraHome && fs.existsSync(seraHome)) {
        fs.rmSync(seraHome, { recursive: true, force: true });
    }
});

describe('AgentExecutor', () => {
    it('launches a script and captures stdout', async () => {
        const sp = writeScript('echo.py', "print('hello from agent')\n");
        registerScriptAgent(registrationStore, 'echo-agent', sp);

        const params = makeLaunchParams();
        const handle = executor.launch('echo-agent', params);

        expect(handle.status).toBe('running');
        expect(handle.registrationId).toBe('echo-agent');
        expect(handle.pid).toBeDefined();

        await waitForDone(executor, handle.instanceId);

        const final = executor.get(handle.instanceId)!;
        expect(final.status).toBe('completed');
        expect(final.exitCode).toBe(0);

        const output = executor.getOutput(handle.instanceId)!;
        expect(output.stdout).toContain('hello from agent');
    });

    it('reports failed status for non-zero exit', async () => {
        const sp = writeScript('fail.py', "import sys\nsys.exit(1)\n");
        registerScriptAgent(registrationStore, 'fail-agent', sp);

        const params = makeLaunchParams();
        const handle = executor.launch('fail-agent', params);

        await waitForDone(executor, handle.instanceId);

        const final = executor.get(handle.instanceId)!;
        expect(final.status).toBe('failed');
        expect(final.exitCode).toBe(1);
        expect(final.error).toContain('exited with code 1');
    });

    it('handles timeout by killing the process', async () => {
        const sp = writeScript('slow.py', "import time\ntime.sleep(30)\n");
        registerScriptAgent(registrationStore, 'slow-agent', sp);

        const params = makeLaunchParams({ timeout: 1 }); // 1 second timeout
        const handle = executor.launch('slow-agent', params);

        await waitForDone(executor, handle.instanceId, 5000);

        const final = executor.get(handle.instanceId)!;
        expect(final.error).toContain('Timed out');
    });

    it('injects credentials as environment variables', async () => {
        const sp = writeScript('cred.py', "import os\nprint(os.environ.get('ANTHROPIC_API_KEY', 'NOT_SET'))\n");

        // Save a credential to the vault
        credentialStore.save('anthropic', 'Test Key', 'sk-test-12345');
        const creds = credentialStore.list();
        const credId = creds[0].id;

        registerScriptAgent(registrationStore, 'cred-agent', sp, {
            requiredCredentials: [{
                credentialId: credId,
                envVar: 'ANTHROPIC_API_KEY',
                provider: 'anthropic',
            }],
        });

        const params = makeLaunchParams();
        const handle = executor.launch('cred-agent', params);

        await waitForDone(executor, handle.instanceId);

        const output = executor.getOutput(handle.instanceId)!;
        expect(output.stdout).toContain('sk-test-12345');
    });

    it('passes overrides as CLI arguments', async () => {
        const sp = writeScript('args.py', "import sys\nprint(' '.join(sys.argv[1:]))\n");
        registerScriptAgent(registrationStore, 'args-agent', sp);

        const params = makeLaunchParams({
            overrides: { output_dir: '/tmp/output' },
        });
        const handle = executor.launch('args-agent', params);

        await waitForDone(executor, handle.instanceId);

        const output = executor.getOutput(handle.instanceId)!;
        expect(output.stdout).toContain('--workspace');
        expect(output.stdout).toContain('--output_dir');
        expect(output.stdout).toContain('/tmp/output');
    });

    it('stop() sends SIGTERM to running process', async () => {
        const sp = writeScript('sleep.py', "import time\ntime.sleep(60)\n");
        registerScriptAgent(registrationStore, 'sleep-agent', sp);

        const params = makeLaunchParams();
        const handle = executor.launch('sleep-agent', params);

        // Give it a moment to start
        await new Promise(r => setTimeout(r, 200));

        const stopped = executor.stop(handle.instanceId);
        expect(stopped).toBe(true);

        await waitForDone(executor, handle.instanceId);

        const final = executor.get(handle.instanceId)!;
        expect(final.status).toBe('stopped');
    });

    it('returns undefined for unknown instanceId', () => {
        expect(executor.get('nonexistent')).toBeUndefined();
        expect(executor.getOutput('nonexistent')).toBeUndefined();
    });

    it('stop() returns false for unknown or finished execution', () => {
        expect(executor.stop('nonexistent')).toBe(false);
    });

    it('throws for unknown registration', () => {
        const params = makeLaunchParams();
        expect(() => executor.launch('nonexistent', params)).toThrow('not found');
    });

    it('throws for unsupported execution type', () => {
        registrationStore.register({
            id: 'docker-agent',
            name: 'Docker Agent',
            version: '0.1.0',
            description: 'test',
            roles: ['execution'],
            execution: { type: 'docker', image: 'test' },
            interface: { inputs: [], outputs: [] },
            defaultTimeout: 30,
        } as AgentRegistration);

        const params = makeLaunchParams();
        expect(() => executor.launch('docker-agent', params)).toThrow('Unsupported execution type');
    });

    it('listAll() returns all tracked handles', async () => {
        const sp = writeScript('list.py', "print('done')\n");
        registerScriptAgent(registrationStore, 'list-agent', sp);

        const handle = executor.launch('list-agent', makeLaunchParams());

        const all = executor.listAll();
        expect(all.length).toBe(1);
        expect(all[0].instanceId).toBe(handle.instanceId);

        await waitForDone(executor, handle.instanceId);
    });

    it('throws when required string input is missing', () => {
        const sp = writeScript('input-required.py', "print('ok')\n");
        registerScriptAgent(registrationStore, 'input-agent', sp, {
            interface: {
                inputs: [
                    { name: 'workspace', type: 'workspace', required: true },
                    { name: 'output_dir', type: 'string', required: true, description: 'Output directory' },
                ],
                outputs: [],
            },
        });

        const params = makeLaunchParams();
        expect(() => executor.launch('input-agent', params)).toThrow('Missing required inputs');
        expect(() => executor.launch('input-agent', params)).toThrow('output_dir (string)');
    });

    it('launches successfully when required inputs are provided via overrides', async () => {
        const sp = writeScript('input-ok.py', "import sys\nprint(' '.join(sys.argv[1:]))\n");
        registerScriptAgent(registrationStore, 'input-ok-agent', sp, {
            interface: {
                inputs: [
                    { name: 'workspace', type: 'workspace', required: true },
                    { name: 'output_dir', type: 'string', required: true, description: 'Output directory' },
                ],
                outputs: [],
            },
        });

        const params = makeLaunchParams({
            overrides: { output_dir: '/tmp/output' },
        });
        const handle = executor.launch('input-ok-agent', params);
        expect(handle.status).toBe('running');

        await waitForDone(executor, handle.instanceId);

        const final = executor.get(handle.instanceId)!;
        expect(final.status).toBe('completed');

        const output = executor.getOutput(handle.instanceId)!;
        expect(output.stdout).toContain('--output_dir');
        expect(output.stdout).toContain('/tmp/output');
    });

    it('throws when required env input is missing', () => {
        const sp = writeScript('env-required.py', "print('ok')\n");
        registerScriptAgent(registrationStore, 'env-input-agent', sp, {
            interface: {
                inputs: [
                    { name: 'workspace', type: 'workspace', required: true },
                    { name: 'API_KEY', type: 'env', required: true, description: 'API key' },
                ],
                outputs: [],
            },
        });

        const params = makeLaunchParams();
        expect(() => executor.launch('env-input-agent', params)).toThrow('API_KEY (env)');
    });

    it('skips validation for optional inputs', async () => {
        const sp = writeScript('optional.py', "print('ok')\n");
        registerScriptAgent(registrationStore, 'optional-agent', sp, {
            interface: {
                inputs: [
                    { name: 'workspace', type: 'workspace', required: true },
                    { name: 'output_dir', type: 'string', required: false },
                ],
                outputs: [],
            },
        });

        const params = makeLaunchParams();
        const handle = executor.launch('optional-agent', params);
        expect(handle.status).toBe('running');

        await waitForDone(executor, handle.instanceId);

        const final = executor.get(handle.instanceId)!;
        expect(final.status).toBe('completed');
    });

    it('handles missing credentials gracefully', async () => {
        const sp = writeScript('missing-cred.py', "import os\nprint(os.environ.get('MISSING_KEY', 'NOT_INJECTED'))\n");
        registerScriptAgent(registrationStore, 'missing-cred-agent', sp, {
            requiredCredentials: [{
                credentialId: 'nonexistent-cred',
                envVar: 'MISSING_KEY',
                provider: 'test',
            }],
        });

        const params = makeLaunchParams();
        const handle = executor.launch('missing-cred-agent', params);

        await waitForDone(executor, handle.instanceId);

        // Should still run - just without the credential
        const output = executor.getOutput(handle.instanceId)!;
        expect(output.stdout).toContain('NOT_INJECTED');
    });
});
