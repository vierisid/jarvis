/**
 * Selection, the ledger, and the end-to-end filter decision.
 *
 * #483 requirement 5 asks for coverage of the filter excluding something
 * WRONGLY, not only of it including correctly. Most of this file is
 * therefore negative: the cases #483 measured as capability loss, asserted
 * to keep the tools they need.
 */
import { describe, expect, test } from 'bun:test';
import { BUILTIN_TOOLS } from '../builtin.ts';
import { buildProductionRegistry } from '../production-registry.ts';
import type { ToolDefinition } from '../registry.ts';
import type { LLMMessage } from '../../../llm/provider.ts';
import type { TierMap } from '../../../llm/tiers.ts';
import { isFloorEligible, isFramedPerception, isInvariantTrigger, outsideReach } from './authority-classes.ts';
import { decideTools, realtimeToolDecision, resetInvariantViolationCount, invariantViolationCount } from './filter.ts';
import { ToolExposureLedger, admittedNames, DISCOVER_TOOLS } from './ledger.ts';
import { interceptOffList, type DiscoveryContext } from './discover.ts';
import {
  conversationText, selectForConversation, selectRelevantNames, triggerTableNames, SELECTION_WINDOW_CHARS, TRIGGER_GROUPS,
} from './selection.ts';
import type { ToolFilterPolicy } from './policy.ts';

const A = BUILTIN_TOOLS;
/**
 * Every tool a running daemon registers, from the real factories -- the 33
 * builtins plus the nine daemon tools and the eight site-builder tools. The
 * BUILTIN_TOOLS-only fixture above is why the site-builder tools shipped
 * with no trigger at all: nothing here ever saw them.
 */
const PROD = await buildProductionRegistry();
const P = PROD.tools;
/** Every word of every trigger group: the vocabulary an attacker can stuff. */
const TRIGGER_WORDS = [...new Set(TRIGGER_GROUPS.flatMap((g) => g.words ?? []))];
const ON: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: [] };
const TIERS: TierMap = { medium: { provider: 'ollama', model: 'qwen2.5:7b' } };
const PROVIDERS = { ollama: { kind: 'ollama' as const } };

const user = (text: string): LLMMessage => ({ role: 'user', content: text });

function decide(messages: LLMMessage[], ledger = new ToolExposureLedger(), all: readonly ToolDefinition[] = P) {
  return decideTools({ all, messages, ledger, tier: 'medium', tiers: TIERS, providers: PROVIDERS, policy: ON });
}
const nameSet = (d: { tools: ToolDefinition[] }) => new Set(d.tools.map((t) => t.name));

describe('trigger table coverage', () => {
  test('every droppable builtin tool has at least one trigger', () => {
    // Without this, a tool nobody wrote a trigger for is dropped on every
    // single turn and nothing fails.
    const table = triggerTableNames();
    const missing = A.filter((t) => !isFloorEligible(t) && !table.has(t.name)).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  test('the production registry built completely', () => {
    // Every claim below is quantified over P. A factory that stopped
    // building would shrink it silently.
    expect(PROD.skipped).toEqual([]);
  });

  test('every droppable PRODUCTION tool has at least one trigger', () => {
    // The builtin-only version of this test passed while all eight
    // site-builder tools had no trigger and were dropped on every turn.
    const table = triggerTableNames();
    const missing = P.filter((t) => !isFloorEligible(t) && !table.has(t.name)).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  test('the table names no tool that is not registered', () => {
    const known = new Set(P.map((t) => t.name));
    expect([...triggerTableNames()].filter((n) => !known.has(n))).toEqual([]);
  });
});

describe('wrong exclusion - the cases #483 measured as capability loss', () => {
  test('a research ask KEEPS the browser tools', () => {
    // #475 dropped all 10 browser_*, all 9 desktop_*, ui_snapshot, ui_act and
    // capture_screen here, leaving curl as the only way to fetch a page.
    const got = nameSet(decide([user('research the competitor landscape and write it up')]));
    for (const t of A.filter((x) => x.category === 'browser')) {
      expect(`${t.name}:${got.has(t.name)}`).toBe(`${t.name}:true`);
    }
  });

  test('a pasted URL keeps the browser tools even with no keyword', () => {
    // #475 matched `\burl\b` as a literal word, so a real URL matched nothing.
    const got = nameSet(decide([user('what does https://example.com/post/1 say?')]));
    expect(got.has('browser_navigate')).toBe(true);
    expect(got.has('browser_snapshot')).toBe(true);
  });

  test('summarising an article keeps the browser tools', () => {
    const got = nameSet(decide([user('summarise this article https://example.com/post/1')]));
    expect(got.has('browser_navigate')).toBe(true);
  });

  test('a scheduled-check ask keeps the browser tools the check would need', () => {
    const got = nameSet(decide([user('schedule a daily check of the dashboard')]));
    expect(got.has('browser_navigate')).toBe(true);
  });

  test('a desktop ask keeps the desktop control tools', () => {
    const got = nameSet(decide([user('open notepad and type hello')]));
    for (const n of ['desktop_launch_app', 'desktop_type', 'ui_act']) {
      expect(`${n}:${got.has(n)}`).toBe(`${n}:true`);
    }
  });

  test('realistic browse asks keep the browser tools', () => {
    // None of these says "web", "browser" or pastes a scheme. Before the
    // vocabulary and the unmatched default, all but three of them came back
    // with the floor and the hatch and nothing else.
    for (const ask of [
      'find the cheapest flight to Tokyo',
      "what's the price of bitcoin right now",
      'visit example.org and tell me what it says',
      'go to github.com and check my notifications',
      'fill in the signup form on their homepage',
      'what are people saying on reddit about the new iphone',
      'compare prices for a standing desk',
      'find me a recipe for lasagna',
      'who won the match last night',
      'hover over the menu and tell me the options',
      'look up the weather in Rome',
    ]) {
      const got = nameSet(decide([user(ask)], new ToolExposureLedger(), P));
      expect(`${ask}: ${got.has('browser_navigate')}`).toBe(`${ask}: true`);
      expect(`${ask}: ${got.has('browser_snapshot')}`).toBe(`${ask}: true`);
    }
  });

  test('an ask that matches no group gets the framed readers, never the shell', () => {
    // The unmatched default leans framed: when the filter does not know
    // what a turn needs, the outside-reaching tools it offers are the ones
    // that wrap what they bring back.
    expect(selectRelevantNames('who won the match last night').size).toBe(0);
    const names = selectForConversation([user('who won the match last night')]);
    expect(names.has('browser_navigate')).toBe(true);
    expect(names.has('run_command')).toBe(false);
    const d = decide([user('who won the match last night')], new ToolExposureLedger(), P);
    const got = nameSet(d);
    // The browse readers, and nothing that is itself a trigger: no shell,
    // no browser_evaluate (rank 506, which would drag every desktop reader
    // in by the union), no browser_upload_file (an exfiltration actor).
    for (const n of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_scroll']) {
      expect(`${n}:${got.has(n)}`).toBe(`${n}:true`);
    }
    expect(d.tools.filter(isInvariantTrigger).map((t) => t.name)).toEqual([]);
    expect(got.has('browser_upload_file')).toBe(false);
    expect(got.has('ui_snapshot')).toBe(false);
  });

  test('a browse word does not offer the site-builder shell', () => {
    // "website" is a browse, not a build: it must not bring site_run_command,
    // site_delete_file and site_github_push.
    const got = nameSet(decide([user('go to their website and read the pricing')]));
    expect(got.has('browser_navigate')).toBe(true);
    expect(got.has('site_run_command')).toBe(false);
  });

  test('site-builder tools follow build intent, not dev words', () => {
    for (const ask of ['build me a landing page for my bakery', 'create a website for my bakery',
      'make a portfolio site', 'create an HTML page for my resume', 'code a website for me',
      'generate a static site with three pages', 'scaffold a new site', 'put together a small site for the club',
      'whip up a website for the event', 'spin up a site for the launch',
      // An excluded word AFTER the noun does not count against it.
      'create a website with a login page', 'build a site where members can sign in']) {
      expect(`${ask}: ${nameSet(decide([user(ask)])).has('site_write_file')}`).toBe(`${ask}: true`);
    }
    // Browses and dev chat: must not be offered the site shell.
    for (const ask of ['fix the css in my react app', 'use the email template for the reply', 'render this html to text',
      'go to my website and read the about page', 'check what my site says about pricing',
      'make sure the website loads before you read the pricing', 'create an account on the site',
      'set up my account on their website', 'start by reading their homepage', 'what is the design of their homepage',
      'make a summary of this site', 'generate a report on their website traffic', 'create a bookmark for this site']) {
      expect(`${ask}: ${nameSet(decide([user(ask)])).has('site_run_command')}`).toBe(`${ask}: false`);
    }
  });

  test('the window is exactly SELECTION_WINDOW_CHARS of the joined text (ASCII)', () => {
    const a = 'a'.repeat(5000);
    const b = 'b'.repeat(2999);
    const c = 'c'.repeat(3000);
    // Newest last. The window takes c, a newline, b, a newline -- 7,001 --
    // and the last 999 characters of a.
    const text = conversationText([user(a), user(b), user(c)]);
    expect(text.length).toBe(SELECTION_WINDOW_CHARS);
    expect(text).toBe([a, b, c].join('\n').slice(-SELECTION_WINDOW_CHARS));
    // Ending exactly on a boundary takes no sliver of the older message.
    const exact = conversationText([user('zzz'), user('y'.repeat(SELECTION_WINDOW_CHARS))]);
    expect(exact).toBe('y'.repeat(SELECTION_WINDOW_CHARS));
    // Lowercased, and only after windowing.
    expect(conversationText([user('HELLO')])).toBe('hello');
  });

  test('the site-build pattern stays linear on hostile input', () => {
    for (const hostile of ['build '.repeat(1400), 'create a '.repeat(900) + 'site', 'make ' + 'x '.repeat(4000)]) {
      const t0 = performance.now();
      decide([user(hostile)]);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });

  test('the bare-domain pattern stays linear on hostile input', () => {
    // The selection reads assistant text, which can echo an injected page.
    const hostile = 'a.'.repeat(4000);
    const t0 = performance.now();
    decide([user(hostile)]);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test('an unmatched ask later in the conversation still gets the browser tools', () => {
    // A whole-window rule would never fire here: the first message matches
    // the goals group.
    const got = nameSet(decide([user('set a goal to ship the release'), user('who won the match last night')]));
    expect(got.has('browser_navigate')).toBe(true);
  });

  test('a scoped registry whose matched group it cannot offer still gets its browser tools', () => {
    // research-analyst's shape: browser + shell. "set a goal" matches the
    // goals group, whose tool this registry does not have.
    const scoped = P.filter((t) => t.category === 'browser' || t.name === 'run_command');
    const got = nameSet(decide([user('set a goal to ship the release')], new ToolExposureLedger(), scoped));
    expect(got.has('browser_navigate')).toBe(true);
    expect(got.has('run_command')).toBe(false);
  });

  test("every production tool's own description keeps that tool", () => {
    // Generated from the registry, so a tool added tomorrow is covered
    // without anyone writing a case. The prompt is the first sentence of the
    // tool's own description -- the text the model is choosing by -- and the
    // filter must not hide the tool it describes. This is the offline half
    // of the benchmark's `wanted tool dropped` line, as a test.
    const dropped: string[] = [];
    for (const t of P.filter((x) => !isFloorEligible(x))) {
      const first = t.description.split(/\.\s/)[0]!;
      const got = nameSet(decide([user(first)], new ToolExposureLedger(), P));
      if (!got.has(t.name)) dropped.push(`${t.name} <- "${first}"`);
    }
    expect(dropped).toEqual([]);
  });

  test('a site-builder ask keeps the site-builder tools, and the framed readers with its shell', () => {
    const got = nameSet(decide([user('build me a landing page for my bakery')], new ToolExposureLedger(), P));
    for (const n of ['site_create_project', 'site_write_file', 'site_run_command']) {
      expect(`${n}:${got.has(n)}`).toBe(`${n}:true`);
    }
    // site_run_command is a real `sh -c` shell: it must bring I1 with it.
    for (const t of P.filter(isFramedPerception)) expect(`${t.name}:${got.has(t.name)}`).toBe(`${t.name}:true`);
  });
});

describe('I2 - a follow-up turn cannot strip an in-flight task', () => {
  test('"now remember that I did that" does not remove ui_act or browser_navigate', () => {
    // #483's exact repro. Turn 1 uses the control tools; turn 2 mentions only
    // the knowledge group. Under #475 this removed ui_act and
    // browser_navigate while retaining run_command.
    const ledger = new ToolExposureLedger();
    const turn1: LLMMessage[] = [user('open notepad and type hello')];
    const d1 = decide(turn1, ledger);
    expect(nameSet(d1).has('ui_act')).toBe(true);

    // The model actually called them, so the loop notes them.
    ledger.add('ui_act', 'browser_navigate');

    const turn2 = [...turn1, user('now remember that I did that')];
    const got = nameSet(decide(turn2, ledger));
    expect(got.has('ui_act')).toBe(true);
    expect(got.has('browser_navigate')).toBe(true);
  });

  test('the exposed set is non-decreasing across a growing conversation', () => {
    const ledger = new ToolExposureLedger();
    const convo: LLMMessage[] = [];
    let previous = new Set<string>();
    for (const msg of [
      'hi there',
      'set a goal to ship the release this week',
      'find the cheapest flight to Tokyo',
      'also remind me about it on friday',
      'what is on my screen right now?',
      'ok now check whether the build passed',
      'thanks, that is all',
    ]) {
      convo.push(user(msg));
      const got = nameSet(decide(convo, ledger));
      for (const n of previous) expect(`${msg}:${n}:${got.has(n)}`).toBe(`${msg}:${n}:true`);
      previous = got;
    }
  });

  test('monotonicity survives history compaction', () => {
    // The ledger exists precisely because the conversation is NOT
    // append-only: compactHistory drops the oldest chunks, and the chat
    // loops never persist tool calls at all.
    const ledger = new ToolExposureLedger();
    const before = nameSet(decide([user('open notepad and click the save button')], ledger));
    expect(before.has('ui_act')).toBe(true);
    ledger.add('ui_act');

    // The whole earlier conversation is gone; only a fresh message remains.
    const after = nameSet(decide([user('thanks')], ledger));
    expect(after.has('ui_act')).toBe(true);
  });

  test('the selection window is bounded but the ledger covers what scrolls out', () => {
    const filler = user('x'.repeat(SELECTION_WINDOW_CHARS + 500));
    const text = conversationText([user('open notepad'), filler]);
    expect(text.length).toBeLessThanOrEqual(SELECTION_WINDOW_CHARS);
    expect(text).not.toContain('notepad');

    const ledger = new ToolExposureLedger();
    ledger.add('desktop_launch_app');
    expect(nameSet(decide([user('open notepad'), filler], ledger)).has('desktop_launch_app')).toBe(true);
  });
});

describe('keyword stuffing cannot launder authority', () => {
  test('no message can produce run_command without the framed perception tools', () => {
    // The attack from #483: the filter's input is the incoming message, so
    // anyone who can drive a channel turn picks the subset. The ceiling is
    // the full set, so this cannot GAIN a tool -- what it must not do is
    // strip the framing off outside content.
    const stuffing = [
      'research the competitor landscape and write it up',
      'summarise this document and draft a note',
      'remember to research and draft a memo about the article',
      'take a note, remember this, draft a report, research the topic',
      'run the build and write up the results',
      'check the logs then draft a summary note',
      'install the package, note the output, remember the version',
      'delegate research to an agent and summarise the report',
      'open the app, screenshot it, and write a note about it',
      'automate a daily research digest and email me a draft',
    ];
    const perception = A.filter(isFramedPerception).map((t) => t.name);
    for (const msg of stuffing) {
      const got = nameSet(decide([user(msg)]));
      if (!got.has('run_command')) continue;
      for (const p of perception) {
        expect(`${msg}|${p}:${got.has(p)}`).toBe(`${msg}|${p}:true`);
      }
    }
  });

  test('every trigger word, alone, that retains a trigger also retains perception', () => {
    // Exhaustive over the real trigger VOCABULARY, over the production
    // registry. An earlier version iterated tool names ("please
    // browser_navigate it"), which match no \bword\b at all, so most of
    // its iterations tested the empty selection.
    expect(TRIGGER_WORDS.length).toBeGreaterThan(100);
    const perception = P.filter(isFramedPerception).map((t) => t.name);
    let checked = 0;
    for (const word of TRIGGER_WORDS) {
      const got = nameSet(decide([user(`please ${word} it`)], new ToolExposureLedger(), P));
      if (!P.some((t) => isInvariantTrigger(t) && got.has(t.name))) continue;
      checked += 1;
      for (const p of perception) {
        expect(`${word}|${p}:${got.has(p)}`).toBe(`${word}|${p}:true`);
      }
    }
    // Guard against the loop above silently checking nothing again.
    expect(checked).toBeGreaterThan(50);
  });

  test('every PAIR of groups, stuffed together, keeps perception whenever it keeps a trigger', () => {
    // One word per group, every pair: 17 x 17 selections over the full
    // production registry, shell and site-builder shell included.
    resetInvariantViolationCount();
    const firsts = TRIGGER_GROUPS.map((g) => g.words?.[0]).filter((w): w is string => !!w);
    const perception = P.filter(isFramedPerception).map((t) => t.name);
    for (const a of firsts) {
      for (const b of firsts) {
        const got = nameSet(decide([user(`${a} and ${b}`)], new ToolExposureLedger(), P));
        if (!P.some((t) => isInvariantTrigger(t) && got.has(t.name))) continue;
        for (const p of perception) expect(`${a}+${b}|${p}:${got.has(p)}`).toBe(`${a}+${b}|${p}:true`);
      }
    }
    expect(invariantViolationCount()).toBe(0);
  });
});

describe('the filter decision', () => {
  test('a quiet turn drops most of the set and keeps the floor', () => {
    const d = decide([user('set a goal to ship the release this week')]);
    expect(d.filtered).toBe(true);
    const got = nameSet(d);
    for (const t of A.filter(isFloorEligible)) expect(got.has(t.name)).toBe(true);
    expect(d.tools.length).toBeLessThan(A.length);
    // Nothing that can fetch outside content unframed survived, so there is
    // nothing to launder and the framed set is legitimately absent.
    expect(d.tools.some(isInvariantTrigger)).toBe(false);
  });

  test('a disabled policy returns the input untouched', () => {
    const d = decideTools({
      all: A, messages: [user('set a goal')], ledger: new ToolExposureLedger(),
      tier: 'medium', tiers: TIERS, providers: PROVIDERS,
      policy: { enabled: false, maxParamsB: 20, models: [] },
    });
    expect(d.filtered).toBe(false);
    expect(d.tools).toEqual([...A]);
  });

  test('an ineligible model returns the input untouched', () => {
    const d = decideTools({
      all: A, messages: [user('set a goal')], ledger: new ToolExposureLedger(),
      tier: 'medium', tiers: { medium: { provider: 'openai', model: 'gpt-5.4' } },
      providers: { openai: { kind: 'openai' } }, policy: ON,
    });
    expect(d.filtered).toBe(false);
    expect(d.tools).toEqual([...A]);
    expect(d.reason).toContain('veto');
  });

  test('an empty tool list is returned untouched', () => {
    expect(decide([user('hi')], new ToolExposureLedger(), []).tools).toEqual([]);
  });

  test('realtime is never filtered, and says why', () => {
    const d = realtimeToolDecision(A);
    expect(d.filtered).toBe(false);
    expect(d.tools).toEqual([...A]);
    expect(d.reason).toContain('fixed tool list');
  });

  test('a turn that keeps everything reports unfiltered, so the request stays byte-identical', () => {
    const ledger = new ToolExposureLedger();
    ledger.add(...P.map((t) => t.name));
    const d = decide([user('hello')], ledger);
    expect(d.filtered).toBe(false);
    expect(d.tools).toEqual([...P]);
  });

  test('the violation counter counts, and starts at zero', () => {
    resetInvariantViolationCount();
    expect(invariantViolationCount()).toBe(0);
    decide([user('set a goal')]);
    expect(invariantViolationCount()).toBe(0);
  });
});

describe('the ledger', () => {
  test('it only grows', () => {
    const l = new ToolExposureLedger();
    l.add('a', 'b');
    l.add('a');
    expect(l.size).toBe(2);
    expect(l.has('a')).toBe(true);
    // There is deliberately no remove.
    expect((l as unknown as Record<string, unknown>).remove).toBeUndefined();
    expect((l as unknown as Record<string, unknown>).clear).toBeUndefined();
  });

  test('seeding reads tool calls and discover_tools admissions out of a buffer', () => {
    const l = new ToolExposureLedger();
    l.seedFromMessages([
      user('hi'),
      { role: 'assistant', content: '', tool_calls: [{ id: '1', name: 'ui_act', arguments: {} }] },
      { role: 'tool', content: 'ok', tool_call_id: '1' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: '2', name: DISCOVER_TOOLS, arguments: { names: ['browser_navigate', 'run_command'] } }],
      },
      { role: 'tool', content: 'Now available', tool_call_id: '2' },
    ]);
    expect(l.has('ui_act')).toBe(true);
    expect(l.has('browser_navigate')).toBe(true);
    expect(l.has('run_command')).toBe(true);
  });

  test("seeding skips the clarification branch's placeholders, and keeps refusals as the admissions they were", () => {
    // The clarification placeholder answers an id for a call that neither
    // ran nor was admitted. An off-list refusal WAS admitted (and audited)
    // live, and the model was told it may call again: a resume must agree.
    const l = new ToolExposureLedger();
    l.seedFromMessages([
      user('hi'),
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'a', name: 'run_command', arguments: {} },
          { id: 'b', name: 'list_directory', arguments: {} },
          { id: 'c', name: 'read_file', arguments: {} },
        ],
      },
      { role: 'tool', content: '[Not run: the task paused to ask the user a question first.]', tool_call_id: 'a' },
      { role: 'tool', content: '[NOT RUN] list_directory was not in your tool list', tool_call_id: 'b' },
      { role: 'tool', content: 'file contents', tool_call_id: 'c' },
    ]);
    expect([...l.snapshot()].sort()).toEqual(['list_directory', 'read_file']);
  });

  test('seeding skips calls that were never answered', () => {
    // A paused sub-agent's buffer ends on an assistant turn whose later calls
    // were not reached. A shell chosen there, while it was hidden, must go
    // back through the off-list check on resume, not arrive pre-exposed.
    const l = new ToolExposureLedger();
    l.seedFromMessages([
      user('hi'),
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'a', name: 'write_file', arguments: {} },
          { id: 'b', name: 'run_command', arguments: {} },
          { id: 'c', name: DISCOVER_TOOLS, arguments: { names: ['list_directory'] } },
        ],
      },
    ]);
    expect(l.size).toBe(0);
  });

  test('admitted names tolerate whatever the model sends', () => {
    expect(admittedNames({ names: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(admittedNames({ names: 'a' })).toEqual(['a']);
    expect(admittedNames({ names: [1, null, 'a', ''] })).toEqual(['a']);
    expect(admittedNames({})).toEqual([]);
    expect(admittedNames(null)).toEqual([]);
    expect(admittedNames('nonsense')).toEqual([]);
    // Small models stringify the array, or send a list in one string. The
    // hatch must not answer "No such tool" to a formatting slip.
    expect(admittedNames({ names: '["browser_navigate", "browser_click"]' })).toEqual(['browser_navigate', 'browser_click']);
    expect(admittedNames({ names: 'browser_navigate, browser_click' })).toEqual(['browser_navigate', 'browser_click']);
    expect(admittedNames({ names: "['browser_navigate']" })).toEqual(['browser_navigate']);
    expect(admittedNames({ names: ' ' })).toEqual([]);
  });

  test('admitting the shell re-admits the framed readers with it', () => {
    // The escape hatch is not exempt from the invariant.
    const ledger = new ToolExposureLedger();
    ledger.add('run_command');
    const got = nameSet(decide([user('hello')], ledger));
    expect(got.has('run_command')).toBe(true);
    for (const t of A.filter(isFramedPerception)) {
      expect(`${t.name}:${got.has(t.name)}`).toBe(`${t.name}:true`);
    }
  });

  test('admitting an unregistered name conjures nothing', () => {
    const ledger = new ToolExposureLedger();
    ledger.add('totally_made_up_tool');
    const d = decide([user('hello')], ledger);
    expect(d.tools.some((t) => t.name === 'totally_made_up_tool')).toBe(false);
    expect(d.failures).toEqual([]);
  });
});

describe('off-list calls (dispatch-time I1)', () => {
  const ctx = (exposed: string[], over: Partial<DiscoveryContext> = {}): DiscoveryContext => ({
    all: P, ledger: new ToolExposureLedger(), exposed: new Set(exposed), filterEnabled: true, ...over,
  });
  const floorOnly = P.filter(isFloorEligible).map((t) => t.name);

  test('an unframed fetch is refused while a framed reader is hidden, and admitted', () => {
    const admitted: Array<[string[], string]> = [];
    const c = ctx(floorOnly, { onAdmitted: (a, via) => admitted.push([a, via]) });
    const r = interceptOffList('run_command', c);
    expect(r?.refusal).toContain('[NOT RUN] run_command');
    expect(r?.grew).toBe(true);
    expect(c.ledger.has('run_command')).toBe(true);
    expect(admitted).toEqual([[['run_command'], 'off-list call']]);
    // ...and the next decision offers it with every framed reader.
    const got = nameSet(decide([user('set a goal')], c.ledger));
    expect(got.has('run_command')).toBe(true);
    for (const t of P.filter(isFramedPerception)) expect(`${t.name}:${got.has(t.name)}`).toBe(`${t.name}:true`);
  });

  test('every invariant trigger is refused the same way, not only the shell', () => {
    for (const t of P.filter(isInvariantTrigger)) {
      expect(`${t.name}:${interceptOffList(t.name, ctx(floorOnly))?.refusal != null}`).toBe(`${t.name}:true`);
    }
  });

  test('a framed reader is dispatched, and still widens the set', () => {
    expect(interceptOffList('browser_snapshot', ctx(floorOnly))).toEqual({ refusal: null, grew: true });
  });

  test('a trigger is dispatched when no framed reader was hidden', () => {
    const exposed = [...floorOnly, ...P.filter(isFramedPerception).map((t) => t.name)];
    expect(interceptOffList('run_command', ctx(exposed))).toEqual({ refusal: null, grew: true });
  });

  test('a throw inside the check fails CLOSED: the call is refused, not dispatched', () => {
    const refused: string[] = [];
    const c = ctx(floorOnly, { haltedState: () => { throw new Error('boom'); }, onRefused: (t) => refused.push(t.name) });
    const r = interceptOffList('run_command', c);
    expect(r?.refusal).toStartWith('[NOT RUN] run_command');
    expect(r?.grew).toBe(true);
    expect(refused).toEqual(['run_command']);
    // Still nothing when the filter is off or the tool was offered.
    expect(interceptOffList('run_command', ctx(floorOnly, { filterEnabled: false, haltedState: () => { throw new Error('x'); } }))).toBeNull();
    expect(interceptOffList('run_command', ctx([...floorOnly, 'run_command'], { haltedState: () => { throw new Error('x'); } }))).toBeNull();
  });

  test('not applicable: filter off, offered, unregistered, or halted', () => {
    expect(interceptOffList('run_command', ctx(floorOnly, { filterEnabled: false }))).toBeNull();
    expect(interceptOffList('run_command', ctx([...floorOnly, 'run_command']))).toBeNull();
    expect(interceptOffList('made_up_tool', ctx(floorOnly))).toBeNull();
    const halted = ctx(floorOnly, { haltedState: () => 'paused' });
    expect(interceptOffList('run_command', halted)).toBeNull();
    expect(halted.ledger.has('run_command')).toBe(false);
  });
});

describe('selection internals', () => {
  test('conversationText ignores system and tool messages', () => {
    const text = conversationText([
      { role: 'system', content: 'SYSTEMWORD' },
      user('userword'),
      { role: 'tool', content: 'TOOLWORD', tool_call_id: '1' },
      { role: 'assistant', content: 'assistantword' },
    ]);
    expect(text).toContain('userword');
    expect(text).toContain('assistantword');
    expect(text).not.toContain('systemword');
    expect(text).not.toContain('toolword');
  });

  test('a word trigger matches on a word boundary, not a substring', () => {
    // "run" must not fire on "grundy".
    expect(selectRelevantNames('grundy portmanteau').has('run_command')).toBe(false);
    expect(selectRelevantNames('please run it').has('run_command')).toBe(true);
  });

  test('replay tools are selectable but never forced in', () => {
    const replay = A.filter((t) => outsideReach(t) === 'replay');
    for (const t of replay) expect(isFloorEligible(t)).toBe(false);
    const got = nameSet(decide([user('what skills do you have?')]));
    expect(got.has('manage_skills')).toBe(true);
  });
});
