/**
 * #571: #570's before/after filter table, re-measured on a HOSTED-shaped
 * config.
 *
 * #570 measured on the classic path, where `decideTools` is reached with a
 * plain `[{user: ask}]` buffer at tier `medium` against a local model. That is
 * not the shape a hosted install has, and #571 is the issue about hosted, so
 * the numbers that prove it closed have to be taken here.
 *
 * Two hosted shapes, because they behave very differently and only one of them
 * is the common case:
 *
 *  A. HOSTED-MANAGED. `USEJARVIS_TIER_DEFAULTS` fills every empty tier slot
 *     with `usejarvis_ai:uj-*` (daemon/usejarvis-ai.ts), and `usejarvis` is in
 *     `FRONTIER_VETO` (tool-relevance/model-class.ts), matched against the
 *     provider name as well as the model id. So `isTierEligible` fails and the
 *     relevance filter NEVER ENGAGES. The candidate set degenerates to pure
 *     withholding, the pin and the substitution rule never run, and the
 *     dispatch check is the only thing that can refuse a call. This is the
 *     single most important fact about enforcement on hosted, and it is the
 *     reason #571 orders the work dispatch-first.
 *
 *  B. CONV TIER + LOCAL TASK MODEL. A conversation tier is configured (so
 *     `streamMessage` takes the conv branch, which is what #571 is about) but
 *     the task tiers run a small local model, so the filter DOES engage. This
 *     is the only hosted-shaped config where the substitution rule is live, so
 *     it is where the rule is re-measured.
 *
 * The message buffer is the real one too: `processTaskCall` builds
 * `[...systemMessages, { user: originalMessage }]`, and on resume the saved
 * buffer with a reply appended. `windowedParts` skips system messages
 * (selection.ts), so the template note and the executor framing cannot pull
 * triggers -- asserted below rather than assumed, because it is the reason
 * #570's classic numbers transfer at all.
 */
import { describe, expect, test } from 'bun:test';
import { buildProductionRegistry } from './production-registry.ts';
import { decideTools } from './tool-relevance/filter.ts';
import { ToolExposureLedger } from './tool-relevance/ledger.ts';
import { PROJECT_SITE_CHAT_SCOPE, toolsInScope } from './tool-scope.ts';
import type { ToolFilterPolicy } from './tool-relevance/policy.ts';
import type { TierMap } from '../../llm/tiers.ts';
import type { LLMMessage } from '../../llm/provider.ts';
import { USEJARVIS_PROVIDER_NAME, USEJARVIS_KIND } from '../../daemon/usejarvis-ai.ts';

const PROD = await buildProductionRegistry();
const ALL = PROD.tools;
const SCOPED = toolsInScope(ALL, PROJECT_SITE_CHAT_SCOPE);
const ON: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: [] };

/** Shape A: what a hosted install's tier map actually resolves to. */
const HOSTED_TIERS: TierMap = {
  conversation: { provider: USEJARVIS_PROVIDER_NAME, model: 'uj-chat' },
  high: { provider: USEJARVIS_PROVIDER_NAME, model: 'uj-high' },
  medium: { provider: USEJARVIS_PROVIDER_NAME, model: 'uj-medium' },
  low: { provider: USEJARVIS_PROVIDER_NAME, model: 'uj-low' },
};
const HOSTED_PROVIDERS = { [USEJARVIS_PROVIDER_NAME]: { kind: USEJARVIS_KIND } };

/** Shape B: a conversation tier configured, task work on a small local model. */
const LOCAL_TIERS: TierMap = {
  conversation: { provider: 'ollama', model: 'qwen2.5:3b' },
  high: { provider: 'ollama', model: 'qwen2.5:14b' },
  medium: { provider: 'ollama', model: 'qwen2.5:7b' },
};
const LOCAL_PROVIDERS = { ollama: { kind: 'ollama' } };

const GENERIC = ['read_file', 'write_file', 'list_directory', 'run_command', 'delegate_task', 'manage_agents'];
const SITE = ['site_read_file', 'site_write_file', 'site_list_files', 'site_run_command',
  'site_create_project', 'site_git_commit', 'site_github_push', 'site_delete_file'];

/** The buffer `processTaskCall` really hands the filter on a fresh delegation. */
function taskBuffer(ask: string): LLMMessage[] {
  return [
    { role: 'system', content: 'ROLE PROMPT ... # Available Tools\n- terminal\n- file-ops\n- browser\n' },
    {
      role: 'system',
      content: '[TASK TEMPLATE: GENERAL] Use your tools to accomplish the user\'s intent. '
        + 'If they asked to read a file, use file-ops. If they asked to run a command, run it.',
    },
    { role: 'user', content: ask },
  ];
}

type Shape = 'hosted' | 'local';

function offered(ask: string, scoped: boolean, shape: Shape, tier: 'medium' | 'high' = 'medium') {
  const decision = decideTools({
    all: scoped ? SCOPED : ALL,
    messages: taskBuffer(ask),
    ledger: new ToolExposureLedger(),
    tier,
    tiers: shape === 'hosted' ? HOSTED_TIERS : LOCAL_TIERS,
    providers: (shape === 'hosted' ? HOSTED_PROVIDERS : LOCAL_PROVIDERS) as never,
    policy: ON,
    ...(scoped ? { scope: PROJECT_SITE_CHAT_SCOPE } : {}),
  });
  return {
    names: new Set(decision.tools.map((t) => t.name)),
    engaged: decision.engaged,
    reason: decision.reason,
  };
}

/** Ordinary things a person types into the Sites page composer. */
const SITE_ASKS = [
  'install react-router in the project',
  'add a hero section to the landing page',
  'read src/App.tsx and fix the button colour',
  'change the vite config to use port 4000',
  'run the tests in the project',
  'what files are in the project?',
  'update the Makefile dev target',
  'commit and push the site to github',
  'npm run build the project and show me the errors',
  'add a postinstall script to package.json',
  'make the header sticky',
  'why is the preview blank?',
];

/** Asks with nothing to do with the project, typed into the same composer. */
const UNRELATED_ASKS = [
  'put this in a note',
  'set a goal to ship by friday',
  'draft a reply to that email',
  'remind me to deploy this tomorrow',
];

describe('shape A: a real hosted install', () => {
  test('the relevance filter does not engage at all', () => {
    // The fact the whole ordering of #571 rests on. If this ever starts
    // passing differently, the filter became load-bearing on hosted and the
    // substitution measurements below stop being a footnote.
    for (const tier of ['medium', 'high'] as const) {
      const before = offered('install react-router in the project', false, 'hosted', tier);
      const after = offered('install react-router in the project', true, 'hosted', tier);
      expect(`${tier}:${before.engaged}`).toBe(`${tier}:false`);
      expect(`${tier}:${after.engaged}`).toBe(`${tier}:false`);
      expect(before.reason).toContain('frontier veto');
    }
  });

  test('BEFORE: every generic file and shell tool is offered on every site ask', () => {
    for (const ask of SITE_ASKS) {
      const leaked = GENERIC.filter((n) => offered(ask, false, 'hosted').names.has(n));
      // All six, because nothing is filtered: the model is simply handed the
      // whole registry and the prompt's "do NOT use regular read_file" is the
      // only thing between it and the generic shell.
      expect(`${ask}:${leaked.length}`).toBe(`${ask}:6`);
    }
  });

  test('AFTER: none is, on any ask, site or not', () => {
    for (const ask of [...SITE_ASKS, ...UNRELATED_ASKS]) {
      const leaked = GENERIC.filter((n) => offered(ask, true, 'hosted').names.has(n));
      expect(`${ask}:${leaked.join(',')}`).toBe(`${ask}:`);
    }
  });

  test('AFTER: the whole site surface is offered on every ask, so nothing is starved', () => {
    // The consolation for shape A having no substitution rule: with the filter
    // disengaged the scoped registry is handed over whole, so every site tool
    // is present on every turn regardless of wording.
    for (const ask of [...SITE_ASKS, ...UNRELATED_ASKS]) {
      const names = offered(ask, true, 'hosted').names;
      const missing = SITE.filter((n) => !names.has(n));
      expect(`${ask}:${missing.join(',')}`).toBe(`${ask}:`);
    }
  });

  test('the counts: the registry minus exactly the six withheld', () => {
    const before = offered('install react-router in the project', false, 'hosted').names;
    const after = offered('install react-router in the project', true, 'hosted').names;
    expect(before.size).toBe(ALL.length);
    expect(after.size).toBe(ALL.length - GENERIC.length);
    // And nothing NEW appears: a scope may only narrow.
    expect([...after].filter((n) => !before.has(n))).toEqual([]);
  });

  test('the rest of the assistant is untouched', () => {
    // The scope is not "site tools only". The Sites composer is a general chat
    // box that happens to carry a projectId.
    const names = offered('remind me to deploy this tomorrow', true, 'hosted').names;
    for (const n of ['commitments', 'create_document', 'manage_goals', 'browser_navigate']) {
      expect(`${n}:${names.has(n)}`).toBe(`${n}:true`);
    }
  });
});

describe('shape B: conv tier plus a local task model, where the filter runs', () => {
  test('the filter engages, so the substitution rule is live here', () => {
    expect(offered('install react-router in the project', true, 'local').engaged).toBe(true);
  });

  test('BEFORE: the filter preferred the generic shell over the site one', () => {
    // #570's headline measurement, re-taken through the conv buffer.
    const before = offered('install react-router in the project', false, 'local').names;
    expect(before.has('run_command')).toBe(true);
    expect(before.has('site_run_command')).toBe(false);
  });

  test('AFTER: the substitution is the other way round, and it cannot happen', () => {
    const after = offered('install react-router in the project', true, 'local').names;
    expect(after.has('run_command')).toBe(false);
    expect(after.has('site_run_command')).toBe(true);
  });

  test('no site ask is offered a generic file or shell tool', () => {
    for (const ask of SITE_ASKS) {
      const leaked = GENERIC.filter((n) => offered(ask, true, 'local').names.has(n));
      expect(`${ask}:${leaked.join(',')}`).toBe(`${ask}:`);
    }
  });

  test('every ask can at least see the project', () => {
    for (const ask of [...SITE_ASKS, ...UNRELATED_ASKS]) {
      const names = offered(ask, true, 'local').names;
      const missing = ['site_read_file', 'site_list_files'].filter((n) => !names.has(n));
      expect(`${ask}:${missing.join(',')}`).toBe(`${ask}:`);
    }
  });

  test('an unrelated ask is still not handed the site actors or the loud tools', () => {
    for (const ask of ['put this in a note', 'set a goal to ship by friday', 'draft a reply to that email']) {
      const names = offered(ask, true, 'local').names;
      const loud = ['site_run_command', 'site_delete_file', 'site_github_push',
        'browser_evaluate', 'ui_act', 'get_clipboard', 'desktop_snapshot'].filter((n) => names.has(n));
      expect(`${ask}:${loud.join(',')}`).toBe(`${ask}:`);
    }
  });
});

describe('both shapes see the same thing the classic path sees', () => {
  test('the task tier system messages do not change a single decision', () => {
    // The reason #570's classic numbers transfer: `windowedParts` skips system
    // messages, so the template note ("If they asked to run a command, run
    // it") and the role prompt's tool list cannot pull trigger groups. If this
    // ever fails, every measurement in this file and in tool-scope.test.ts is
    // measuring a different turn than production runs.
    for (const ask of [...SITE_ASKS, ...UNRELATED_ASKS]) {
      const withSystem = offered(ask, true, 'local').names;
      const bare = decideTools({
        all: SCOPED,
        messages: [{ role: 'user', content: ask }],
        ledger: new ToolExposureLedger(),
        tier: 'medium',
        tiers: LOCAL_TIERS,
        providers: LOCAL_PROVIDERS as never,
        policy: ON,
        scope: PROJECT_SITE_CHAT_SCOPE,
      });
      const bareNames = new Set(bare.tools.map((t) => t.name));
      expect(`${ask}:${withSystem.size}`).toBe(`${ask}:${bareNames.size}`);
      expect(`${ask}:${[...withSystem].filter((n) => !bareNames.has(n)).join(',')}`).toBe(`${ask}:`);
    }
  });

  test('withholding survives on both shapes, engaged or not', () => {
    for (const shape of ['hosted', 'local'] as const) {
      for (const ask of [...SITE_ASKS, ...UNRELATED_ASKS]) {
        const leaked = GENERIC.filter((n) => offered(ask, true, shape).names.has(n));
        expect(`${shape}/${ask}:${leaked.join(',')}`).toBe(`${shape}/${ask}:`);
      }
    }
  });

  test('decideTools narrows the list IT was given, not one narrowed for it', () => {
    // The assertion the test above only appears to make. `offered()` passes
    // `all: SCOPED`, already narrowed, so it would pass identically if
    // `decideTools` stopped narrowing altogether -- there would be nothing
    // left to narrow. Production narrows twice on purpose (`decideTurnTools`
    // calls `toolsInScope` on the registry listing, and `decideTools` does it
    // again on the first line so the decision is self-contained), and THIS is
    // the test for the second one: hand it the UNSCOPED registry with a scope
    // and require the withheld six to be gone anyway.
    for (const shape of ['hosted', 'local'] as const) {
      for (const tier of ['medium', 'high'] as const) {
        const decision = decideTools({
          all: ALL,
          messages: taskBuffer('install react-router in the project'),
          ledger: new ToolExposureLedger(),
          tier,
          tiers: shape === 'hosted' ? HOSTED_TIERS : LOCAL_TIERS,
          providers: (shape === 'hosted' ? HOSTED_PROVIDERS : LOCAL_PROVIDERS) as never,
          policy: ON,
          scope: PROJECT_SITE_CHAT_SCOPE,
        });
        const names = new Set(decision.tools.map((t) => t.name));
        expect(`${shape}/${tier}:${GENERIC.filter((n) => names.has(n)).join(',')}`).toBe(`${shape}/${tier}:`);
        // And `exposed` too, which is what the off-list interceptor consults.
        expect(`${shape}/${tier}:${GENERIC.filter((n) => decision.exposed.has(n)).join(',')}`).toBe(`${shape}/${tier}:`);
      }
    }
  });

  test('a warm shared ledger cannot resurrect a withheld tool on either shape', () => {
    // The primary exposure ledger is process-wide and `decideTools` keeps
    // anything in it unconditionally -- but it filters `all`, which is already
    // scope-narrowed, so an entry for a withheld tool is inert. #571 also
    // stops such an entry being written in the first place (noteToolUse and
    // seedFromMessages are scope-gated); this is the second line.
    const warm = new ToolExposureLedger();
    warm.add(...GENERIC);
    for (const shape of ['hosted', 'local'] as const) {
      const decision = decideTools({
        all: SCOPED,
        messages: taskBuffer('install react-router in the project'),
        ledger: warm,
        tier: 'medium',
        tiers: shape === 'hosted' ? HOSTED_TIERS : LOCAL_TIERS,
        providers: (shape === 'hosted' ? HOSTED_PROVIDERS : LOCAL_PROVIDERS) as never,
        policy: ON,
        scope: PROJECT_SITE_CHAT_SCOPE,
      });
      const names = new Set(decision.tools.map((t) => t.name));
      expect(`${shape}:${GENERIC.filter((n) => names.has(n)).join(',')}`).toBe(`${shape}:`);
    }
  });
});
