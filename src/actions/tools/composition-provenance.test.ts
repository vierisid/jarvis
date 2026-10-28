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
  // w8-16: reusable child workflows.
  'w8-16': {
    "bare": "ae9045d81a5058a78209a4ce5e2243ed2dd2d64ffb89708452fb9bbf6e0ec6b6",
    "production": "ae35704d9832fd418fb93c3f1e6bcc31d7b44e519f3ef1c1a0d4f05e4e2b5fb5",
    "hosted production": "9b31628a12174c74149ef84707855e96ad90cc434fc2e9b6310c252dd9624f04",
    "tool names only": "349a36b9684b78e6da5a310fc8a5dc133618078e9290ba216385aec03b10e1bf"
},

  // w8-15: durable lead batches.
  'w8-15': {
    "bare": "ae9045d81a5058a78209a4ce5e2243ed2dd2d64ffb89708452fb9bbf6e0ec6b6",
    "production": "ae35704d9832fd418fb93c3f1e6bcc31d7b44e519f3ef1c1a0d4f05e4e2b5fb5",
    "hosted production": "9b31628a12174c74149ef84707855e96ad90cc434fc2e9b6310c252dd9624f04",
    "tool names only": "349a36b9684b78e6da5a310fc8a5dc133618078e9290ba216385aec03b10e1bf"
},

  // w8-14: independent customer onboarding.
  'w8-14': {
    "bare": "ae9045d81a5058a78209a4ce5e2243ed2dd2d64ffb89708452fb9bbf6e0ec6b6",
    "production": "ae35704d9832fd418fb93c3f1e6bcc31d7b44e519f3ef1c1a0d4f05e4e2b5fb5",
    "hosted production": "9b31628a12174c74149ef84707855e96ad90cc434fc2e9b6310c252dd9624f04",
    "tool names only": "349a36b9684b78e6da5a310fc8a5dc133618078e9290ba216385aec03b10e1bf"
},

  // w8-13: exclusive support routing.
  'w8-13': {
    "bare": "ae9045d81a5058a78209a4ce5e2243ed2dd2d64ffb89708452fb9bbf6e0ec6b6",
    "production": "ae35704d9832fd418fb93c3f1e6bcc31d7b44e519f3ef1c1a0d4f05e4e2b5fb5",
    "hosted production": "9b31628a12174c74149ef84707855e96ad90cc434fc2e9b6310c252dd9624f04",
    "tool names only": "349a36b9684b78e6da5a310fc8a5dc133618078e9290ba216385aec03b10e1bf"
},

  // w8-12: workflow-meeting-briefs capabilities.
  'w8-12': {
    'bare': '2cb75d3294bf28ccb48093c7f9f7181846f2fab22a362dc18c337c970daa7644',
    'hosted production': '76c60995e2e5af8079cb51ad6af3e264b1ba77d5ad017a098331cf1c9f380ff1',
    'production': '3ffe8ff4ff3c0cd4561ab478dac950daf3aa285213b0ec268b2bfa02e059fbe9',
    'tool names only': '63de2acdd9b8e59ec723525a53091a8165fec872a738ac48f9c30b0685d63e13',
  },
  // w8-11: HubSpot contact coordination and qualified lead notifications.
  'w8-11': {
    'bare': '0607884f6f9ba78094b4bd40cf7747fd2bdda3ca35a6941a0e49ac92782a4be5',
    'hosted production': '89ca16182f441794efd6f24d5b4cba3f2f65c7afd1db21ef17a4fe550b2969e3',
    'production': '889e642ed640de1588234aedffd7d7de3a7f433aee32f546017d196752095c48',
    'tool names only': '3d369e555ab2afe1e1f3f266eae7cd9874d2d7441069234984b65daaf88fddb7',
  },
  // w8-10: invoice extraction, schema validation and complete readback.
  'w8-10': {
    'bare': '05263df749ecb38946893d74e1d4c189f65f8d730d45d41f28a917b708e70082',
    'hosted production': 'cb230bd1dd945e1aa339b5ddf7f6466047da42bf5d6f66d816906f1465c41544',
    'production': 'a0b0107f99d23e9569400d79daed03f121074d84a9fbef7f49365179ddadaa3f',
    'tool names only': 'e20bb23dc1a02fa9e0299331498dbc04ae6dada072b46665290f8cf130b0b9c9',
  },
  // w8-9: Gmail triage and persistent message admission.
  'w8-9': {
    'bare': '57d4704c8577c6fda9da6c11c64b8cb0524acac0ffc23624a2fc9890b65fdaec',
    'hosted production': '03bde7f6f985268d83e1e482adf981ec539566971d6e58cd453c7978072d44c6',
    'production': '96de39d26ed372d1fc3aa871106d1a4206a75fe80c5b32175de0a8f7b004803f',
    'tool names only': '0ae7d1e35a57b0b531036d328115cba3ba710a28cdffd11dbfe06b4105df60aa',
  },
  // w8-8: deferred setup, connector continuation and form processing.
  'w8-8': {
    'bare': '2e7622eb199df8f1ea33d8a77d686b34e1282028823f818719132b07b4949b80',
    'hosted production': '8efd7c5dd6ee559f9758e716de4c70665ff3e64bd16f0a91e47bf923fc7492f6',
    'production': '546b58cc39e2a413ef9702b53b22c4ce7544b6bd2df3ec0a95fcf57a2367d469',
    'tool names only': 'a2ec151afbc98276e6d31d667a2cd1bf3c91eddd055d5748ba7ab5dd1a46c78c',
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
