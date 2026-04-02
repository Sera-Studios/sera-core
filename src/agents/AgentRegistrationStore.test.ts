/**
 * @fileoverview Unit tests for AgentRegistrationStore
 *
 * Tests loadFromDisk, get, getAll, getByRole, register, unregister,
 * reload, writeArtifacts, getDiskDir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgentRegistrationStore } from './AgentRegistrationStore';

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sera-agents-test-'));
}

function writeAgentFile(dir: string, agent: Record<string, unknown>): void {
    const agentsDir = path.join(dir, 'agents');
    if (!fs.existsSync(agentsDir)) {
        fs.mkdirSync(agentsDir, { recursive: true });
    }
    const filePath = path.join(agentsDir, `${agent.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(agent));
}

describe('AgentRegistrationStore', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('constructor and loadFromDisk', () => {
        it('creates agents directory if missing', () => {
            const store = new AgentRegistrationStore(tmpDir);
            expect(fs.existsSync(path.join(tmpDir, 'agents'))).toBe(true);
            expect(store.size).toBe(0);
        });

        it('loads valid agent files from disk', () => {
            writeAgentFile(tmpDir, {
                id: 'hunter-v1',
                name: 'Hunter',
                version: '1.0',
                description: 'Finds vulns',
                roles: ['hunter'],
                execution: { type: 'subprocess', command: 'node' },
                interface: { inputs: [], outputs: [] },
                defaultTimeout: 60000,
            });

            const store = new AgentRegistrationStore(tmpDir);
            expect(store.size).toBe(1);
            expect(store.get('hunter-v1')).toBeDefined();
            expect(store.get('hunter-v1')!.name).toBe('Hunter');
        });

        it('skips invalid files (missing id)', () => {
            writeAgentFile(tmpDir, { name: 'Bad', execution: { type: 'x' } });
            // Need to create a file with a name that doesn't collide
            const agentsDir = path.join(tmpDir, 'agents');
            fs.writeFileSync(path.join(agentsDir, 'bad.json'), JSON.stringify({
                name: 'Bad Agent',
                execution: { type: 'subprocess' },
            }));

            const store = new AgentRegistrationStore(tmpDir);
            expect(store.size).toBe(0);
        });

        it('skips files missing execution field', () => {
            const agentsDir = path.join(tmpDir, 'agents');
            fs.mkdirSync(agentsDir, { recursive: true });
            fs.writeFileSync(path.join(agentsDir, 'noexec.json'), JSON.stringify({
                id: 'noexec',
                name: 'No Exec',
            }));

            const store = new AgentRegistrationStore(tmpDir);
            expect(store.size).toBe(0);
        });

        it('handles malformed JSON gracefully', () => {
            const agentsDir = path.join(tmpDir, 'agents');
            fs.mkdirSync(agentsDir, { recursive: true });
            fs.writeFileSync(path.join(agentsDir, 'bad.json'), '{invalid json!!!');

            const store = new AgentRegistrationStore(tmpDir);
            expect(store.size).toBe(0);
        });

        it('defaults roles to [execution] when missing', () => {
            writeAgentFile(tmpDir, {
                id: 'legacy-agent',
                name: 'Legacy',
                execution: { type: 'subprocess', command: 'node' },
                // no roles field
            });

            const store = new AgentRegistrationStore(tmpDir);
            const agent = store.get('legacy-agent');
            expect(agent).toBeDefined();
            expect(agent!.roles).toEqual(['execution']);
        });

        it('ignores non-JSON files', () => {
            const agentsDir = path.join(tmpDir, 'agents');
            fs.mkdirSync(agentsDir, { recursive: true });
            fs.writeFileSync(path.join(agentsDir, 'readme.md'), '# Agents');
            fs.writeFileSync(path.join(agentsDir, 'data.txt'), 'hello');

            const store = new AgentRegistrationStore(tmpDir);
            expect(store.size).toBe(0);
        });
    });

    describe('get and getAll', () => {
        it('get returns undefined for unknown id', () => {
            const store = new AgentRegistrationStore(tmpDir);
            expect(store.get('nonexistent')).toBeUndefined();
        });

        it('getAll returns all registrations', () => {
            writeAgentFile(tmpDir, {
                id: 'a1', name: 'A1', execution: { type: 'x' }, roles: ['hunter'],
            });
            writeAgentFile(tmpDir, {
                id: 'a2', name: 'A2', execution: { type: 'x' }, roles: ['gatherer'],
            });

            const store = new AgentRegistrationStore(tmpDir);
            expect(store.getAll()).toHaveLength(2);
        });
    });

    describe('getByRole', () => {
        it('filters by role', () => {
            writeAgentFile(tmpDir, {
                id: 'h1', name: 'Hunter1', execution: { type: 'x' }, roles: ['hunter'],
            });
            writeAgentFile(tmpDir, {
                id: 'g1', name: 'Gatherer1', execution: { type: 'x' }, roles: ['gatherer'],
            });
            writeAgentFile(tmpDir, {
                id: 'h2', name: 'Hunter2', execution: { type: 'x' }, roles: ['hunter', 'gatherer'],
            });

            const store = new AgentRegistrationStore(tmpDir);
            const hunters = store.getByRole('hunter' as any);
            expect(hunters).toHaveLength(2);
            expect(hunters.map(h => h.id).sort()).toEqual(['h1', 'h2']);
        });

        it('returns empty for unmatched role', () => {
            writeAgentFile(tmpDir, {
                id: 'h1', name: 'Hunter', execution: { type: 'x' }, roles: ['hunter'],
            });

            const store = new AgentRegistrationStore(tmpDir);
            const judges = store.getByRole('judge' as any);
            expect(judges).toEqual([]);
        });
    });

    describe('register and unregister', () => {
        it('register adds in memory', () => {
            const store = new AgentRegistrationStore(tmpDir);
            expect(store.size).toBe(0);

            store.register({
                id: 'runtime-agent',
                name: 'Runtime',
                version: '1.0',
                description: 'test',
                roles: ['hunter'],
                execution: { type: 'subprocess', command: 'node' },
                interface: { inputs: [], outputs: [] },
                defaultTimeout: 30000,
            } as any);

            expect(store.size).toBe(1);
            expect(store.get('runtime-agent')).toBeDefined();
        });

        it('register with persist writes to disk', () => {
            const store = new AgentRegistrationStore(tmpDir);

            store.register({
                id: 'persisted-agent',
                name: 'Persisted',
                version: '1.0',
                description: 'test',
                roles: ['hunter'],
                execution: { type: 'subprocess', command: 'node' },
                interface: { inputs: [], outputs: [] },
                defaultTimeout: 30000,
            } as any, true);

            const filePath = path.join(tmpDir, 'agents', 'persisted-agent.json');
            expect(fs.existsSync(filePath)).toBe(true);

            const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            expect(onDisk.id).toBe('persisted-agent');
        });

        it('unregister removes from memory', () => {
            const store = new AgentRegistrationStore(tmpDir);
            store.register({
                id: 'temp',
                name: 'Temp',
                version: '1.0',
                description: 'test',
                roles: [],
                execution: { type: 'subprocess' },
                interface: { inputs: [], outputs: [] },
                defaultTimeout: 30000,
            } as any);

            expect(store.unregister('temp')).toBe(true);
            expect(store.size).toBe(0);
            expect(store.get('temp')).toBeUndefined();
        });

        it('unregister returns false for unknown id', () => {
            const store = new AgentRegistrationStore(tmpDir);
            expect(store.unregister('nonexistent')).toBe(false);
        });
    });

    describe('listIds', () => {
        it('returns all registration IDs', () => {
            writeAgentFile(tmpDir, {
                id: 'id-a', name: 'A', execution: { type: 'x' }, roles: [],
            });
            writeAgentFile(tmpDir, {
                id: 'id-b', name: 'B', execution: { type: 'x' }, roles: [],
            });

            const store = new AgentRegistrationStore(tmpDir);
            expect(store.listIds().sort()).toEqual(['id-a', 'id-b']);
        });
    });

    describe('reload', () => {
        it('reloads from disk, clearing runtime registrations', () => {
            writeAgentFile(tmpDir, {
                id: 'disk-agent', name: 'Disk', execution: { type: 'x' }, roles: [],
            });

            const store = new AgentRegistrationStore(tmpDir);
            store.register({
                id: 'runtime-only',
                name: 'Runtime',
                version: '1',
                description: 'test',
                roles: [],
                execution: { type: 'x' },
                interface: { inputs: [], outputs: [] },
                defaultTimeout: 30000,
            } as any);

            expect(store.size).toBe(2);

            store.reload();

            expect(store.size).toBe(1);
            expect(store.get('disk-agent')).toBeDefined();
            expect(store.get('runtime-only')).toBeUndefined();
        });
    });

    describe('getDiskDir', () => {
        it('returns the agents directory path', () => {
            const store = new AgentRegistrationStore(tmpDir);
            expect(store.getDiskDir()).toBe(path.join(tmpDir, 'agents'));
        });
    });

    describe('writeArtifacts', () => {
        it('writes artifact files to disk', () => {
            const store = new AgentRegistrationStore(tmpDir);

            const dir = store.writeArtifacts('my-agent', [
                { name: 'main.py', content: 'print("hello")' },
                { name: 'config.json', content: '{}' },
            ]);

            expect(dir).toBe(path.join(tmpDir, 'agents', 'my-agent'));
            expect(fs.readFileSync(path.join(dir, 'main.py'), 'utf-8')).toBe('print("hello")');
            expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')).toBe('{}');
        });

        it('creates subdirectory if missing', () => {
            const store = new AgentRegistrationStore(tmpDir);
            const dir = store.writeArtifacts('new-agent', [
                { name: 'script.sh', content: '#!/bin/bash' },
            ]);

            expect(fs.existsSync(dir)).toBe(true);
        });
    });
});
