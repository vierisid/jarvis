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
  // w8-13: read-only meeting briefs with reschedule-safe dashboard notifications.
  'w8-13': {
    bare: '310abe10f6b3e4312877dd63e3d913a931a4f1ec85039f711ddd503ae5bdfc81',
    production: 'be2c1c21b357ef8006c9e6013aa4731e71ecd0e17d8593b6f78b70c0ff8bebd0',
    'hosted production': '80eb7d677570c54fa6fd94a7ac6abad604f7e98e2e0108f08b899e9f16ee5331',
    'tool names only': 'd9a6d28fa4d0dab04d9ce67793ae31f60d0ec11fbcdd017193cc3b8092ac170f',
  },
  // w8-12: HubSpot contact coordination, keyed lead notifications and resolve_effect for uncertain identities.
  'w8-12': {
    bare: 'b7d8e23f84b712632c305e25bbb2f6621212d35cf2667f1c38a9c2f584a75525',
    production: '9cecfe12f86ec7cf1807d657fc2d5d3ca1c3898e863e7026f9fa25569aebd421',
    'hosted production': '5c31d8a82984ac9baf5dae74d054c4833f489ea82c641d84d7406138a3540c4b',
    'tool names only': '5c4739f7a173b7ad9644a5cc1034bf560eee1d67b38735f504ab730e521d7053',
  },
  // w8-11: invoice extraction, schema validation and complete readback.
  'w8-11': {
    bare: '75efb1295411133d02534d3b1f92363370d634aad4ddadf11df132a929544d79',
    production: 'cbed103e2327dbfc97961cacbd1e0c32d6c044cda703b7b48dfb449e2da15f82',
    'hosted production': '478b71ed5780ee2a5f0e16b39fd59389f6cb52918334ba5295a4665cf5ce7f2d',
    'tool names only': '4ef91135e7dcff0980a28318bc721e5e7af84c75864d36ab04edb66aa2aa5575',
  },
  // w8-10: Gmail triage, persistent message admission covering manual runs only when they carry a payload.id.
  'w8-10': {
    bare: '21cc6e0220440ff1fe3217a63b8d483c8bdfc737d03aa28af57d321dbe9e836e',
    production: '1088d9babdd3a8d10b38cf87f1435e498e95d6263d89bb35d337496840cf247e',
    'hosted production': 'f6283bdb24ca178b75917cfd6784ce7cf5141ce67d6d094cfa31f198eabcbd31',
    'tool names only': 'b317e86b850c113b217af53300694a222880ed1325e61f21cd7283c1df802024',
  },
  // w8-9: deferred setup, connector continuation and form processing; the composer never installs.
  'w8-9': {
    bare: '0e5ea5dffb6128bb806328d5cb23715f9a1ba256ca8ef3842d480baa71130901',
    production: '9b78e90b24a95a83548b061a83a2d44e8e5aa8d91176ff3ffc9f5df066ab560e',
    'hosted production': 'aa07ed478ff210e49b2b967b274ab21fdeb489d98c115454767f582b8d217de2',
    'tool names only': 'dba35e1b068c4ecbb581c43b1eff267575cd35b392a9a631edbc60d2a3528aa6',
  },
  // w8-8: a schedule names a time zone only when the job contract does; a bare time is Jarvis's zone.
  'w8-8': {
    bare: '0b7e8cc85a1f50a5411c050a7b2286a8236ad400367feed39f04f57c6ae56496',
    production: 'ced53dbe7a008e923abc9694e3f52d44fde5156e7503b3a1d1923a635a7df466',
    'hosted production': '9dec78536da3bcd905dc0c854bfcb767fda12073e9c9e5ce9a12c8222d586fda',
    'tool names only': 'c35f5d375dfacfa242c841699cc31103ee6726ed71208f53be69e2c2ab0de478',
  },
  // w8-7: inspect browser fallback before refusing missing connector setup.
  'w8-7': {
    bare: '79604471f26e16b11f4deb6edbe2cab47ef1f00db537552f941868629d3d0398',
    production: 'b5aeaacab78d6cc49a7114a0e0a78c999223c770ec77823baede1c502bb0633f',
    'hosted production': '8ac8119fae556bb38786262ea77c29cf603ffb3fe7d3bab60a2aad8cfc86a4d0',
    'tool names only': '3214fa331beaf6102355ce7b1ae40f10c3233aa86f8b9af7c64982e434b27d1b',
  },
  // w8-6: timezone discovery, Library installation, account binding and browser fallback rules.
  'w8-6': {
    bare: '382e95a19295d50c84df2d0e145a16fc91ce3df2eda7d9f8702fb317415c25ec',
    production: '44f7016457a38ea9d6cd89962b27304fb5fbdf601c4e40f9655b2e528bddf518',
    'hosted production': '2ddabb25acb07cfe34a0303a0ff2fb89203133eb8e4a68beb420573d510bbd76',
    'tool names only': '9ee9f57faaf5b943916e5f96905d11a72aa9306aaef95398c5a4018b36b2eebd',
  },
  // w8-3 (#1065) fences catalog, tool, role and repair text as untrusted content.
  'w8-3': {
    bare: '62395ceb35fe6215beb7a36a19338c5a706f5bf9283e95bf339d400d314fbeee',
    production: '7d92d0ae8835f01920dc93386697199cd8a9cf4d28d6658fb6c8aab0b24d9d62',
    'hosted production': '50b09c7486cfd034ad8e1ce36df92e5869d78cedd1dab6d87ffa251d1ca00968',
    'tool names only': '5f053e6a131f0eae15ee8756433f4657938fa2f41867b3b5e4a3e2e861ae1a1a',
  },
  // w8-4 (F-08) adds the typed-ingredient instruction, sent only with selected
  // ingredients (composition-ingredients.test.ts pins it); without them the
  // prompts are byte-identical to w8-3.
  'w8-4': {
    bare: '62395ceb35fe6215beb7a36a19338c5a706f5bf9283e95bf339d400d314fbeee',
    production: '7d92d0ae8835f01920dc93386697199cd8a9cf4d28d6658fb6c8aab0b24d9d62',
    'hosted production': '50b09c7486cfd034ad8e1ce36df92e5869d78cedd1dab6d87ffa251d1ca00968',
    'tool names only': '5f053e6a131f0eae15ee8756433f4657938fa2f41867b3b5e4a3e2e861ae1a1a',
  },
  // w8-5 adds human-readable trigger and action labels to both composer paths.
  'w8-5': {
    bare: '41a5c1b342330f660916dea599a42626057f0b4a1963f5beee9ddaa15e37c556',
    production: '4f67a0b66e587a9520c024009c1be166d6250c8d39c9eb6738cf4eaa3fc5c7a5',
    'hosted production': '405b7af3c2e676305b613659d12334820e0fa485630e68451493806062932b07',
    'tool names only': '4f32051ea90de5cd65eb4da745b94eee805e2986372938b6037f159019b7930f',
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
/** Untrusted-content fences carry a fresh nonce per call; the pin is on the words around them, not the nonce. */
const stable = (text: string) => text.replace(/([0-9a-f]{32})( UNTRUSTED_CONTENT>>>)/g, '<nonce>$2')
  .replace(/(<<<UNTRUSTED_CONTENT )[0-9a-f]{32}/g, '$1<nonce>');
const CLOSE = '\n<nonce> UNTRUSTED_CONTENT>>>';
/** A prompt with what the validator writes taken out: the reported errors and the candidate context. Everything else is the composer's. */
function instructions(raw: string): string {
  const text = stable(raw);
  const at = text.indexOf(MARKER);
  if (at < 0) return text;
  const end = text.indexOf(CLOSE, at);
  const json = end < 0 ? text.slice(at + MARKER.length) : text.slice(at + MARKER.length, end);
  const errors: string[] = JSON.parse(json).errors ?? [];
  const head = text.slice(0, at);
  return (errors.length ? head.replace('\n' + errors.map(e => `  - ${e}`).join('\n'), '\n<errors>') : head) + MARKER + '<context>'
    + (end < 0 ? '' : text.slice(end));
}

/** Every system, user and tool-result message and tool definition the composer sends, on both paths, through a repair. */
async function sentPrompts(policy: PlanningPolicy, environment: Partial<ComposeDeps> = {}) {
  const oneShot: unknown[] = [], toolLoop: Array<{ definitions: unknown; messages: Array<{ role: string; content: string }> }> = [];
  let calls = 0;
  const plain: ComposerLlmClient = { async chat({ prompt, system }) {
    oneShot.push({ system: stable(system ?? ''), prompt: instructions(prompt) });
    return { text: JSON.stringify(++calls === 1 ? invalid : valid) };
  } };
  expect((await composeFlow({ ...environment, llm: plain, pieceRegistry: catalog(), planningPolicy: policy }, request)).ok).toBe(true);
  let turns = 0;
  const tools: ComposerLlmClient = {
    async chat() { throw new Error('unexpected fallback'); },
    async chatTools(messages, definitions): Promise<ComposerChatReply> {
      // System prompts verbatim; the composer's user prompts and tool results with the validator's words taken out.
      toolLoop.push({ definitions, messages: messages.filter(m => m.role !== 'assistant')
        .map(m => ({ role: m.role, content: m.role === 'system' ? stable(m.content) : instructions(m.content) })) });
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
      const llm: ComposerLlmClient = { async chat({ system }) { systems.push(stable(system ?? '')); return { text: JSON.stringify(valid) }; } };
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
