/**
 * @fileoverview Lightweight JSON Schema validator for the subset used by sera-core schemas
 * @module sera-core/schemas/validateSchema
 *
 * Supports: type checking (string, number, object, array, boolean),
 * required fields, enum values, nested object validation, and array item validation.
 * Does not support: $ref, $defs, allOf/anyOf/oneOf, pattern, format, min/max.
 */

export interface ValidationError {
    path: string;
    message: string;
    value?: unknown;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
}

/**
 * Validate a JSON object against a JSON Schema (subset).
 */
export function validateAgainstSchema(
    schema: Record<string, unknown>,
    data: unknown,
): ValidationResult {
    const errors: ValidationError[] = [];
    validateNode(schema, data, '$', errors);
    return { valid: errors.length === 0, errors };
}

// ============================================================================
// INTERNAL
// ============================================================================

function validateNode(
    schema: Record<string, unknown>,
    data: unknown,
    path: string,
    errors: ValidationError[],
): void {
    const expectedType = schema.type as string | undefined;

    // Type check
    if (expectedType && !checkType(data, expectedType)) {
        errors.push({
            path,
            message: `expected type "${expectedType}", got "${actualType(data)}"`,
            value: data,
        });
        return; // Stop validating deeper if type is wrong
    }

    // Enum check
    const enumValues = schema.enum as unknown[] | undefined;
    if (enumValues && !enumValues.includes(data)) {
        errors.push({
            path,
            message: `must be one of: ${enumValues.join(', ')}`,
            value: data,
        });
    }

    // Object: required fields + property validation
    if (expectedType === 'object' && typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;
        const required = (schema.required as string[]) || [];
        const properties = (schema.properties as Record<string, Record<string, unknown>>) || {};

        for (const field of required) {
            if (obj[field] === undefined || obj[field] === null) {
                errors.push({
                    path: `${path}.${field}`,
                    message: 'required field is missing',
                });
            }
        }

        for (const [key, propSchema] of Object.entries(properties)) {
            if (obj[key] !== undefined && obj[key] !== null) {
                validateNode(propSchema, obj[key], `${path}.${key}`, errors);
            }
        }
    }

    // Array: items validation
    if (expectedType === 'array' && Array.isArray(data)) {
        const itemsSchema = schema.items as Record<string, unknown> | undefined;
        if (itemsSchema) {
            for (let i = 0; i < data.length; i++) {
                validateNode(itemsSchema, data[i], `${path}[${i}]`, errors);
            }
        }
    }
}

function checkType(value: unknown, expected: string): boolean {
    switch (expected) {
        case 'string': return typeof value === 'string';
        case 'number': return typeof value === 'number';
        case 'boolean': return typeof value === 'boolean';
        case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
        case 'array': return Array.isArray(value);
        default: return true; // Unknown types are permissive
    }
}

function actualType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}
