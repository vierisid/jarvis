/**
 * #1008: a held voice room action is settled before the person is asked:
 * its handler's defaults filled in and the item it acts on pinned by id.
 */

import { describe, expect, test } from 'bun:test';
import { resolveHeldRoomAction, type RoomActionTargetLists } from './voice-room-action-gate.ts';

const lists = (over: Partial<RoomActionTargetLists> = {}): RoomActionTargetLists => ({
  project: async () => [{ id: 'p1', name: 'jarvis-landing' }, { id: 'p2', name: 'demo-app' }],
  content: async () => [{ id: 'c1', title: 'Launch post draft' }, { id: 'c2', title: 'Launch' }],
  task: async () => [{ id: 't1', what: 'Pay rent to landlord' }, { id: 't2', what: 'Call mum' }],
  ...over,
});

describe('resolveHeldRoomAction (#1008)', () => {
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
