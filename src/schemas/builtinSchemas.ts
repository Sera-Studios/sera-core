/**
 * @fileoverview Built-in JSON Schema definitions for agent output contracts
 * @module sera-core/schemas/builtinSchemas
 *
 * Defines HunterFinding, JudgeVerdict, and AuditReport schemas as JSON Schema
 * objects. These are seeded into ResourceStore on boot as type: 'schema' resources.
 */

import { ResourceStore, ResourceCreateInput } from '../resources/ResourceStore';

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

const SEVERITY_ENUM = ['critical', 'high', 'medium', 'low', 'informational', 'gas'];

export const HUNTER_FINDING_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'HunterFinding',
    type: 'object' as const,
    required: ['title', 'severity', 'description'],
    properties: {
        id: { type: 'string', description: 'Unique finding identifier' },
        title: { type: 'string', description: 'One-line finding title' },
        severity: {
            type: 'string',
            enum: SEVERITY_ENUM,
        },
        description: { type: 'string', description: 'Detailed vulnerability description' },
        impact: { type: 'string', description: 'What could go wrong' },
        recommendation: { type: 'string', description: 'How to fix it' },
        affectedFiles: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    startLine: { type: 'number' },
                    endLine: { type: 'number' },
                },
                required: ['path'],
            },
        },
        codeSnippet: { type: 'string', description: 'Relevant code excerpt' },
        references: { type: 'array', items: { type: 'string' } },
    },
};

export const JUDGE_VERDICT_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'JudgeVerdict',
    type: 'object' as const,
    required: ['findingId', 'verdict', 'confidence', 'reasoning'],
    properties: {
        findingId: { type: 'string', description: 'ID of the finding being judged' },
        verdict: {
            type: 'string',
            enum: ['valid', 'invalid', 'needs-investigation'],
        },
        confidence: { type: 'number', description: '0.0 to 1.0 confidence score' },
        reasoning: { type: 'string', description: 'Why this verdict was reached' },
        severityAdjustment: {
            type: 'object',
            properties: {
                original: { type: 'string', enum: SEVERITY_ENUM },
                adjusted: { type: 'string', enum: SEVERITY_ENUM },
                reason: { type: 'string' },
            },
            required: ['original', 'adjusted', 'reason'],
        },
    },
};

export const AUDIT_REPORT_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AuditReport',
    type: 'object' as const,
    required: ['title', 'summary', 'findings'],
    properties: {
        title: { type: 'string', description: 'Report title' },
        summary: { type: 'string', description: 'Executive summary' },
        findings: {
            type: 'array',
            items: HUNTER_FINDING_SCHEMA,
        },
        methodology: { type: 'string', description: 'Audit methodology description' },
        scope: {
            type: 'object',
            properties: {
                files: { type: 'array', items: { type: 'string' } },
                contracts: { type: 'array', items: { type: 'string' } },
                linesOfCode: { type: 'number' },
            },
        },
        metadata: {
            type: 'object',
            properties: {
                author: { type: 'string' },
                date: { type: 'string' },
                version: { type: 'string' },
                firm: { type: 'string' },
            },
        },
    },
};

// ============================================================================
// SEED FUNCTION
// ============================================================================

export interface SeedSchemaResult {
    seeded: number;
    errors: string[];
}

const BUILTIN_SCHEMAS: ResourceCreateInput[] = [
    {
        type: 'schema',
        language: 'any',
        name: 'Hunter Finding',
        content: JSON.stringify(HUNTER_FINDING_SCHEMA, null, 2),
        tags: ['hunter', 'output', 'finding'],
        metadata: { schemaVersion: 'draft/2020-12', agentType: 'hunter', direction: 'output' },
    },
    {
        type: 'schema',
        language: 'any',
        name: 'Judge Verdict',
        content: JSON.stringify(JUDGE_VERDICT_SCHEMA, null, 2),
        tags: ['judge', 'output', 'verdict'],
        metadata: { schemaVersion: 'draft/2020-12', agentType: 'judge', direction: 'output' },
    },
    {
        type: 'schema',
        language: 'any',
        name: 'Audit Report',
        content: JSON.stringify(AUDIT_REPORT_SCHEMA, null, 2),
        tags: ['writer', 'output', 'report'],
        metadata: { schemaVersion: 'draft/2020-12', agentType: 'writer', direction: 'output' },
    },
];

/**
 * Seed built-in schemas into the ResourceStore. Uses upsert so safe to call repeatedly.
 */
export function seedBuiltinSchemas(store: ResourceStore): SeedSchemaResult {
    const result: SeedSchemaResult = { seeded: 0, errors: [] };

    for (const input of BUILTIN_SCHEMAS) {
        try {
            store.upsert(input);
            result.seeded++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`schema/${input.name}: ${msg}`);
        }
    }

    return result;
}
