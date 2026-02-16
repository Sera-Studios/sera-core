/**
 * @fileoverview Legacy format detection and conversion utilities
 * @module sera-core/agents/legacy/LegacyConverter
 *
 * Detects the old AgentDefinition format (Claude Code-specific) and
 * converts it to the new AgentRegistration format. Enables backwards
 * compatibility with existing agent JSON files in resources/agents/.
 */

import {
    AgentDefinition,
    AgentLaunchConfig,
    AgentRegistration,
    AgentLaunchParams,
} from '@sera/types';

/**
 * Detect whether a parsed JSON object is a legacy AgentDefinition.
 * Legacy format has roleFile, defaultTools, requiredContext, and no execution field.
 * @param obj - Parsed JSON object
 * @returns true if it matches the legacy AgentDefinition shape
 */
export function isLegacyDefinition(obj: unknown): obj is AgentDefinition {
    return (
        typeof obj === 'object' && obj !== null &&
        'roleFile' in obj &&
        'defaultTools' in obj &&
        'requiredContext' in obj &&
        !('execution' in obj)
    );
}

/**
 * Convert a legacy AgentDefinition to an AgentRegistration.
 * Maps Claude Code-specific fields into execution.type = 'claude-code'.
 * @param def - Legacy AgentDefinition
 * @returns Equivalent AgentRegistration
 */
export function convertLegacyDefinition(def: AgentDefinition): AgentRegistration {
    return {
        id: def.id,
        name: def.name,
        description: def.description,
        execution: {
            type: 'claude-code',
            roleFile: def.roleFile,
            requiredContext: def.requiredContext,
            defaultTools: def.defaultTools,
            defaultScope: def.defaultScope,
        },
        interface: {
            inputs: [
                { name: 'workspace', type: 'workspace', required: true },
                { name: 'primer', type: 'file', required: false, description: 'Protocol primer .md' },
                { name: 'auditSlug', type: 'string', required: true },
            ],
            outputs: [
                { name: 'findings', type: 'mcp-submissions', description: 'Issues submitted via MCP' },
            ],
            mcpTools: def.defaultTools.allowed,
        },
        defaultTimeout: def.defaultTimeout,
        metadata: {
            tags: [],
            capabilities: def.capabilities,
        },
    };
}

/**
 * Convert a legacy AgentLaunchConfig to the new AgentLaunchParams format.
 * @param config - Legacy launch config
 * @param mcpPort - Port of sera-core's MCP server
 * @returns Equivalent AgentLaunchParams
 */
export function convertLegacyLaunchConfig(
    config: AgentLaunchConfig,
    mcpPort: number
): AgentLaunchParams {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    const instanceId = `${config.definitionId}-${timestamp}-${random}`;

    return {
        instanceId,
        auditSlug: config.auditSlug,
        workspacePath: config.workspacePath,
        mcpServerUrl: `http://localhost:${mcpPort}/mcp`,
        timeout: config.timeout,
        env: config.env,
        overrides: {
            primerPath: config.primerPath,
            customPrompt: config.customPrompt,
            scopeOverrides: config.scopeOverrides,
            toolOverrides: config.toolOverrides,
        },
    };
}
