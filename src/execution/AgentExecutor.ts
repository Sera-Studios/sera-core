/**
 * @fileoverview Agent Execution Engine
 * @module sera-core/execution/AgentExecutor
 *
 * Manages subprocess lifecycle for registered agents.
 * Supports ScriptExecution type: resolves credentials from the vault,
 * injects them as env vars, spawns the interpreter, and tracks the process.
 */

import * as child_process from 'child_process';
import type { AgentRegistration, AgentHandle, AgentLaunchParams, ScriptExecution } from '@sera/types';
import type { CredentialStore } from '../credentials/CredentialStore';
import type { AgentRegistrationStore } from '../agents/AgentRegistrationStore';

interface ExecutionRecord {
    handle: AgentHandle;
    stdout: string;
    stderr: string;
    process?: child_process.ChildProcess;
    timer?: ReturnType<typeof setTimeout>;
}

export class AgentExecutor {
    private executions: Map<string, ExecutionRecord> = new Map();

    constructor(
        private credentialStore: CredentialStore,
        private registrationStore: AgentRegistrationStore,
    ) {}

    /**
     * Launch a registered agent as a subprocess.
     *
     * @param registrationId - ID of the agent registration
     * @param params - Launch parameters (instanceId, workspace, timeout, etc.)
     * @returns A snapshot of the AgentHandle
     * @throws If the registration is not found or execution type is unsupported
     */
    launch(registrationId: string, params: AgentLaunchParams): AgentHandle {
        const reg = this.registrationStore.get(registrationId);
        if (!reg) {
            throw new Error(`Agent registration not found: ${registrationId}`);
        }

        this.validateInputs(reg, params);

        if (reg.execution.type !== 'script') {
            throw new Error(
                `Unsupported execution type: ${reg.execution.type}. Only 'script' is currently supported.`
            );
        }

        const scriptExec = reg.execution as ScriptExecution;
        const env = this.resolveEnv(reg, params);
        const args = this.buildArgs(scriptExec, params);
        const instanceId = params.instanceId;

        const handle: AgentHandle = {
            instanceId,
            registrationId,
            status: 'starting',
            startedAt: new Date().toISOString(),
        };

        const record: ExecutionRecord = { handle, stdout: '', stderr: '' };
        this.executions.set(instanceId, record);

        const proc = child_process.spawn(scriptExec.interpreter, args, {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        record.process = proc;
        handle.pid = proc.pid;
        handle.status = 'running';

        proc.stdout!.on('data', (chunk: Buffer) => {
            record.stdout += chunk.toString();
        });

        proc.stderr!.on('data', (chunk: Buffer) => {
            record.stderr += chunk.toString();
        });

        // Enforce timeout
        const timeoutSec = params.timeout ?? reg.defaultTimeout;
        const timeoutMs = timeoutSec * 1000;
        record.timer = setTimeout(() => {
            if (handle.status === 'running') {
                proc.kill('SIGTERM');
                handle.error = `Timed out after ${timeoutSec}s`;
            }
        }, timeoutMs);

        proc.on('close', (code) => {
            if (record.timer) {
                clearTimeout(record.timer);
                record.timer = undefined;
            }
            handle.completedAt = new Date().toISOString();
            handle.exitCode = code ?? undefined;
            if (handle.status === 'running') {
                handle.status = code === 0 ? 'completed' : 'failed';
            }
            if (code !== 0 && !handle.error) {
                handle.error = `Process exited with code ${code}`;
            }
            record.process = undefined;
            console.log(`[AgentExecutor] ${instanceId} finished: status=${handle.status} exitCode=${code}`);
        });

        proc.on('error', (err) => {
            if (record.timer) {
                clearTimeout(record.timer);
                record.timer = undefined;
            }
            handle.completedAt = new Date().toISOString();
            handle.status = 'failed';
            handle.error = err.message;
            record.process = undefined;
            console.error(`[AgentExecutor] ${instanceId} spawn error: ${err.message}`);
        });

        console.log(`[AgentExecutor] Launched ${instanceId} (pid=${proc.pid}): ${scriptExec.interpreter} ${args.join(' ')}`);
        return { ...handle };
    }

    /**
     * Get the current handle for an execution.
     */
    get(instanceId: string): AgentHandle | undefined {
        const rec = this.executions.get(instanceId);
        return rec ? { ...rec.handle } : undefined;
    }

    /**
     * Get captured stdout/stderr for an execution.
     */
    getOutput(instanceId: string): { stdout: string; stderr: string } | undefined {
        const rec = this.executions.get(instanceId);
        if (!rec) return undefined;
        return { stdout: rec.stdout, stderr: rec.stderr };
    }

    /**
     * Stop a running execution by sending SIGTERM.
     * @returns true if the process was signalled
     */
    stop(instanceId: string): boolean {
        const rec = this.executions.get(instanceId);
        if (!rec || !rec.process) return false;
        rec.process.kill('SIGTERM');
        rec.handle.status = 'stopped';
        return true;
    }

    /**
     * List all tracked execution handles.
     */
    listAll(): AgentHandle[] {
        return [...this.executions.values()].map(r => ({ ...r.handle }));
    }

    /**
     * Validate that all required inputs declared in the registration are provided.
     * Throws with a descriptive error listing any missing required inputs.
     */
    private validateInputs(reg: AgentRegistration, params: AgentLaunchParams): void {
        const missing: string[] = [];

        for (const input of reg.interface.inputs) {
            if (!input.required) continue;
            if (input.type === 'workspace') continue;

            if ((input.type === 'string' || input.type === 'file') && !params.overrides?.[input.name]) {
                missing.push(`${input.name} (${input.type})`);
            }
            if (input.type === 'env' && !params.env?.[input.name]) {
                missing.push(`${input.name} (env)`);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `Missing required inputs for agent '${reg.id}': ${missing.join(', ')}. ` +
                `Provide string/file inputs via 'overrides' and env inputs via 'env'.`
            );
        }
    }

    /**
     * Resolve environment variables for the agent process.
     * Decrypts credentials from the vault and merges with any caller-provided env.
     */
    private resolveEnv(reg: AgentRegistration, params: AgentLaunchParams): Record<string, string> {
        const env: Record<string, string> = { ...(params.env ?? {}) };

        for (const cred of reg.requiredCredentials ?? []) {
            const stored = this.credentialStore.get(cred.credentialId);
            if (!stored) {
                console.warn(`[AgentExecutor] Credential not found: ${cred.credentialId} (envVar: ${cred.envVar})`);
                continue;
            }
            env[cred.envVar] = stored.apiKey;
        }

        return env;
    }

    /**
     * Build the argument list for the subprocess.
     * Format: [scriptPath, --workspace, path, ...overrides as --key value]
     */
    private buildArgs(exec: ScriptExecution, params: AgentLaunchParams): string[] {
        const args: string[] = [exec.scriptPath, '--workspace', params.workspacePath];

        // Static args from registration
        if (exec.args) {
            args.push(...exec.args);
        }

        // Dynamic overrides as CLI args
        for (const [key, value] of Object.entries(params.overrides ?? {})) {
            args.push(`--${key}`, String(value));
        }

        return args;
    }
}
