/**
 * @fileoverview Cross-module contract fixtures for agent registrations
 *
 * These fixtures represent the exact AgentRegistration shapes that
 * agent-designer's convertLegacyDefinition() produces. They serve as
 * the contract between agent-designer (producer) and sera-core (consumer).
 *
 * If agent-designer changes its output format, update these fixtures
 * and the sera-core tests will catch the break.
 */

import { AgentRegistration } from '@sera/types';

/**
 * Hunter registration - converted from resources/agents/hunter.json
 * via agent-designer's convertLegacyDefinition()
 */
export const HUNTER_REGISTRATION: AgentRegistration = {
    id: 'hunter',
    name: 'Hunter',
    version: '0.1.0',
    description: 'Vulnerability detection agent for smart contract security audits',
    execution: {
        type: 'claude-code',
        roleFile: '../roles/hunter.md',
        requiredContext: ['primer', 'claude.md'],
        defaultTools: {
            allowed: ['heartbeat', 'log_prompt', 'submit_poi'],
        },
        defaultScope: {
            filePatterns: ['contracts/**/*.sol', 'src/**/*.sol'],
        },
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
        mcpTools: ['heartbeat', 'log_prompt', 'submit_poi'],
    },
    defaultTimeout: 18000,
    metadata: {
        tags: [],
        capabilities: ['vulnerability-detection', 'security-analysis', 'issue-submission'],
    },
};

/**
 * Cartographer registration - second agent for multi-agent tests
 */
export const CARTOGRAPHER_REGISTRATION: AgentRegistration = {
    id: 'cartographer',
    name: 'Cartographer',
    version: '0.1.0',
    description: 'Code mapping and architecture analysis agent',
    execution: {
        type: 'claude-code',
        roleFile: '../roles/cartographer.md',
        requiredContext: ['primer', 'claude.md'],
        defaultTools: {
            allowed: ['heartbeat', 'log_prompt', 'carto_discover_contracts'],
        },
        defaultScope: {
            filePatterns: ['contracts/**/*.sol', 'src/**/*.sol'],
        },
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
        mcpTools: ['heartbeat', 'log_prompt', 'carto_discover_contracts'],
    },
    defaultTimeout: 10800,
    metadata: {
        tags: [],
        capabilities: ['code-mapping', 'architecture-analysis'],
    },
};
