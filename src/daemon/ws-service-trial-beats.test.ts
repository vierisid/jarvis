import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketService } from './ws-service.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { loadUserSection } from './user-settings.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import type { WorkflowProposal } from './trial/beats.ts';

/**
 * The four things the room beats need that are not a local vault write, tested
 * at the seam where they meet the daemon's service graph.
 *
 * beats.ts is tested against injected doubles, which is right: it is a ledger
 * and it should not know what a tool registry is. What that leaves untested is
 * exactly the layer here, where a compose result is parsed, a settings section
 * is written, and a specialist is chosen. All three have failed silently
 * before in products like this: a flow reported live that never published, a
 * brief hour written to a section nothing reads, a spawn that picked a role
 * that does not exist.
 */

const shippedConfig = (): JarvisConfig => structuredClone(DEFAULT_CONFIG);

type ToolCall = Record<string, unknown>;

function makeService(opts: {
  config?: JarvisConfig;
  workflowTool?: { execute: (p: ToolCall) => Promise<unknown> };
  /** A build where manage_workflow was never registered. */
  noWorkflowTool?: boolean;
  specialists?: Map<string, { id: string; name: string }>;
} = {}) {
  const config = opts.config ?? shippedConfig();
  const calls: ToolCall[] = [];
  const registry = {
    get: (name: string) =>
      name === 'manage_workflow' && !opts.noWorkflowTool
        ? (opts.workflowTool ?? {
          execute: async (p: ToolCall) => {
            calls.push(p);
            return p.action === 'compose'
              ? JSON.stringify({ ok: true, flow: { id: 'flow-1' }, versionId: 'v1' })
              : JSON.stringify({ ok: true });
          },
        })
        : undefined,
  };
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => config,
    getOrchestrator: () => ({ getToolRegistry: () => registry }),
    getTaskManager: () => null,
    getSpecialists: () => opts.specialists ?? new Map(),
    getLLMManager: () => ({}),
  } as never;
  const svc = new WebSocketService(0, fakeAgent);
  return {
    svc,
    config,
    calls,
    internals: svc as unknown as {
      trialPublishWorkflow: (p: WorkflowProposal) => Promise<{ ok: boolean; detail: string }>;
      trialSetMorningBrief: (hour: number, minute: number) => void;
      trialSetAuthorityLevel: (level: number) => number;
      trialSpawnResearchAgent: (q: string, b: string) => Promise<unknown>;
    },
  };
}

const proposal: WorkflowProposal = {
  beat: 'workflows',
  name: 'Monday pipeline review',
  runsWhen: 'Mondays at 8',
  steps: ['Pull every open deal', 'Flag anything untouched for 10 days'],
  never: 'send anything to a client on its own',
};

let secretsDir: string;
let prevSecretsDir: string | undefined;

beforeEach(() => {
  prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
  secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-trial-beats-'));
  process.env.JARVIS_SECRETS_DIR = secretsDir;
  closeDb();
  initDatabase(':memory:');
});
afterEach(() => {
  closeDb();
  if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
  else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
  rmSync(secretsDir, { recursive: true, force: true });
});

describe('beat 10, the workflow the founder agreed to', () => {
  test('is composed and then published, in that order, from what was proposed', async () => {
    const { internals, calls } = makeService();
    const res = await internals.trialPublishWorkflow(proposal);

    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.action)).toEqual(['compose', 'publish']);
    expect(calls[0]!.name).toBe('Monday pipeline review');
    // Everything the founder heard is in the description the composer gets:
    // the steps, when it runs, and the line it must not cross.
    const description = String(calls[0]!.description);
    expect(description).toContain('Pull every open deal');
    expect(description).toContain('Mondays at 8');
    expect(description).toContain('never send anything to a client on its own');
    expect(calls[1]!.flow).toBe('flow-1');
  });

  test('a compose that fails is reported as a failure, not published anyway', async () => {
    const calls: ToolCall[] = [];
    const { internals } = makeService({
      workflowTool: {
        execute: async (p) => {
          calls.push(p);
          return JSON.stringify({ ok: false, errors: ['no piece can read that inbox'] });
        },
      },
    });
    const res = await internals.trialPublishWorkflow(proposal);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('no piece can read that inbox');
    expect(calls.map((c) => c.action)).toEqual(['compose']);
  });

  test('a compose that succeeds but will not publish is not reported as live', async () => {
    const { internals } = makeService({
      workflowTool: {
        execute: async (p) => {
          if (p.action === 'compose') return JSON.stringify({ ok: true, flow: { id: 'flow-1' } });
          throw new Error('no published version');
        },
      },
    });
    const res = await internals.trialPublishWorkflow(proposal);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('would not publish');
  });

  test('an install with no workflow runtime says so rather than throwing at the founder', async () => {
    const { internals } = makeService({ noWorkflowTool: true });
    const res = await internals.trialPublishWorkflow(proposal);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('not running on this install');
  });
});

describe('beat 09, the brief hour', () => {
  test('is written where the goal rhythm actually reads it', () => {
    const { internals, config } = makeService();
    internals.trialSetMorningBrief(7, 30);

    expect(config.goals?.morning_window.start).toBe(7);
    expect(config.goals?.morning_minute).toBe(30);
    // And persisted, not just held in memory: a daemon restart must wake up
    // with the hour the founder chose out loud.
    const stored = loadUserSection('goals') as { morning_window?: { start: number }; morning_minute?: number };
    expect(stored.morning_window?.start).toBe(7);
    expect(stored.morning_minute).toBe(30);
  });

  test('leaves the rest of the goal config alone', () => {
    const config = shippedConfig();
    config.goals = {
      enabled: true,
      morning_window: { start: 9, end: 11 },
      evening_window: { start: 21, end: 23 },
      accountability_style: 'supportive',
      escalation_weeks: { pressure: 2, root_cause: 4, suggest_kill: 6 },
      auto_decompose: false,
      calendar_ownership: true,
    };
    const { internals } = makeService({ config });
    internals.trialSetMorningBrief(6, 0);

    expect(config.goals.accountability_style).toBe('supportive');
    expect(config.goals.evening_window).toEqual({ start: 21, end: 23 });
    expect(config.goals.calendar_ownership).toBe(true);
    expect(config.goals.morning_window.start).toBe(6);
  });
});

describe('beat 11, the authority level', () => {
  test('is written to the section the engine reloads from', () => {
    const { internals, config } = makeService();
    expect(internals.trialSetAuthorityLevel(5)).toBe(5);
    expect(config.authority.default_level).toBe(5);
    const stored = loadUserSection('authority') as { default_level?: number };
    expect(stored.default_level).toBe(5);
  });

  test('does not touch the governed categories or the emergency state', () => {
    const config = shippedConfig();
    const governed = [...config.authority.governed_categories];
    const { internals } = makeService({ config });
    internals.trialSetAuthorityLevel(5);
    expect(config.authority.governed_categories).toEqual(governed);
    expect(config.authority.emergency_state).toBe('normal');
  });
});

describe('beat 12, the research agent', () => {
  test('refuses out loud on an install with no sub-agents rather than half-finishing', async () => {
    const { internals } = makeService();
    await expect(internals.trialSpawnResearchAgent('what do they charge', 'compare prices'))
      .rejects.toThrow(/sub-agents are not running/);
  });
});
