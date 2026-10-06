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
import { composeFlow, type ComposerChatReply, type ComposerLlmClient } from './workflow-composer';

/**
 * What the composer sent when each prompt version and policy was measured.
 * Changing the composer's own wording is a new COMPOSER_PROMPT_VERSION;
 * changing a policy's instruction is a new policy id. Record a new digest only
 * together with the new version or id, so rolling back always restores the
 * prompt that was measured.
 */
const PINNED_PROMPTS: Record<string, string> = {
  'w8-2': '5bdcee40ff9b80373fd8b7906206753765dcc53eb0eaea25656f8b5e16ef021a',
};
const PINNED_POLICIES: Record<PlanningPolicy, string> = {
  'baseline-v1': fingerprint(''),
  'deterministic-first-v1': '8124918399601fe1905c7bfb57fd8f50fbed0e0c9992ddd7cbf3ca836125270a',
};

/** A small fixed catalog, so the pin moves with the composer's wording, not with shared fixtures. */
const catalog = () => new PieceCatalog([{ name: 'jarvis-notify', displayName: 'Jarvis: Notify', description: 'Send a notification.',
  actions: { notify: { name: 'notify', displayName: 'Notify', description: 'Notify the user.',
    inputSchema: { fields: [{ name: 'message', label: 'Message', type: 'long_text', required: true }] } } } }] as any);
const request = { name: 'Pinned job', description: 'On manual trigger, notify me "done". Never email anyone.' };
const valid = { displayName: request.name, trigger: { name: 'trigger', type: 'EMPTY',
  nextAction: { name: 'tell', type: 'PIECE', settings: { pieceName: 'jarvis-notify', actionName: 'notify', input: { message: 'done' } } } } };
const invalid = { displayName: request.name, trigger: { name: 'trigger', type: 'EMPTY',
  nextAction: { name: 'tell', type: 'PIECE', settings: { pieceName: 'missing', actionName: 'x', input: {} } } } };
/** The composer's instructions only: validation errors and the candidate context are data the validator words. */
const instructions = (text: string) => text.replace(/^ {2}- .*$/gm, '').replace(/Composition context \(JSON\):\n[\s\S]*$/, 'Composition context (JSON):\n<context>');

/** Every system and user prompt and tool definition the composer sends, on both paths, including a repair. */
async function sentPrompts(policy: PlanningPolicy) {
  const oneShot: unknown[] = [], toolLoop: unknown[] = [];
  let calls = 0;
  const plain: ComposerLlmClient = { async chat({ prompt, system }) {
    oneShot.push({ system, prompt: instructions(prompt) });
    return { text: JSON.stringify(++calls === 1 ? invalid : valid) };
  } };
  expect((await composeFlow({ llm: plain, pieceRegistry: catalog(), planningPolicy: policy }, request)).ok).toBe(true);
  let turns = 0;
  const tools: ComposerLlmClient = {
    async chat() { throw new Error('unexpected fallback'); },
    async chatTools(messages, definitions): Promise<ComposerChatReply> {
      toolLoop.push({ definitions, messages: messages.filter(m => m.role === 'system' || m.role === 'user')
        .map(m => ({ role: m.role, content: instructions(m.content) })) });
      return { content: '', tool_calls: [{ id: `t${turns}`, name: 'submit_flow', arguments: ++turns === 1 ? invalid : valid }] };
    },
  };
  expect((await composeFlow({ llm: tools, pieceRegistry: catalog(), planningPolicy: policy }, request)).ok).toBe(true);
  // A first attempt and its repair on each path.
  expect([oneShot.length, toolLoop.length]).toEqual([2, 2]);
  return { oneShot, toolLoop };
}

afterEach(() => configurePlanningPolicy(null));

describe('prompts are pinned to their versions', () => {
  test('the composer still sends what its prompt version measured', async () => {
    expect(PINNED_PROMPTS[COMPOSER_PROMPT_VERSION]).toBeDefined();
    expect(fingerprint(await sentPrompts('baseline-v1'))).toBe(PINNED_PROMPTS[COMPOSER_PROMPT_VERSION]!);
  });

  test('each policy id names fixed instruction text, added to both prompt paths and nothing else', async () => {
    expect(Object.keys(PINNED_POLICIES).sort()).toEqual([...PLANNING_POLICIES].sort());
    for (const policy of PLANNING_POLICIES) expect(`${policy}: ${fingerprint(policyInstructions()[policy])}`).toBe(`${policy}: ${PINNED_POLICIES[policy]}`);
    const base = await sentPrompts('baseline-v1'), candidate = await sentPrompts('deterministic-first-v1');
    const added = policyInstructions()['deterministic-first-v1'];
    const withInstruction = (sent: typeof base) => ({
      oneShot: sent.oneShot.map((c: any) => ({ ...c, system: c.system + added })),
      toolLoop: sent.toolLoop.map((c: any) => ({ ...c, messages: c.messages.map((m: any) => m.role === 'system' ? { ...m, content: m.content + added } : m) })),
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
