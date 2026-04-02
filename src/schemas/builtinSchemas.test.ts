/**
 * @fileoverview Unit tests for built-in JSON Schema definitions and seed function
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ResourceStore } from '../resources/ResourceStore';
import {
    HUNTER_FINDING_SCHEMA,
    JUDGE_VERDICT_SCHEMA,
    AUDIT_REPORT_SCHEMA,
    seedBuiltinSchemas,
} from './builtinSchemas';

describe('Built-in Schema Definitions', () => {
    it('HUNTER_FINDING_SCHEMA is valid JSON', () => {
        const json = JSON.stringify(HUNTER_FINDING_SCHEMA);
        const parsed = JSON.parse(json);
        expect(parsed.title).toBe('HunterFinding');
        expect(parsed.type).toBe('object');
    });

    it('HUNTER_FINDING_SCHEMA requires title, severity, description', () => {
        expect(HUNTER_FINDING_SCHEMA.required).toEqual(['title', 'severity', 'description']);
    });

    it('JUDGE_VERDICT_SCHEMA requires findingId, verdict, confidence, reasoning', () => {
        expect(JUDGE_VERDICT_SCHEMA.required).toEqual(['findingId', 'verdict', 'confidence', 'reasoning']);
    });

    it('AUDIT_REPORT_SCHEMA requires title, summary, findings', () => {
        expect(AUDIT_REPORT_SCHEMA.required).toEqual(['title', 'summary', 'findings']);
    });

    it('severity enum has 6 correct values', () => {
        const severityProp = HUNTER_FINDING_SCHEMA.properties.severity;
        expect(severityProp.enum).toEqual([
            'critical', 'high', 'medium', 'low', 'informational', 'gas',
        ]);
    });

    it('AuditReport findings items embed HunterFinding schema', () => {
        const findingsProp = AUDIT_REPORT_SCHEMA.properties.findings;
        expect(findingsProp.type).toBe('array');
        expect(findingsProp.items.title).toBe('HunterFinding');
        expect(findingsProp.items.required).toEqual(['title', 'severity', 'description']);
    });

    it('JudgeVerdict verdict enum has 3 values', () => {
        const verdictProp = JUDGE_VERDICT_SCHEMA.properties.verdict;
        expect(verdictProp.enum).toEqual(['valid', 'invalid', 'needs-investigation']);
    });
});

describe('seedBuiltinSchemas', () => {
    let store: ResourceStore;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-seed-test-'));
        store = new ResourceStore(tmpDir);
        await store.initialize();
    });

    afterEach(async () => {
        await store.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('seeds 3 schemas into empty store', () => {
        const result = seedBuiltinSchemas(store);
        expect(result.seeded).toBe(3);
        expect(result.errors).toEqual([]);
    });

    it('creates resources with deterministic IDs', () => {
        seedBuiltinSchemas(store);
        expect(store.get('schema-any-hunter-finding')).not.toBeNull();
        expect(store.get('schema-any-judge-verdict')).not.toBeNull();
        expect(store.get('schema-any-audit-report')).not.toBeNull();
    });

    it('all schemas have type=schema and language=any', () => {
        seedBuiltinSchemas(store);
        const schemas = store.list({ type: 'schema' });
        expect(schemas).toHaveLength(3);
        for (const s of schemas) {
            expect(s.type).toBe('schema');
            expect(s.language).toBe('any');
        }
    });

    it('sets correct tags', () => {
        seedBuiltinSchemas(store);
        const hunter = store.get('schema-any-hunter-finding')!;
        expect(hunter.tags).toEqual(['hunter', 'output', 'finding']);

        const judge = store.get('schema-any-judge-verdict')!;
        expect(judge.tags).toEqual(['judge', 'output', 'verdict']);

        const report = store.get('schema-any-audit-report')!;
        expect(report.tags).toEqual(['writer', 'output', 'report']);
    });

    it('sets metadata with agentType and direction', () => {
        seedBuiltinSchemas(store);
        const hunter = store.get('schema-any-hunter-finding')!;
        expect(hunter.metadata).toEqual({
            schemaVersion: 'draft/2020-12',
            agentType: 'hunter',
            direction: 'output',
        });
    });

    it('content parses as valid JSON Schema', () => {
        seedBuiltinSchemas(store);
        const hunter = store.get('schema-any-hunter-finding')!;
        const schema = JSON.parse(hunter.content);
        expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
        expect(schema.title).toBe('HunterFinding');
    });

    it('re-running seed upserts without error', () => {
        seedBuiltinSchemas(store);
        const result = seedBuiltinSchemas(store);
        expect(result.seeded).toBe(3);
        expect(result.errors).toEqual([]);
        expect(store.list({ type: 'schema' })).toHaveLength(3);
    });

    it('records errors without throwing when upsert fails', () => {
        const brokenStore = {
            upsert: () => { throw new Error('DB write failed'); },
        } as unknown as ResourceStore;

        const result = seedBuiltinSchemas(brokenStore);
        expect(result.seeded).toBe(0);
        expect(result.errors).toHaveLength(3);
        expect(result.errors[0]).toContain('Hunter Finding');
        expect(result.errors[0]).toContain('DB write failed');
    });

    it('records partial errors (some succeed, some fail)', () => {
        let callCount = 0;
        const partialStore = {
            upsert: () => {
                callCount++;
                if (callCount === 2) throw new Error('Partial fail');
                return {};
            },
        } as unknown as ResourceStore;

        const result = seedBuiltinSchemas(partialStore);
        expect(result.seeded).toBe(2);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Judge Verdict');
    });

    it('handles non-Error thrown values', () => {
        const brokenStore = {
            upsert: () => { throw 'string error'; },
        } as unknown as ResourceStore;

        const result = seedBuiltinSchemas(brokenStore);
        expect(result.seeded).toBe(0);
        expect(result.errors).toHaveLength(3);
        expect(result.errors[0]).toContain('string error');
    });
});
