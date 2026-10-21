/**
 * #1008: a held voice room action is settled before the person is asked:
 * its handler's defaults filled in and the item it acts on pinned by id.
 */

import { describe, expect, test } from 'bun:test';
import {
  describeSettledTime, unrecognisedTimeZone, realtimeRoomActionDecision, resolveHeldRoomAction as resolveHeld, roomActionAuditRow, settleRoomActionTime, voiceTimeZone,
  type RoomActionTargetLists, type VoiceClock,
} from './voice-room-action-gate.ts';

/** resolveHeldRoomAction at a fixed clock, unless a test gives its own. */
const resolveHeldRoomAction = (ra: Parameters<typeof resolveHeld>[0], lists: RoomActionTargetLists, what: string, clock: VoiceClock | null = { now: Date.parse('2026-10-20T15:00:00Z'), timeZone: 'UTC' }) =>
  resolveHeld(ra, lists, what, clock);
import { buildTaintGating } from '../authority/taint-gating.ts';

describe('roomActionAuditRow (#1009)', () => {
  const who = { agentId: 'a1', agentName: 'Jarvis' };
  test('a side-effecting action gets a row with every category, the origin, the reason and whether it ran', () => {
    expect(roomActionAuditRow({ room: 'workspaces', action: 'create_project' }, 'confirm', 'allowed', true, who, { approvalId: 'h1', channel: 'click', reason: 'accepted' }))
      .toEqual({
        agent_id: 'a1', agent_name: 'Jarvis',
        tool_name: 'room_action(workspaces/create_project; via confirm; install_software, execute_command; accepted)',
        action_category: 'install_software', authority_decision: 'allowed', approval_id: 'h1', executed: true, channel: 'click',
      });
    expect(roomActionAuditRow({ room: 'tasks', action: 'create_task' }, 'realtime', 'denied', false, who, { reason: 'tainted' }))
      .toMatchObject({ approval_id: null, channel: 'voice', executed: false });
  });

  test('a voice request for an authority grant or revoke is recorded; a view action, or anything else no room runs, is not', () => {
    for (const action of ['grant_access', 'revoke_access']) {
      expect(roomActionAuditRow({ room: 'authority', action }, 'realtime', 'denied', false, who, { reason: 'not_a_room_action' }))
        .toMatchObject({ action_category: 'modify_settings', tool_name: `room_action(authority/${action}; via realtime; modify_settings; not_a_room_action)` });
    }
    expect(roomActionAuditRow({ room: 'tasks', action: 'set_filter' }, 'realtime', 'allowed', true, who, { reason: 'accepted' })).toBeNull();
    expect(roomActionAuditRow({ room: 'authority', action: 'delete_everything' }, 'realtime', 'denied', false, who, { reason: 'not_a_room_action' })).toBeNull();
    expect(roomActionAuditRow({ room: '__proto__', action: 'toString' }, 'realtime', 'denied', false, who, { reason: 'not_a_room_action' })).toBeNull();
  });

  test('a realtime refusal says why', () => {
    const ctx = { halted: null, blockedCategories: [] as string[], taintGating: buildTaintGating(undefined), taint: new Set<string>() };
    const ra = { room: 'tasks', action: 'create_task' };
    expect(realtimeRoomActionDecision(ra, { ...ctx, halted: 'killed' })?.reason).toBe('killed');
    expect(realtimeRoomActionDecision(ra, { ...ctx, halted: 'paused' })?.reason).toBe('paused');
    expect(realtimeRoomActionDecision(ra, { ...ctx, blockedCategories: ['write_data'] })?.reason).toBe('blocked');
    expect(realtimeRoomActionDecision(ra, { ...ctx, taint: new Set(['browser_navigate']) })?.reason).toBe('tainted');
    expect(realtimeRoomActionDecision(ra, ctx)).toBeNull();
  });
});

const lists = (over: Partial<RoomActionTargetLists> = {}): RoomActionTargetLists => ({
  project: async () => [{ id: 'p1', name: 'jarvis-landing' }, { id: 'p2', name: 'demo-app' }],
  content: async () => [{ id: 'c1', title: 'Launch post draft' }, { id: 'c2', title: 'Launch' }],
  task: async () => [{ id: 't1', what: 'Pay rent to landlord' }, { id: 't2', what: 'Call mum' }],
  entity: async () => [{ id: 'e1', name: 'James' }, { id: 'e2', name: 'Alice Smith' }, { id: 'e3', name: 'Bob' }, { id: 'e4', name: 'bob' }],
  ...over,
});

describe('resolveHeldRoomAction (#1008)', () => {
  test('a remembered fact is pinned to the entity its subject names, before the card (#1023)', async () => {
    const held = (args: Record<string, unknown>, over: Partial<RoomActionTargetLists> = {}) =>
      resolveHeldRoomAction({ room: 'memory', action: 'remember_that', args: { predicate: ' Birthday ', object: ' march 15 ', ...args } }, lists(over), 'Memory: remember that');
    const fact = { predicate: 'birthday', object: 'march 15' };
    // The exact name, ignoring case, and a whole-word part of one.
    expect(await held({ subject: 'alice smith' })).toEqual({ ok: true, ra: { room: 'memory', action: 'remember_that', args: { ...fact, subject: 'Alice Smith', id: 'e2' } } });
    expect(await held({ subject: 'Alice' })).toEqual({ ok: true, ra: { room: 'memory', action: 'remember_that', args: { ...fact, subject: 'Alice Smith', id: 'e2' } } });
    // "me" is inside "James", but not a word of it: a new entity, said so.
    expect(await held({ subject: 'me' })).toEqual({ ok: true, ra: { room: 'memory', action: 'remember_that', args: { ...fact, subject: 'me', new_entity: true } } });
    // The classifier's own marker does not decide: an entity by that name is used.
    expect(await held({ subject: 'James', new_entity: true })).toEqual({ ok: true, ra: { room: 'memory', action: 'remember_that', args: { ...fact, subject: 'James', id: 'e1' } } });
    // An id it gave is checked, and shown by that entity's name.
    expect(await held({ subject: 'Alice', id: 'e1' })).toEqual({ ok: true, ra: { room: 'memory', action: 'remember_that', args: { ...fact, subject: 'James', id: 'e1' } } });
  });

  test('a remembered fact whose entity cannot be settled is not held (#1023)', async () => {
    const held = (args: Record<string, unknown>, over: Partial<RoomActionTargetLists> = {}) =>
      resolveHeldRoomAction({ room: 'memory', action: 'remember_that', args: { predicate: 'p', object: 'o', ...args } }, lists(over), 'Memory: remember that');
    expect(await held({ subject: 'bob' })).toEqual({ ok: false, message: 'I haven\'t done "Memory: remember that": 2 things in your memory match "bob", so I can\'t tell which you mean. Say its full name, or add it from the room.' });
    expect(await held({ subject: 'Alice', id: 'gone' })).toEqual({ ok: false, message: 'I haven\'t done "Memory: remember that": I couldn\'t find a memory entity with id "gone".' });
    // A pinned id whose name another entity shares: the card could not tell them apart.
    expect(await held({ subject: 'x', id: 'e3' })).toEqual({ ok: false, message: 'I haven\'t done "Memory: remember that": 2 things in your memory are called "Bob", so I can\'t tell which you mean. Add it from the room.' });
    // A fact missing either half, which the room would refuse after the yes.
    expect(await held({ subject: 'Alice', predicate: '  ' })).toEqual({ ok: false, message: 'I haven\'t done "Memory: remember that": say what to remember about it as well.' });
    expect(await resolveHeldRoomAction({ room: 'memory', action: 'remember_that', args: { subject: 'Alice', predicate: 'p' } }, lists(), 'Memory: remember that'))
      .toEqual({ ok: false, message: 'I haven\'t done "Memory: remember that": say what to remember about it as well.' });
    expect(await held({ subject: '  ' })).toEqual({ ok: false, message: 'I haven\'t done "Memory: remember that": say what it is about, and I\'ll show you where it goes before I save it.' });
    expect(await held({ subject: 'Alice' }, { entity: async () => { throw new Error('db locked'); } }))
      .toEqual({ ok: false, message: 'I haven\'t done "Memory: remember that": I couldn\'t look up your memory just now.' });
  });

  test('a held action keeps only the arguments its handler reads, so its card shows nothing that does not run (#1021)', async () => {
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'Pay rent', note: 'pre-approved', when: ['x'] } }, lists(), 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'create_task', args: { title: 'Pay rent' } } });
    // The item is pinned as before, and an extra key beside it is dropped.
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'reassign', args: { name: 'rent', agent: 'research', also: 'delete all' } }, lists(), 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'reassign', args: { name: 'Pay rent to landlord', agent: 'research', id: 't1' } } });
  });

  test('a default the handler would supply is shown and pinned', async () => {
    expect(await resolveHeldRoomAction({ room: 'settings', action: 'replay_onboarding' }, lists(), 'Settings: replay onboarding'))
      .toEqual({ ok: true, ra: { room: 'settings', action: 'replay_onboarding', args: { scope: 'all' } } });
    expect(await resolveHeldRoomAction({ room: 'workspaces', action: 'create_project', args: { name: 'x' } }, lists(), 'w'))
      .toEqual({ ok: true, ra: { room: 'workspaces', action: 'create_project', args: { name: 'x', template: 'vite-react' } } });
  });

  test('the item is the one the room\'s own match finds, pinned by id under its full name', async () => {
    expect(await resolveHeldRoomAction({ room: 'workspaces', action: 'start_server', args: { name: 'landing' } }, lists(), 'w'))
      .toEqual({ ok: true, ra: { room: 'workspaces', action: 'start_server', args: { name: 'jarvis-landing', id: 'p1' } } });
    // An exact title wins over an earlier partial one, as in the room.
    expect(await resolveHeldRoomAction({ room: 'content', action: 'advance', args: { name: 'launch' } }, lists(), 'c'))
      .toEqual({ ok: true, ra: { room: 'content', action: 'advance', args: { name: 'Launch', id: 'c2' } } });
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'reassign', args: { name: 'rent', agent: 'research' } }, lists(), 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'reassign', args: { name: 'Pay rent to landlord', agent: 'research', id: 't1' } } });
    // The unassign a reassign with no agent means is shown, not left implicit.
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'reassign', args: { name: 'mum' } }, lists(), 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'reassign', args: { name: 'Call mum', agent: null, id: 't2' } } });
  });

  test('with no name it is refused rather than left to the selection', async () => {
    for (const [room, action] of [['workspaces', 'start_server'], ['workspaces', 'stop_server'], ['content', 'advance'], ['content', 'regress'], ['content', 'schedule']] as const) {
      const r = await resolveHeldRoomAction({ room, action, args: {} }, lists(), `${room}: ${action}`);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toMatch(/^I haven't done ".+": say which (project|content item) by name/);
    }
  });

  test('a name that matches nothing, or a list that cannot be read, is refused', async () => {
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'complete_task', args: { name: 'zebra' } }, lists(), 'Tasks: complete task'))
      .toEqual({ ok: false, message: 'I haven\'t done "Tasks: complete task": I couldn\'t find a task called "zebra".' });
    const broken = lists({ project: async () => { throw new Error('disk'); } });
    expect(await resolveHeldRoomAction({ room: 'workspaces', action: 'select_project', args: { name: 'demo' } }, broken, 'W'))
      .toEqual({ ok: false, message: 'I haven\'t done "W": I couldn\'t look up your projects just now.' });
  });

  test('an id already given must exist, and is kept', async () => {
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'complete_task', args: { id: 't2' } }, lists(), 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'complete_task', args: { id: 't2', name: 'Call mum' } } });
    expect((await resolveHeldRoomAction({ room: 'tasks', action: 'complete_task', args: { id: 'nope', name: 'mum' } }, lists(), 't')).ok)
      .toBe(false);
  });

  test('two items by the shown name are refused: the card could not tell them apart', async () => {
    const twins = lists({ content: async () => [{ id: 'c1', title: 'Launch' }, { id: 'c2', title: 'launch' }] });
    expect(await resolveHeldRoomAction({ room: 'content', action: 'advance', args: { name: 'launch' } }, twins, 'Content: advance'))
      .toEqual({ ok: false, message: 'I haven\'t done "Content: advance": 2 content items are called "Launch", so I can\'t tell which you mean. Do it from the room.' });
  });

  test('a finished task is not one a held action picks', async () => {
    const monthly = lists({ task: async () => [
      { id: 'old', what: 'Pay rent', status: 'completed' },
      { id: 'failed', what: 'Pay rent', status: 'failed' },
      { id: 'now', what: 'Pay rent', status: 'pending' },
    ] });
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'complete_task', args: { name: 'pay rent' } }, monthly, 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'complete_task', args: { name: 'Pay rent', id: 'now' } } });
    expect((await resolveHeldRoomAction({ room: 'tasks', action: 'complete_task', args: { id: 'old' } }, monthly, 't')).ok).toBe(false);
  });

  test('arguments the handler would choose between are collapsed to the one it runs', async () => {
    expect(await resolveHeldRoomAction({ room: 'settings', action: 'set_default_model', args: { provider: 'openai', model: 'gpt', ref: 'evil:model' } }, lists(), 's'))
      .toEqual({ ok: true, ra: { room: 'settings', action: 'set_default_model', args: { ref: 'evil:model' } } });
    expect(await resolveHeldRoomAction({ room: 'settings', action: 'test_provider', args: { provider: 'openai', name: 'groq' } }, lists(), 's'))
      .toEqual({ ok: true, ra: { room: 'settings', action: 'test_provider', args: { provider: 'openai' } } });
  });

  test('a name the classifier gave is repeated back cut short', async () => {
    const r = await resolveHeldRoomAction({ room: 'tasks', action: 'complete_task', args: { name: 'z'.repeat(500) } }, lists(), 't');
    expect(!r.ok && r.message).toBe(`I haven't done "t": I couldn't find a task called "${'z'.repeat(80)}...".`);
  });

  test('an action with nothing to settle is unchanged, and no list is read for it', async () => {
    let read = 0;
    const counting = lists({ task: async () => { read += 1; return []; } });
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'x' } }, counting, 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'create_task', args: { title: 'x' } } });
    expect(read).toBe(0);
  });
});

describe('the time a room action is for is settled before anything is shown or sent (#1022)', () => {
  // 23:30 on 2026-10-20 in New York; already the 21st in Tokyo.
  const now = Date.parse('2026-10-21T03:30:00Z');
  const ny = { now, timeZone: 'America/New_York' };

  test('the words are read at the clock given, in its zone, and the instant pinned with the zone', () => {
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'Pay rent', when: ' tomorrow at 9am ' } }, ny, 'Tasks: create task'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'create_task', args: { title: 'Pay rent', when: 'tomorrow at 9am', when_ts: Date.parse('2026-10-21T13:00:00Z') }, timeZone: 'America/New_York' } });
    expect(settleRoomActionTime({ room: 'calendar', action: 'schedule_event', args: { title: 'Call', when: 'tomorrow at 9am' } }, { now, timeZone: 'Asia/Tokyo' }, 'c'))
      .toMatchObject({ ok: true, ra: { args: { when_ts: Date.parse('2026-10-22T00:00:00Z') }, timeZone: 'Asia/Tokyo' } });
  });

  test('an instant the classifier or the model wrote is never taken as settled', () => {
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: '2026-10-22 10:00', when_ts: 1 } }, ny, 't'))
      .toMatchObject({ ok: true, ra: { args: { when_ts: Date.parse('2026-10-22T14:00:00Z') } } });
    // With no words to read, no instant at all: an undated task.
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when_ts: 1 } }, ny, 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'create_task', args: { title: 'x' } } });
  });

  test('words that are not a time, or no time where one is needed, are refused', () => {
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: 'later today' } }, ny, 'Tasks: create task'))
      .toEqual({ ok: false, message: 'I haven\'t done "Tasks: create task": I couldn\'t tell what time "later today" means. Say a day and a time with am or pm, like "tomorrow at 3pm" or "friday at 10am".' });
    // Words that read, as an instant no card can show (#1022 review).
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: 'in 999999999 weeks' } }, ny, 'Tasks: create task'))
      .toEqual({ ok: false, message: 'I haven\'t done "Tasks: create task": I couldn\'t tell what time "in 999999999 weeks" means. Say a day and a time with am or pm, like "tomorrow at 3pm" or "friday at 10am".' });
    // Text that would reorder the reply is written out (#1022 review).
    const rlo = String.fromCodePoint(0x202e);
    const refused = settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: `soon${rlo}yadot` } }, ny, 't');
    expect(!refused.ok && refused.message).toContain('"soon\\u202eyadot"');
    expect(settleRoomActionTime({ room: 'content', action: 'schedule', args: { name: 'Launch', when: '  ' } }, ny, 'Content: schedule'))
      .toEqual({ ok: false, message: 'I haven\'t done "Content: schedule": say when, like "tomorrow at 3pm", and I\'ll show you the time before I do it.' });
  });

  test('with no clock (a tab that never said its zone) a time is refused, and an undated action is not', () => {
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: 'tomorrow at 9am' } }, null, 'Tasks: create task'))
      .toEqual({ ok: false, message: 'I haven\'t done "Tasks: create task": the dashboard tab you spoke to did not say its time zone. Reload the dashboard to set times by voice.' });
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when_ts: 3 } }, null, 't'))
      .toEqual({ ok: true, ra: { room: 'tasks', action: 'create_task', args: { title: 'x' } } });
  });

  test('a time already gone is refused, with when it was; one within a minute still goes (#1022 review)', () => {
    // ny.now is 23:30 on Tue Oct 20 in New York.
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: 'tonight' } }, ny, 'Tasks: create task'))
      .toEqual({ ok: false, message: 'I haven\'t done "Tasks: create task": "tonight" is Tue, Oct 20, 21:00 EDT, which has passed. Say a later time.' });
    for (const when of ['this afternoon', 'tuesday at 9am', 'yesterday', '2026-10-01 09:00', 'today at 9am']) {
      const r = settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when } }, ny, 't');
      expect([when, !r.ok && r.message]).toEqual([when, expect.stringContaining('which has passed. Say a later time.')]);
    }
    // 23:29 is exactly a minute before ny.now: still taken, as said. A second later, it has passed.
    const at2329 = (now: number) => settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: 'today at 11:29pm' } }, { ...ny, now }, 't');
    expect(at2329(ny.now).ok).toBe(true);
    expect(at2329(ny.now + 1_000).ok).toBe(false);
  });

  test('a browser zone this runtime does not know is said as such, not as an old tab (#1022 review)', () => {
    expect(settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: 'tomorrow at 9am' } }, { unavailable: unrecognisedTimeZone('Etc/Unknown') }, 'Tasks: create task'))
      .toEqual({ ok: false, message: 'I haven\'t done "Tasks: create task": your browser reported a time zone I don\'t recognise ("Etc/Unknown"), and no time zone is set in the Jarvis config. Set "timezone" in config.yaml and restart Jarvis, or set the time from the room.' });
  });

  test('a browser that could not say its zone is told so; a long one is cut and marked (#1022 review)', () => {
    expect(unrecognisedTimeZone('')).toBe('your browser did not report a time zone, and no time zone is set in the Jarvis config. Set "timezone" in config.yaml and restart Jarvis, or set the time from the room.');
    expect(unrecognisedTimeZone('Z'.repeat(50))).toContain(`("${'Z'.repeat(40)}...")`);
  });

  test('a refusal on a fall-back night says which 01:30 it means (#1022 review)', () => {
    // 01:40 EDT on Nov 1 2026, the first time through; "today at 1:30am" is the first 01:30, gone.
    const r = settleRoomActionTime({ room: 'tasks', action: 'create_task', args: { title: 'x', when: 'today at 1:30am' } },
      { now: Date.parse('2026-11-01T05:40:00Z'), timeZone: 'America/New_York' }, 't');
    expect(!r.ok && r.message).toContain('is Sun, Nov 1, 01:30 EDT, which has passed');
  });

  test('an action with no time is left as it is', () => {
    const ra = { room: 'tasks', action: 'complete_task', args: { name: 'x', when_ts: 5 } };
    expect(settleRoomActionTime(ra, ny, 't')).toEqual({ ok: true, ra });
  });

  test('a held action is settled at the clock it is given, after its item', async () => {
    expect(await resolveHeldRoomAction({ room: 'content', action: 'schedule', args: { name: 'launch', when: 'tomorrow at 9am', when_ts: 7 } }, lists(), 'c', ny))
      .toEqual({ ok: true, ra: { room: 'content', action: 'schedule', args: { name: 'Launch', id: 'c2', when: 'tomorrow at 9am', when_ts: Date.parse('2026-10-21T13:00:00Z') }, timeZone: 'America/New_York' } });
    expect(await resolveHeldRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'x', when: 'tuesday at 3' } }, lists(), 'Tasks: create task', ny))
      .toMatchObject({ ok: false });
  });

  test('a zone a dashboard names is used only when it is one', () => {
    expect(voiceTimeZone('America/New_York')).toBe('America/New_York');
    expect(voiceTimeZone('america/new_york')).toBe('America/New_York');
    expect(voiceTimeZone('UTC')).toBe('UTC');
    expect(voiceTimeZone('EST5EDT')).toBe('EST5EDT');
    // An offset, where the runtime takes one (Bun 1.3.8 does).
    expect(voiceTimeZone('+05:30')).toBe('+05:30');
    expect(voiceTimeZone('-08:00')).toBe('-08:00');
    for (const bad of ['Mars/Phobos', '../../etc/passwd', 'A'.repeat(65), '', 5, null, undefined, { toString: () => 'UTC' }]) {
      expect([bad, voiceTimeZone(bad)]).toEqual([bad, null]);
    }
  });

  test('the card names the instant with its zone, so a repeated hour says which', () => {
    expect(describeSettledTime(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('Sun, Nov 1, 2026, 01:30 EDT (America/New_York)');
    expect(describeSettledTime(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York')).toBe('Sun, Nov 1, 2026, 01:30 EST (America/New_York)');
  });
});

