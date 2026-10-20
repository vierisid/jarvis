/**
 * #1008: a held voice room action is settled before the person is asked:
 * its handler's defaults filled in and the item it acts on pinned by id.
 */

import { describe, expect, test } from 'bun:test';
import { realtimeRoomActionDecision, resolveHeldRoomAction, roomActionAuditRow, type RoomActionTargetLists } from './voice-room-action-gate.ts';
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
  ...over,
});

describe('resolveHeldRoomAction (#1008)', () => {
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
