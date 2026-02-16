/**
 * @fileoverview Claude Code Execution Adapter
 * @module sera-core/agents/adapters/ClaudeCodeAdapter
 *
 * Wraps the existing Claude Code subprocess launch logic.
 * Extracts the behavior from AgentLifecycleManager into the
 * ExecutionAdapter interface so it can coexist with Docker,
 * process, and script adapters.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AgentRegistration,
    AgentLaunchParams,
    AgentHandle,
    AgentStatus,
    AgentOutputData,
    AdapterValidationResult,
    AgentDefinition,
    AgentLaunchConfig,
    AgentScope,
    AgentToolPermissions,
    ClaudeCodeExecution,
} from '@sera/types';
import { ExecutionAdapter } from './ExecutionAdapter';
import { AgentDefinitionLoader } from '../AgentDefinitionLoader';
import { PromptBuilder } from '../PromptBuilder';

export class ClaudeCodeAdapter implements ExecutionAdapter {
    readonly type = 'claude-code' as const;

    private processes: Map<string, ChildProcess> = new Map();
    private promptBuilder: PromptBuilder;
    private loader: AgentDefinitionLoader;
    private mcpPort: number;

    constructor(loader: AgentDefinitionLoader, mcpPort: number = 9877) {
        this.loader = loader;
        this.promptBuilder = new PromptBuilder(loader);
        this.mcpPort = mcpPort;
    }

    /**
     * Start a Claude Code agent subprocess.
     * Reconstructs synthetic AgentDefinition/AgentLaunchConfig to
     * reuse the existing PromptBuilder without modification.
     */
    async start(
        registration: AgentRegistration,
        params: AgentLaunchParams
    ): Promise<AgentHandle> {
        const exec = registration.execution as ClaudeCodeExecution;

        // Build synthetic types for PromptBuilder compatibility
        const syntheticDef: AgentDefinition = {
            id: registration.id,
            name: registration.name,
            description: registration.description,
            roleFile: exec.roleFile,
            defaultTools: exec.defaultTools,
            defaultScope: exec.defaultScope,
            defaultTimeout: registration.defaultTimeout,
            requiredContext: exec.requiredContext,
            capabilities: registration.metadata?.capabilities || [],
        };

        const syntheticConfig: AgentLaunchConfig = {
            definitionId: registration.id,
            auditSlug: params.auditSlug,
            workspacePath: params.workspacePath,
            primerPath: params.overrides?.primerPath as string | undefined,
            customPrompt: params.overrides?.customPrompt as string | undefined,
            scopeOverrides: params.overrides?.scopeOverrides as AgentScope | undefined,
            toolOverrides: params.overrides?.toolOverrides as AgentToolPermissions | undefined,
            timeout: params.timeout,
            env: params.env,
        };

        const prompt = this.promptBuilder.build(syntheticConfig, syntheticDef);
        const tools = this.promptBuilder.resolveTools(syntheticConfig, syntheticDef);
        const mcpConfigPath = this.writeMcpConfig(params.instanceId, params.mcpServerUrl);

        // Build Claude Code CLI arguments
        const args: string[] = [
            '-p', prompt,
            '--output-format', 'text',
            '--mcp-config', mcpConfigPath,
        ];

        if (tools.length > 0) {
            args.push('--allowedTools', tools.join(','));
        }

        // Build environment
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            CLAUDE_AGENT_ROLE: registration.id,
            CLAUDE_AGENT_TYPE: registration.id,
            SERA_AUDIT_SLUG: params.auditSlug,
            ...params.env,
        };

        console.log(`[ClaudeCodeAdapter] Launching ${registration.id}: ${params.instanceId}`);
        console.log(`[ClaudeCodeAdapter] Workspace: ${params.workspacePath}`);
        console.log(`[ClaudeCodeAdapter] Tools: ${tools.length} allowed`);

        // Spawn Claude Code subprocess
        const proc = spawn('claude', args, {
            cwd: params.workspacePath,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.processes.set(params.instanceId, proc);

        const handle: AgentHandle = {
            instanceId: params.instanceId,
            registrationId: registration.id,
            status: 'running',
            pid: proc.pid,
            startedAt: new Date().toISOString(),
        };

        // Handle stdout
        proc.stdout?.on('data', (data: Buffer) => {
            const text = data.toString().trim();
            if (text) {
                console.log(`[Agent:${registration.id}:${params.instanceId.slice(-6)}] ${text.slice(0, 200)}`);
            }
        });

        // Handle stderr
        proc.stderr?.on('data', (data: Buffer) => {
            const text = data.toString().trim();
            if (text) {
                console.error(`[Agent:${registration.id}:${params.instanceId.slice(-6)}:err] ${text.slice(0, 200)}`);
            }
        });

        // Handle process exit
        proc.on('close', (code: number | null) => {
            if (handle.status === 'running') {
                handle.status = code === 0 ? 'completed' : 'failed';
                handle.exitCode = code ?? undefined;
                handle.completedAt = new Date().toISOString();
            }
            this.processes.delete(params.instanceId);
            this.cleanupMcpConfig(params.instanceId);
            console.log(`[ClaudeCodeAdapter] Agent ${params.instanceId} exited with code ${code}`);
        });

        // Handle spawn errors
        proc.on('error', (err: Error) => {
            handle.status = 'failed';
            handle.error = err.message;
            handle.completedAt = new Date().toISOString();
            this.processes.delete(params.instanceId);
            this.cleanupMcpConfig(params.instanceId);
            console.error(`[ClaudeCodeAdapter] Agent ${params.instanceId} spawn error:`, err);
        });

        return handle;
    }

    /**
     * @param handle - Agent handle
     * @returns Current status
     */
    getStatus(handle: AgentHandle): AgentStatus {
        return handle.status;
    }

    /**
     * Stop a running Claude Code agent.
     * @param handle - Agent handle
     * @param gracePeriodMs - Grace period before SIGKILL
     */
    async stop(handle: AgentHandle, gracePeriodMs = 5000): Promise<void> {
        const proc = this.processes.get(handle.instanceId);
        if (!proc) return;

        proc.kill('SIGTERM');
        setTimeout(() => {
            if (this.processes.has(handle.instanceId)) {
                proc.kill('SIGKILL');
            }
        }, gracePeriodMs);

        handle.status = 'stopped';
        handle.completedAt = new Date().toISOString();
        this.cleanupMcpConfig(handle.instanceId);
        console.log(`[ClaudeCodeAdapter] Stopped agent: ${handle.instanceId}`);
    }

    /**
     * @param handle - Agent handle
     * @returns Collected outputs (exit code only for Claude Code)
     */
    async getOutputs(handle: AgentHandle): Promise<AgentOutputData> {
        return {
            exitCode: handle.exitCode ?? null,
        };
    }

    /**
     * Validate a Claude Code registration.
     * @param registration - Agent registration to validate
     * @returns Validation result
     */
    async validate(registration: AgentRegistration): Promise<AdapterValidationResult> {
        const exec = registration.execution as ClaudeCodeExecution;
        const errors: string[] = [];
        const warnings: string[] = [];

        if (!exec.roleFile) {
            errors.push('roleFile is required for claude-code execution type');
        }

        if (!exec.defaultTools || !exec.defaultTools.allowed || exec.defaultTools.allowed.length === 0) {
            warnings.push('No tools configured - agent will have no MCP tool access');
        }

        // Check if role content is loadable
        const roleContent = this.loader.getRoleContent(registration.id);
        if (!roleContent) {
            warnings.push(`Role file not loaded for ${registration.id} - may not be registered yet`);
        }

        return { valid: errors.length === 0, errors, warnings };
    }

    // ========================================================================
    // PRIVATE HELPERS
    // ========================================================================

    /**
     * Write a temporary MCP config file for an agent instance.
     * @param instanceId - Agent instance ID
     * @param mcpServerUrl - MCP server URL (or fall back to default)
     * @returns Path to the config file
     */
    private writeMcpConfig(instanceId: string, mcpServerUrl?: string): string {
        const configDir = path.join(os.tmpdir(), 'sera-agents');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        const configPath = path.join(configDir, `${instanceId}.mcp.json`);
        const url = mcpServerUrl || `http://localhost:${this.mcpPort}/mcp`;
        const config = {
            mcpServers: {
                sessionbridge: {
                    type: 'http',
                    url,
                },
            },
        };

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        return configPath;
    }

    /**
     * Clean up temporary MCP config file.
     * @param instanceId - Agent instance ID
     */
    private cleanupMcpConfig(instanceId: string): void {
        const configPath = path.join(os.tmpdir(), 'sera-agents', `${instanceId}.mcp.json`);
        try {
            if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
            }
        } catch {
            // Ignore cleanup errors
        }
    }
}
