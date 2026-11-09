import { describe, expect, test } from 'bun:test';
import { TurnTaintCarry, taintCarryKey, MAX_TAINT_CARRY_CHATS, type TurnTaintLink } from './turn-taint-carry.ts';
import { LLMManager } from '../llm/manager.ts';
import { TaskRegistry } from './conv/task-registry.ts';
import { TaskDispatcher, type TaskRunner } from './conv/task-dispatcher.ts';
import type { LLMMessage } from '../llm/provider.ts';

/** One whole turn: open a loop, note `read` into it, close. */
function turn(carry: TurnTaintCarry, key: string, message: string, read: string[] = []): ReadonlySet<string> {
  const link = carry.begin(key, message);
  const loop = link.open();
  const started = new Set(loop);
  for (const mark of read) loop.add(mark);
  link.close();
  return started;
}

describe('TurnTaintCarry', () => {
  const key = taintCarryKey('websocket');

  test('a bare yes starts with the previous turn\'s marks; anything else starts clean', () => {
    const carry = new TurnTaintCarry();
    turn(carry, key, 'read the page', ['browser_snapshot']);
    expect([...turn(carry, key, 'Yes, please!')]).toEqual(['browser_snapshot']);
    // Typed replies with no words of their own carry too.
    for (const reply of ['\u{1f44d}', 'go for it', 'yesss', 'lgtm']) {
      expect([reply, [...turn(carry, key, reply)]]).toEqual([reply, ['browser_snapshot']]);
    }
    expect([...turn(carry, key, 'run the build')]).toEqual([]);
    // That clean turn replaced the record.
    expect([...turn(carry, key, 'yes')]).toEqual([]);
  });

  test('only the turn just before counts', () => {
    const carry = new TurnTaintCarry();
    turn(carry, key, 'read the page', ['browser_snapshot']);
    turn(carry, key, 'what time is it');
    expect([...turn(carry, key, 'ok')]).toEqual([]);
  });

  test('a yes turn that opened no loop still records what it carried', () => {
    const carry = new TurnTaintCarry();
    turn(carry, key, 'read the page', ['browser_snapshot']);
    const idle = carry.begin(key, 'mhm');
    idle.close();
    expect([...carry.last(key)]).toEqual(['browser_snapshot']);
  });

  test('declined intents carry as well (Q-08)', () => {
    const carry = new TurnTaintCarry();
    turn(carry, key, 'send it', ['declined-intent:send_email']);
    expect([...turn(carry, key, 'yes')]).toEqual(['declined-intent:send_email']);
  });

  test('every loop of a turn counts, and loops do not see each other', () => {
    const carry = new TurnTaintCarry();
    const link = carry.begin(key, 'research two things');
    const a = link.open();
    const b = link.open();
    a.add('browser_snapshot');
    expect(b.has('browser_snapshot')).toBe(false);
    b.add('clipboard_read');
    link.close();
    expect([...carry.last(key)].sort()).toEqual(['browser_snapshot', 'clipboard_read']);
  });

  test('close is idempotent and a loop written after close does not count', () => {
    const carry = new TurnTaintCarry();
    const link = carry.begin(key, 'read');
    const loop = link.open();
    link.close();
    loop.add('browser_snapshot');
    link.close();
    expect([...carry.last(key)]).toEqual([]);
  });

  test('a clean turn overlapping a tainted one does not erase it, in either close order', () => {
    for (const cleanClosesFirst of [true, false]) {
      const carry = new TurnTaintCarry();
      const tainted = carry.begin(key, 'read the page');
      const clean = carry.begin(key, 'what time is it');
      tainted.open().add('browser_snapshot');
      clean.open();
      if (cleanClosesFirst) { clean.close(); tainted.close(); } else { tainted.close(); clean.close(); }
      expect([cleanClosesFirst, [...carry.last(key)]]).toEqual([cleanClosesFirst, ['browser_snapshot']]);
    }
  });

  test('a bare yes sent while a tainted turn of its chat still runs takes what it has read so far', () => {
    const carry = new TurnTaintCarry();
    const tainted = carry.begin(key, 'read the page');
    tainted.open().add('browser_snapshot');
    expect([...turn(carry, key, 'yes')]).toEqual(['browser_snapshot']);
    expect([...turn(carry, taintCarryKey('pebble'), 'yes')]).toEqual([]);
    expect([...turn(carry, key, 'run the build')]).toEqual([]);
    tainted.close();
    // Once closed it is no longer running: only the record counts.
    turn(carry, key, 'what time is it');
    expect([...turn(carry, key, 'yes')]).toEqual([]);
  });

  test('a running yes that has not opened a loop yet passes on what it carried', () => {
    const carry = new TurnTaintCarry();
    turn(carry, key, 'read the page', ['browser_snapshot']);
    const pending = carry.begin(key, 'yes');
    turn(carry, key, 'what time is it'); // records clean while the yes still runs
    expect([...turn(carry, key, 'ok')]).toEqual(['browser_snapshot']);
    pending.close();
  });

  test('turns that do not overlap replace the record', () => {
    const carry = new TurnTaintCarry();
    turn(carry, key, 'read the page', ['browser_snapshot']);
    turn(carry, key, 'what time is it');
    expect([...carry.last(key)]).toEqual([]);
  });

  test('chats and channels are kept apart', () => {
    const carry = new TurnTaintCarry();
    turn(carry, taintCarryKey('websocket'), 'read', ['browser_snapshot']);
    expect([...turn(carry, taintCarryKey('pebble'), 'yes')]).toEqual([]);
    expect([...turn(carry, taintCarryKey('websocket', 'site:p1'), 'yes')]).toEqual([]);
    expect([...turn(carry, taintCarryKey('telegram', 'websocket'), 'yes')]).toEqual([]);
    expect([...turn(carry, taintCarryKey('websocket'), 'yes')]).toEqual(['browser_snapshot']);
  });

  test('bounded: the least recently used chat is dropped first', () => {
    const carry = new TurnTaintCarry(3);
    for (const k of ['a', 'b', 'c']) turn(carry, k, 'read', [`read-${k}`]);
    turn(carry, 'a', 'yes'); // a is now the most recent
    turn(carry, 'd', 'read', ['read-d']);
    expect([...carry.last('b')]).toEqual([]);
    expect([...carry.last('a')]).toEqual(['read-a']);
    expect([...carry.last('c')]).toEqual(['read-c']);
    expect([...carry.last('d')]).toEqual(['read-d']);
    expect(MAX_TAINT_CARRY_CHATS).toBe(1000);
  });
});

describe('TaskDispatcher hands the turn\'s carry to the task it runs', () => {
  function setup() {
    const seen: (TurnTaintLink | null | undefined)[] = [];
    const runner: TaskRunner = async (args) => {
      seen.push(args.taintCarry);
      return { kind: 'paused', question: 'Which one?', conversation: [{ role: 'user', content: 'q' } as LLMMessage] };
    };
    const registry = new TaskRegistry();
    return { seen, dispatcher: new TaskDispatcher(new LLMManager(), registry, runner) };
  }

  test('on dispatch and on resume', async () => {
    const { seen, dispatcher } = setup();
    const carry = new TurnTaintCarry();
    const first = carry.begin('k', 'research it');
    const env = await dispatcher.dispatch({ tier: 'medium', template: 'research', intent: 'x' }, { scope: null, taintCarry: first });
    const second = carry.begin('k', 'yes');
    await dispatcher.resume(env.task_id, 'yes', { scope: null, taintCarry: second });
    expect(seen).toEqual([first, second]);
  });
});
