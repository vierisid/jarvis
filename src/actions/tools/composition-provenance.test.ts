import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, initWorkflowDb } from '../../workflows/db/index';
import { getWorkflowComposition } from '../../workflows/db/repos/workflow-composition';
import { PieceCatalog } from '../../workflows/runtime/piece-catalog';
import {
  activePlanningPolicy, COMPOSER_PROMPT_VERSION, configurePlanningPolicy, DEFAULT_PLANNING_POLICY, fingerprint,
  PLANNING_POLICIES, policyInstructions, snapshotComposition, type PlanningPolicy,
} from './composition-provenance';
import { composePersistedFlow } from './persisted-workflow-composer';
import { composeFlow, type ComposeDeps, type ComposerChatReply, type ComposerLlmClient } from './workflow-composer';

/**
 * What the composer sent when each prompt version and policy was measured, in
 * each environment shape production uses. Changing the composer's own wording
 * is a new COMPOSER_PROMPT_VERSION; changing a policy's instruction is a new
 * policy id. Record new digests only together with the new version or id, so
 * rolling back always restores the prompt that was measured.
 */
const PINNED_PROMPTS: Record<string, Record<string, string>> = {
  'w8-2': {
    bare: '30611449358646e651994a5dfba50bf850c69afb4968b99008a8cd0c64cccfa9',
    production: 'bb58575f4437263fb084bd5e34e8e24c046335ebda9e3ce3da3f3750f5a09e84',
    'hosted production': 'c262301771d7e0f5466584b9d03cf87d359f9ed194dfc720be7eaf294f3e4f6a',
    'tool names only': '1219234f35ed3085d13fc04f0f8df28b54e162c24bd56932e42a5dafd587f705',
  },
};
const PINNED_POLICIES: Record<PlanningPolicy, string> = {
  'baseline-v1': fingerprint(''),
  'deterministic-first-v1': '8124918399601fe1905c7bfb57fd8f50fbed0e0c9992ddd7cbf3ca836125270a',
};

/**
 * A small fixed catalog and environments, so the pin moves with the
 * composer's wording, not with shared fixtures. The one-shot catalog listing
 * also renders the workflow event types, so changing those moves the pin too:
 * they are part of what the composer is shown.
 */
const catalog = () => new PieceCatalog([{ name: 'jarvis-notify', displayName: 'Jarvis: Notify', description: 'Send a notification.',
  actions: { notify: { name: 'notify', displayName: 'Notify', description: 'Notify the user.',
    inputSchema: { fields: [{ name: 'message', label: 'Message', type: 'long_text', required: true }] } } } }] as any);
const tool = (name: string, ...params: string[]) => ({ name, description: `The ${name} tool.`,
  params: params.map(p => ({ name: p, type: 'string', required: true, description: `The ${p}.` })) });
const PRODUCTION: Partial<ComposeDeps> = {
  tools: [tool('write_file', 'path', 'content'), tool('read_file', 'path')],
  specialistRoles: [{ id: 'research-analyst', name: 'Research Analyst', description: 'Finds and summarizes sources.' }],
  library: [{ id: 'discord', npmPackage: '@activepieces/piece-discord', displayName: 'Discord', description: 'Post to Discord channels.' }],
  executionTargets: [
    { id: '', name: 'This computer', os: 'darwin', arch: 'arm64', connected: true, isHost: true, capabilities: ['filesystem'] },
    { id: 'studio', name: 'Studio PC', os: 'windows', arch: 'amd64', connected: false, capabilities: ['filesystem'] },
    { id: 'server', name: 'Build server', os: 'linux', arch: 'amd64', connected: true, capabilities: ['filesystem'] },
  ] as any,
};
/** The shapes production composes in: detailed tools, roles, a library and mixed machines; hosted installs show no library. */
const ENVIRONMENTS: Record<string, Partial<ComposeDeps>> = {
  bare: {},
  production: PRODUCTION,
  'hosted production': { ...PRODUCTION, library: undefined },
  'tool names only': { toolNames: ['write_file', 'read_file'] },
};
const request = { name: 'Pinned job', description: 'On manual trigger, notify me "done". Never email anyone.' };
const valid = { displayName: request.name, trigger: { name: 'trigger', type: 'EMPTY',
  nextAction: { name: 'tell', type: 'PIECE', settings: { pieceName: 'jarvis-notify', actionName: 'notify', input: { message: 'done' } } } } };
const invalid = { displayName: request.name, trigger: { name: 'trigger', type: 'EMPTY',
  nextAction: { name: 'tell', type: 'PIECE', settings: { pieceName: 'missing', actionName: 'x', input: {} } } } };
const MARKER = 'Composition context (JSON):\n';
/** A prompt with what the validator writes taken out: the reported errors and the candidate context. Everything else is the composer's. */
function instructions(text: string): string {
  const at = text.indexOf(MARKER);
  if (at < 0) return text;
  const errors: string[] = JSON.parse(text.slice(at + MARKER.length)).errors ?? [];
  const head = text.slice(0, at);
  return (errors.length ? head.replace('\n' + errors.map(e => `  - ${e}`).join('\n'), '\n<errors>') : head) + MARKER + '<context>';
}

/** Every system, user and tool-result message and tool definition the composer sends, on both paths, through a repair. */
async function sentPrompts(policy: PlanningPolicy, environment: Partial<ComposeDeps> = {}) {
  const oneShot: unknown[] = [], toolLoop: Array<{ definitions: unknown; messages: Array<{ role: string; content: string }> }> = [];
  let calls = 0;
  const plain: ComposerLlmClient = { async chat({ prompt, system }) {
    oneShot.push({ system, prompt: instructions(prompt) });
    return { text: JSON.stringify(++calls === 1 ? invalid : valid) };
  } };
  expect((await composeFlow({ ...environment, llm: plain, pieceRegistry: catalog(), planningPolicy: policy }, request)).ok).toBe(true);
  let turns = 0;
  const tools: ComposerLlmClient = {
    async chat() { throw new Error('unexpected fallback'); },
    async chatTools(messages, definitions): Promise<ComposerChatReply> {
      // System prompts verbatim; the composer's user prompts and tool results with the validator's words taken out.
      toolLoop.push({ definitions, messages: messages.filter(m => m.role !== 'assistant')
        .map(m => ({ role: m.role, content: m.role === 'system' ? m.content : instructions(m.content) })) });
      return { content: '', tool_calls: [{ id: `t${turns}`, name: 'submit_flow', arguments: ++turns === 1 ? invalid : valid }] };
    },
  };
  expect((await composeFlow({ ...environment, llm: tools, pieceRegistry: catalog(), planningPolicy: policy }, request)).ok).toBe(true);
  // A first attempt and its repair on each path; the tool loop sends its repair as a tool result.
  expect([oneShot.length, toolLoop.length]).toEqual([2, 2]);
  expect(toolLoop[1]!.messages.map(m => m.role)).toContain('tool');
  return { oneShot, toolLoop };
}

afterEach(() => configurePlanningPolicy(null));

describe('prompts are pinned to their versions', () => {
  test('the composer still sends what its prompt version measured, in every environment shape production uses', async () => {
    const sent: Record<string, string> = {};
    for (const [shape, environment] of Object.entries(ENVIRONMENTS)) sent[shape] = fingerprint(await sentPrompts('baseline-v1', environment));
    expect(sent).toEqual(PINNED_PROMPTS[COMPOSER_PROMPT_VERSION]!);
  });

  test('each policy id names fixed instruction text, added to both system prompts and nothing else', async () => {
    expect(Object.keys(PINNED_POLICIES).sort()).toEqual([...PLANNING_POLICIES].sort());
    for (const policy of PLANNING_POLICIES) expect(`${policy}: ${fingerprint(policyInstructions()[policy])}`).toBe(`${policy}: ${PINNED_POLICIES[policy]}`);
    const base = await sentPrompts('baseline-v1', PRODUCTION), candidate = await sentPrompts('deterministic-first-v1', PRODUCTION);
    const added = policyInstructions()['deterministic-first-v1'];
    const withInstruction = (sent: typeof base) => ({
      oneShot: sent.oneShot.map((c: any) => ({ ...c, system: c.system + added })),
      toolLoop: sent.toolLoop.map(c => ({ ...c, messages: c.messages.map(m => m.role === 'system' ? { ...m, content: m.content + added } : m) })),
    });
    expect(candidate).toEqual(withInstruction(base));
  });
});

describe('production policy selection', () => {
  const deps = () => ({ llm: { async chat() { return { text: '' }; } }, pieceRegistry: catalog() });

  test('unset, the default runs; configured, the selector is read at each composition; an explicit policy wins', () => {
    expect(snapshotComposition(deps()).provenance.planningPolicy).toBe(DEFAULT_PLANNING_POLICY);
    let selected: PlanningPolicy = 'deterministic-first-v1';
    configurePlanningPolicy(() => selected);
    expect([activePlanningPolicy(), snapshotComposition(deps()).provenance.planningPolicy]).toEqual(['deterministic-first-v1', 'deterministic-first-v1']);
    selected = 'baseline-v1';
    expect(snapshotComposition(deps()).provenance.planningPolicy).toBe('baseline-v1');
    expect(snapshotComposition({ ...deps(), planningPolicy: 'deterministic-first-v1' }).provenance.planningPolicy).toBe('deterministic-first-v1');
    // Clearing the selector restores the default even while the old selector would still pick the candidate.
    selected = 'deterministic-first-v1';
    configurePlanningPolicy(null);
    expect(activePlanningPolicy()).toBe(DEFAULT_PLANNING_POLICY);
  });

  test('a direct composer call without a policy follows the selector too', async () => {
    configurePlanningPolicy(() => 'deterministic-first-v1');
    const systems: string[] = [];
    const llm: ComposerLlmClient = { async chat({ system }) { systems.push(system ?? ''); return { text: JSON.stringify(valid) }; } };
    expect((await composeFlow({ llm, pieceRegistry: catalog() }, request)).ok).toBe(true);
    expect(systems[0]!.endsWith(policyInstructions()['deterministic-first-v1'])).toBe(true);
  });

  // The daemon is the one production installer: without it every composition silently runs the default.
  test('the daemon installs the live selector from the workflows setting', () => {
    const daemon = readFileSync(join(import.meta.dir, '..', '..', 'daemon', 'index.ts'), 'utf8');
    expect(daemon).toContain('configurePlanningPolicy(() => resolvePlanningPolicy(jarvisConfig.workflows?.planningPolicy));');
  });

  describe('through the production composer', () => {
    let directory: string;
    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'jarvis-planning-policy-'));
      initWorkflowDb(join(directory, 'test.db'));
    });
    afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

    test('each composition records the policy that ran and sends its prompt; switching back rolls back the next one', async () => {
      const systems: string[] = [];
      const llm: ComposerLlmClient = { async chat({ system }) { systems.push(system ?? ''); return { text: JSON.stringify(valid) }; } };
      let selected: PlanningPolicy = 'deterministic-first-v1';
      configurePlanningPolicy(() => selected);
      const promoted = await composePersistedFlow({ llm, pieceRegistry: catalog() }, request);
      selected = 'baseline-v1';
      const rolledBack = await composePersistedFlow({ llm, pieceRegistry: catalog() }, request);
      const policyOf = (id: string) => getWorkflowComposition(id)!.specification.provenance!.planningPolicy;
      expect([policyOf(promoted.compositionRecordId), policyOf(rolledBack.compositionRecordId)]).toEqual(['deterministic-first-v1', 'baseline-v1']);
      const added = policyInstructions()['deterministic-first-v1'];
      expect(systems).toEqual([expect.stringContaining(added), expect.any(String)]);
      expect(systems[1]).toBe(systems[0]!.slice(0, -added.length));
    });
  });
});
