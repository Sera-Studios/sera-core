/**
 * @fileoverview Tests for agent role classification (Spec 0.5)
 *
 * Verifies that AgentRegistration.roles works correctly for filtering
 * execution vs evaluation agents across the store, REST API, and MCP.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRegistrationStore } from '../agents/AgentRegistrationStore';
import type { AgentRegistration } from '@sera/types';

let tempDir: string;
let store: AgentRegistrationStore;

function makeRegistration(overrides: Partial<AgentRegistration> & { id: string }): AgentRegistration {
    return {
        name: overrides.id,
        version: '0.1.0',
        description: 'test',
        roles: ['execution'],
        execution: { type: 'script', interpreter: 'node', scriptPath: 'test.js' },
        interface: { inputs: [], outputs: [] },
        defaultTimeout: 30,
        ...overrides,
    } as AgentRegistration;
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-role-test-'));
    const agentsDir = path.join(tempDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('AgentRegistrationStore roles', () => {
    it('defaults missing roles to [execution] when loading from disk', () => {
        const agentsDir = path.join(tempDir, 'agents');
        // Write a registration without roles
        const reg = { id: 'old-agent', name: 'Old', version: '0.1.0', description: 'test',
            execution: { type: 'script', interpreter: 'node', scriptPath: 'x.js' },
            interface: { inputs: [], outputs: [] }, defaultTimeout: 30 };
        fs.writeFileSync(path.join(agentsDir, 'old-agent.json'), JSON.stringify(reg));

        store = new AgentRegistrationStore(tempDir);
        const loaded = store.get('old-agent');
        expect(loaded).toBeDefined();
        expect(loaded!.roles).toEqual(['execution']);
    });

    it('preserves roles: [evaluation] from disk', () => {
        const agentsDir = path.join(tempDir, 'agents');
        const reg = makeRegistration({ id: 'eval-agent', roles: ['evaluation'] });
        fs.writeFileSync(path.join(agentsDir, 'eval-agent.json'), JSON.stringify(reg));

        store = new AgentRegistrationStore(tempDir);
        const loaded = store.get('eval-agent');
        expect(loaded!.roles).toEqual(['evaluation']);
    });

    it('preserves roles: [execution, evaluation] from disk', () => {
        const agentsDir = path.join(tempDir, 'agents');
        const reg = makeRegistration({ id: 'dual-agent', roles: ['execution', 'evaluation'] });
        fs.writeFileSync(path.join(agentsDir, 'dual-agent.json'), JSON.stringify(reg));

        store = new AgentRegistrationStore(tempDir);
        const loaded = store.get('dual-agent');
        expect(loaded!.roles).toEqual(['execution', 'evaluation']);
    });

    it('getByRole filters to agents that include the role', () => {
        store = new AgentRegistrationStore(tempDir);
        store.register(makeRegistration({ id: 'hunter', roles: ['execution'] }));
        store.register(makeRegistration({ id: 'judge', roles: ['execution', 'evaluation'] }));
        store.register(makeRegistration({ id: 'scorer', roles: ['evaluation'] }));

        const execAgents = store.getByRole('execution');
        expect(execAgents.map(a => a.id).sort()).toEqual(['hunter', 'judge']);

        const evalAgents = store.getByRole('evaluation');
        expect(evalAgents.map(a => a.id).sort()).toEqual(['judge', 'scorer']);
    });

    it('agent with both roles appears in both filtered results', () => {
        store = new AgentRegistrationStore(tempDir);
        store.register(makeRegistration({ id: 'judge', roles: ['execution', 'evaluation'] }));

        expect(store.getByRole('execution')).toHaveLength(1);
        expect(store.getByRole('evaluation')).toHaveLength(1);
        expect(store.getByRole('execution')[0].id).toBe('judge');
        expect(store.getByRole('evaluation')[0].id).toBe('judge');
    });

    it('getAll returns all regardless of role', () => {
        store = new AgentRegistrationStore(tempDir);
        store.register(makeRegistration({ id: 'a', roles: ['execution'] }));
        store.register(makeRegistration({ id: 'b', roles: ['evaluation'] }));
        store.register(makeRegistration({ id: 'c', roles: ['execution', 'evaluation'] }));

        expect(store.getAll()).toHaveLength(3);
    });
});
