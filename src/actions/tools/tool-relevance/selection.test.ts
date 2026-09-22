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
import type { ToolDefinition } from '../registry.ts';
import type { LLMMessage } from '../../../llm/provider.ts';
import type { TierMap } from '../../../llm/tiers.ts';
import { isFloorEligible, isFramedPerception, isInvariantTrigger, outsideReach } from './authority-classes.ts';
import { decideTools, realtimeToolDecision, resetInvariantViolationCount, invariantViolationCount } from './filter.ts';
import { ToolExposureLedger, admittedNames, DISCOVER_TOOLS } from './ledger.ts';
import { conversationText, selectRelevantNames, triggerTableNames, SELECTION_WINDOW_CHARS } from './selection.ts';
import type { ToolFilterPolicy } from './policy.ts';

const A = BUILTIN_TOOLS;
const ON: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: [] };
const TIERS: TierMap = { medium: { provider: 'ollama', model: 'qwen2.5:7b' } };
const PROVIDERS = { ollama: { kind: 'ollama' as const } };

const user = (text: string): LLMMessage => ({ role: 'user', content: text });

function decide(messages: LLMMessage[], ledger = new ToolExposureLedger(), all: readonly ToolDefinition[] = A) {
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

  test('the table names no tool that is not registered somewhere', () => {
    // The table also covers daemon-registered tools, so only flag names that
    // match nothing at all.
    const known = new Set([...A.map((t) => t.name),
      'manage_workflow', 'manage_goals', 'commitments', 'create_document',
      'content_pipeline', 'research_queue', 'delegate_task', 'manage_agents']);
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
      'set a goal to ship the release this week',
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
        expect(`${msg} => ${p}`).toBe(`${msg} => ${p}`);
        expect(`${msg}|${p}:${got.has(p)}`).toBe(`${msg}|${p}:true`);
      }
    }
  });

  test('every single-word message that retains a trigger also retains perception', () => {
    // Exhaustive over the trigger vocabulary rather than a curated list.
    const perception = A.filter(isFramedPerception).map((t) => t.name);
    for (const word of [...triggerTableNames(), 'research', 'note', 'draft', 'remember',
      'run', 'check', 'screen', 'file', 'agent', 'workflow', 'goal']) {
      const got = nameSet(decide([user(`please ${word} it`)]));
      const keepsTrigger = A.some((t) => isInvariantTrigger(t) && got.has(t.name));
      if (!keepsTrigger) continue;
      for (const p of perception) {
        expect(`${word}|${p}:${got.has(p)}`).toBe(`${word}|${p}:true`);
      }
    }
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
    ledger.add(...A.map((t) => t.name));
    const d = decide([user('hello')], ledger);
    expect(d.filtered).toBe(false);
    expect(d.tools).toEqual([...A]);
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
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: '2', name: DISCOVER_TOOLS, arguments: { names: ['browser_navigate', 'run_command'] } }],
      },
    ]);
    expect(l.has('ui_act')).toBe(true);
    expect(l.has('browser_navigate')).toBe(true);
    expect(l.has('run_command')).toBe(true);
  });

  test('admitted names tolerate whatever the model sends', () => {
    expect(admittedNames({ names: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(admittedNames({ names: 'a' })).toEqual(['a']);
    expect(admittedNames({ names: [1, null, 'a', ''] })).toEqual(['a']);
    expect(admittedNames({})).toEqual([]);
    expect(admittedNames(null)).toEqual([]);
    expect(admittedNames('nonsense')).toEqual([]);
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
