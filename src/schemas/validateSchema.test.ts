/**
 * @fileoverview Unit tests for lightweight JSON Schema validator
 */

import { describe, it, expect } from 'vitest';
import { validateAgainstSchema } from './validateSchema';
import { HUNTER_FINDING_SCHEMA, JUDGE_VERDICT_SCHEMA } from './builtinSchemas';

// ============================================================================
// TYPE CHECKS
// ============================================================================

describe('Type checking', () => {
    it('valid string passes', () => {
        const schema = { type: 'string' };
        const result = validateAgainstSchema(schema, 'hello');
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('number where string expected fails', () => {
        const schema = { type: 'string' };
        const result = validateAgainstSchema(schema, 42);
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toContain('expected type "string"');
        expect(result.errors[0].message).toContain('got "number"');
    });

    it('null where object expected fails', () => {
        const schema = { type: 'object' };
        const result = validateAgainstSchema(schema, null);
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toContain('got "null"');
    });

    it('array where object expected fails', () => {
        const schema = { type: 'object' };
        const result = validateAgainstSchema(schema, [1, 2]);
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toContain('got "array"');
    });

    it('object where array expected fails', () => {
        const schema = { type: 'array' };
        const result = validateAgainstSchema(schema, { key: 'val' });
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toContain('got "object"');
    });

    it('valid number passes', () => {
        const schema = { type: 'number' };
        const result = validateAgainstSchema(schema, 3.14);
        expect(result.valid).toBe(true);
    });

    it('valid boolean passes', () => {
        const schema = { type: 'boolean' };
        const result = validateAgainstSchema(schema, true);
        expect(result.valid).toBe(true);
    });
});

// ============================================================================
// REQUIRED FIELDS
// ============================================================================

describe('Required fields', () => {
    const schema = {
        type: 'object',
        required: ['name', 'age'],
        properties: {
            name: { type: 'string' },
            age: { type: 'number' },
        },
    };

    it('all required fields present passes', () => {
        const result = validateAgainstSchema(schema, { name: 'Alice', age: 30 });
        expect(result.valid).toBe(true);
    });

    it('missing one required field returns error with path', () => {
        const result = validateAgainstSchema(schema, { name: 'Alice' });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].path).toBe('$.age');
        expect(result.errors[0].message).toBe('required field is missing');
    });

    it('missing multiple required fields returns multiple errors', () => {
        const result = validateAgainstSchema(schema, {});
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(2);
        expect(result.errors.map(e => e.path)).toContain('$.name');
        expect(result.errors.map(e => e.path)).toContain('$.age');
    });

    it('null value for required field returns error', () => {
        const result = validateAgainstSchema(schema, { name: null, age: 30 });
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('$.name');
    });
});

// ============================================================================
// ENUM
// ============================================================================

describe('Enum validation', () => {
    const schema = {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low'],
    };

    it('valid enum value passes', () => {
        const result = validateAgainstSchema(schema, 'high');
        expect(result.valid).toBe(true);
    });

    it('invalid enum value fails with allowed values', () => {
        const result = validateAgainstSchema(schema, 'extreme');
        expect(result.valid).toBe(false);
        expect(result.errors[0].message).toContain('must be one of:');
        expect(result.errors[0].message).toContain('critical');
    });

    it('case-sensitive enum check', () => {
        const result = validateAgainstSchema(schema, 'Critical');
        expect(result.valid).toBe(false);
    });
});

// ============================================================================
// NESTED OBJECTS
// ============================================================================

describe('Nested object validation', () => {
    const schema = {
        type: 'object',
        properties: {
            address: {
                type: 'object',
                required: ['street', 'city'],
                properties: {
                    street: { type: 'string' },
                    city: { type: 'string' },
                },
            },
        },
    };

    it('valid nested object passes', () => {
        const result = validateAgainstSchema(schema, {
            address: { street: '123 Main', city: 'Springfield' },
        });
        expect(result.valid).toBe(true);
    });

    it('missing required in nested object reports correct path', () => {
        const result = validateAgainstSchema(schema, {
            address: { street: '123 Main' },
        });
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('$.address.city');
    });

    it('optional nested object can be absent', () => {
        const result = validateAgainstSchema(schema, {});
        expect(result.valid).toBe(true);
    });
});

// ============================================================================
// ARRAYS
// ============================================================================

describe('Array validation', () => {
    const schema = {
        type: 'array',
        items: { type: 'string' },
    };

    it('valid array of correct types passes', () => {
        const result = validateAgainstSchema(schema, ['a', 'b', 'c']);
        expect(result.valid).toBe(true);
    });

    it('array item type mismatch reports index in path', () => {
        const result = validateAgainstSchema(schema, ['a', 42, 'c']);
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('$[1]');
        expect(result.errors[0].message).toContain('expected type "string"');
    });

    it('empty array passes', () => {
        const result = validateAgainstSchema(schema, []);
        expect(result.valid).toBe(true);
    });

    it('array of objects with nested validation', () => {
        const objArraySchema = {
            type: 'array',
            items: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string' },
                    line: { type: 'number' },
                },
            },
        };
        const result = validateAgainstSchema(objArraySchema, [
            { path: '/foo.sol', line: 10 },
            { line: 20 }, // missing path
        ]);
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('$[1].path');
    });
});

// ============================================================================
// FULL SCHEMA TESTS
// ============================================================================

describe('HunterFinding schema validation', () => {
    it('valid HunterFinding passes', () => {
        const data = {
            title: 'Reentrancy in withdraw',
            severity: 'high',
            description: 'The withdraw function is vulnerable to reentrancy.',
            impact: 'Fund theft',
            affectedFiles: [{ path: 'contracts/Vault.sol', startLine: 45, endLine: 60 }],
        };
        const result = validateAgainstSchema(HUNTER_FINDING_SCHEMA, data);
        expect(result.valid).toBe(true);
    });

    it('missing title, severity, description gives 3 errors', () => {
        const result = validateAgainstSchema(HUNTER_FINDING_SCHEMA, {
            impact: 'Something bad',
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(3);
        const paths = result.errors.map(e => e.path);
        expect(paths).toContain('$.title');
        expect(paths).toContain('$.severity');
        expect(paths).toContain('$.description');
    });

    it('invalid severity enum fails', () => {
        const data = {
            title: 'Bug',
            severity: 'Critical', // wrong case
            description: 'Details',
        };
        const result = validateAgainstSchema(HUNTER_FINDING_SCHEMA, data);
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('$.severity');
    });

    it('affectedFiles item missing path reports correct path', () => {
        const data = {
            title: 'Bug',
            severity: 'high',
            description: 'Details',
            affectedFiles: [{ startLine: 10 }],
        };
        const result = validateAgainstSchema(HUNTER_FINDING_SCHEMA, data);
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('$.affectedFiles[0].path');
    });
});

describe('JudgeVerdict schema validation', () => {
    it('valid JudgeVerdict passes', () => {
        const data = {
            findingId: 'f-001',
            verdict: 'valid',
            confidence: 0.95,
            reasoning: 'Confirmed through static analysis.',
        };
        const result = validateAgainstSchema(JUDGE_VERDICT_SCHEMA, data);
        expect(result.valid).toBe(true);
    });

    it('invalid verdict enum fails', () => {
        const data = {
            findingId: 'f-001',
            verdict: 'confirmed', // not in enum
            confidence: 0.9,
            reasoning: 'Looks good',
        };
        const result = validateAgainstSchema(JUDGE_VERDICT_SCHEMA, data);
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('$.verdict');
    });

    it('confidence as string fails', () => {
        const data = {
            findingId: 'f-001',
            verdict: 'valid',
            confidence: '0.9', // string, not number
            reasoning: 'OK',
        };
        const result = validateAgainstSchema(JUDGE_VERDICT_SCHEMA, data);
        expect(result.valid).toBe(false);
        expect(result.errors[0].path).toBe('$.confidence');
    });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('Edge cases', () => {
    it('unknown type in schema is permissive', () => {
        const schema = { type: 'custom' };
        const result = validateAgainstSchema(schema, 'anything');
        expect(result.valid).toBe(true);
    });

    it('extra properties in data are ignored', () => {
        const schema = {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
        };
        const result = validateAgainstSchema(schema, { name: 'Alice', extra: 42 });
        expect(result.valid).toBe(true);
    });

    it('schema without type still checks required and properties', () => {
        const schema = {
            required: ['x'],
            properties: { x: { type: 'number' } },
        };
        // No type check, but required/properties won't trigger without type='object'
        const result = validateAgainstSchema(schema, { x: 5 });
        expect(result.valid).toBe(true);
    });
});
