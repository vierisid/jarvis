/**
 * The daemon's half of a room action that reports back (#933): the action is
 * broadcast with a resultId, and a panel's `room_action_result` on the
 * dashboard socket decides what the pebble says. The service is constructed
 * but never start()ed; broadcast() reaches the fake client registered here.
 */

import { describe, expect, test } from 'bun:test';
import { describeRoomAction, isVoiceAffirmative, roomActionReply, WebSocketService } from './ws-service.ts';
import { TOOL_RESULT_GRACE_MS } from '../comms/realtime.ts';
import { ROOM_ACTION_QUEUE_TTL_MS } from './room-action-results.ts';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { RoomActionTargetLists } from './voice-room-action-gate.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { createCommitment } from '../vault/commitments.ts';
import { createContent } from '../vault/content-pipeline.ts';
import type { JarvisConfig } from '../config/types.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { buildTaintGating } from '../authority/taint-gating.ts';
import { EmergencyController } from '../authority/emergency.ts';
import type { Intent } from '../voice/intent.ts';

const makeService = (orchestrator: AgentOrchestrator = new AgentOrchestrator()) => {
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => ({ llm: { providers: {} } }) as unknown as JarvisConfig,
    getOrchestrator: () => orchestrator,
  } as never;
  const svc = new WebSocketService(0, fakeAgent);
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = { send: (raw: string) => { sent.push(JSON.parse(raw)); }, sendBinary: () => {} } as never;
  const internals = svc as unknown as {
    wsServer: { getClients: () => Set<unknown> };
    routeMessage: (msg: unknown, ws: unknown) => Promise<unknown>;
  };
  internals.wsServer.getClients().add(ws);
  const broadcastResultId = (): string => {
    const note = sent.find((m) => m.type === 'notification' && m.payload.source === 'room_action');
    if (!note) throw new Error('no room_action broadcast');
    return note.payload.resultId as string;
  };
  return { svc, ws, sent, internals, broadcastResultId };
};

describe('requestRoomAction', () => {
  test('broadcasts the action with a resultId and resolves on the panel answer', async () => {
    for (const [accepted, outcome] of [[true, 'accepted'], [false, 'rejected']] as const) {
      const { svc, ws, sent, internals, broadcastResultId } = makeService();
      const pending = svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 1000);
      expect(sent[0]!.payload).toMatchObject({ source: 'room_action', room: 'settings', action: 'switch_tab', args: { tab: 'voice' } });
      const resultId = broadcastResultId();
      expect(typeof resultId).toBe('string');
      expect(resultId.length).toBeGreaterThan(0);
      const reply = await internals.routeMessage(
        { type: 'room_action_result', payload: { resultId, accepted }, timestamp: Date.now() }, ws);
      // Answered silently: no "Unknown message type" error back to the panel.
      expect(reply).toBeUndefined();
      expect(await pending).toBe(outcome);
    }
  });

  test('with no answer it says so instead of assuming success', async () => {
    const { svc } = makeService();
    // A real action (#969 refuses workflows/switch_tab, which no handler runs).
    expect(await svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 10))
      .toBe('no_answer');
  });

  test('with no client connected it says so at once, not after the timeout', async () => {
    const { svc, internals } = makeService();
    internals.wsServer.getClients().clear();
    const t0 = Date.now();
    // Nothing was sent, so not "sent but no answer" (#1011).
    expect(await svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 60_000))
      .toBe('unreached');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('an answer naming another request does not settle this one', async () => {
    const { svc, ws, internals } = makeService();
    const pending = svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 30);
    await internals.routeMessage({ type: 'room_action_result', payload: { resultId: 'someone-else', accepted: true } }, ws);
    expect(await pending).toBe('no_answer');
  });
});

// #965: the dashboard's own voice paths (the classifier and the realtime nav
// tool) used to acknowledge a room action before any room had seen it: "Done:
// <action> in <room>." and "Switching to <tab> view.". They now ask the
// dashboard the user spoke to, and say what it answered.
describe('dashboard voice room actions report what the room did (#965)', () => {
  type Sent = { type: string; payload: Record<string, unknown> };
  const client = () => {
    const sent: Sent[] = [];
    const ws = { send: (raw: string) => { sent.push(JSON.parse(raw)); return raw.length; }, sendBinary: () => {} };
    return { ws, sent };
  };
  // Shorten the wait for an answer: the real one is the bus's 5s queue TTL.
  const shortWait = (svc: WebSocketService) => {
    const real = svc.requestRoomAction.bind(svc);
    (svc as unknown as { requestRoomAction: typeof real }).requestRoomAction = (a, _t, o) => real(a, 50, o);
  };
  const setup = () => {
    const base = makeService();
    base.internals.wsServer.getClients().clear();
    const speaker = client();
    const other = client();
    base.internals.wsServer.getClients().add(speaker.ws);
    base.internals.wsServer.getClients().add(other.ws);
    const internals = base.svc as unknown as {
      routeMessage: (msg: unknown, ws: unknown) => Promise<unknown>;
      executeRealtimeNavTool: (name: string, args: Record<string, unknown>, ws: unknown) => Promise<string | null>;
      handleVoiceRoomAction: (ra: unknown, requestId: string, ws: unknown) => Promise<void>;
    };
    const actionTo = (c: { sent: Sent[] }) => c.sent.find((m) => m.payload?.source === 'room_action');
    const answer = async (from: { ws: unknown }, resultId: unknown, accepted: boolean) =>
      internals.routeMessage({ type: 'room_action_result', payload: { resultId, accepted }, timestamp: Date.now() }, from.ws);
    // Answer as soon as the action has gone out.
    const answerWhenSent = (from: ReturnType<typeof client>, accepted: boolean) => {
      const tick = setInterval(() => {
        const a = actionTo(from);
        if (!a) return;
        clearInterval(tick);
        void answer(from, a.payload.resultId, accepted);
      }, 1);
    };
    return { svc: base.svc, internals, speaker, other, actionTo, answer, answerWhenSent };
  };

  test('only the dashboard that spoke is asked, and only its answer counts', async () => {
    const { svc, speaker, other, actionTo, answer } = setup();
    const pending = svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 200, { client: speaker.ws as never });
    const mine = actionTo(speaker)!;
    const theirs = actionTo(other)!;
    // A tab switch still reaches everyone (#974); only the speaker is asked.
    expect(mine.payload).toMatchObject({ room: 'settings', action: 'switch_tab', resultFrom: 'dashboard' });
    expect(typeof mine.payload.resultId).toBe('string');
    expect(theirs.payload).toMatchObject({ room: 'settings', action: 'switch_tab' });
    expect(theirs.payload.resultId).toBeUndefined();
    // Another client that learned the id does not settle it.
    await answer(other, mine.payload.resultId, false);
    await answer(speaker, mine.payload.resultId, true);
    expect(await pending).toBe('accepted');
  });

  test('a dashboard that is gone is reported unreached at once', async () => {
    const { svc } = setup();
    const gone = client();
    const t0 = Date.now();
    expect(await svc.requestRoomAction({ room: 'settings', action: 'enable_tts' }, 60_000, { client: gone.ws as never }))
      .toBe('unreached');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(gone.sent).toEqual([]);
  });

  // #1011: a socket that is closing, but whose close the server has not
  // handled yet, is still a client; its send is dropped (Bun returns 0).
  test('a dashboard whose socket drops the frame is unreached, and nobody is told it was sent', async () => {
    const { svc, internals, other } = setup();
    const closing = { sent: [] as Sent[], ws: { send: () => 0, sendBinary: () => {} } };
    (svc as unknown as { wsServer: { getClients: () => Set<unknown> } }).wsServer.getClients().add(closing.ws);
    expect(await svc.requestRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'x' } }, 60_000, { client: closing.ws as never }))
      .toBe('unreached');
    await internals.handleVoiceRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'x' } }, 'req', closing.ws);
    const acks = other.sent.filter((m) => m.payload?.source === 'assistant_message').map((m) => m.payload.text);
    expect(acks).toEqual(["I couldn't reach Tasks on the dashboard, so nothing was done."]);
    expect(roomActionReply({ room: 'tasks', action: 'create_task' }, 'unreached')).not.toContain('sent');
  });

  test('a view action for a dashboard that cannot be reached goes nowhere, so "nothing was done" is true', async () => {
    const { svc, internals, other } = setup();
    const closing = { ws: { send: () => 0, sendBinary: () => {} } };
    (svc as unknown as { wsServer: { getClients: () => Set<unknown> } }).wsServer.getClients().add(closing.ws);
    for (const ws of [closing.ws, client().ws]) {
      other.sent.length = 0;
      const reply = await internals.executeRealtimeNavTool('dashboard_room_action', { room: 'tasks', action: 'set_filter', args: { field: 'status', value: 'done' } }, ws);
      expect(reply).toBe("I couldn't reach Tasks on the dashboard, so nothing was done.");
      expect(other.sent.filter((m) => m.payload?.source === 'room_action' || m.payload?.source === 'navigate_room')).toEqual([]);
    }
  });

  test('the realtime tool tells the model what the room answered, never "Done"', async () => {
    const cases = [
      [true, 'Turning off text to speech. (Settings accepted it and started it; it shows the result on screen.)'],
      [false, "Settings didn't accept that."],
      [null, "I sent that to Settings, but it didn't answer, so I can't tell whether it happened."],
    ] as const;
    for (const [accepted, said] of cases) {
      const { svc, internals, speaker, answerWhenSent } = setup();
      shortWait(svc);
      if (accepted !== null) answerWhenSent(speaker, accepted);
      const reply = await internals.executeRealtimeNavTool(
        'dashboard_room_action', { room: 'settings', action: 'disable_tts', args: {} }, speaker.ws);
      expect(reply).toBe(said);
    }
  });

  // #1010: the answerer is told how long it is waited for, so the bus can
  // drop an action that would otherwise run after the caller gave up.
  test('the dashboard asked is told how long the daemon waits, which is the wait itself', async () => {
    const { svc, speaker, actionTo } = setup();
    const t0 = Date.now();
    expect(await svc.requestRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'x' } }, 40, { client: speaker.ws as never }))
      .toBe('no_answer');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(39);
    expect(actionTo(speaker)!.payload.expiresInMs).toBe(40);
  });

  test('the realtime tool waits less than the bus queues, and says so in the action', async () => {
    const { internals, speaker, actionTo, answerWhenSent } = setup();
    answerWhenSent(speaker, true);
    await internals.executeRealtimeNavTool('dashboard_room_action', { room: 'tasks', action: 'create_task', args: { title: 'x' } }, speaker.ws);
    const waited = actionTo(speaker)!.payload.expiresInMs as number;
    // The measured gap the issue named: 3500ms against the bus's 5000ms.
    expect(waited).toBe(3500);
    expect(ROOM_ACTION_QUEUE_TTL_MS).toBe(5000);
  });

  test('the classifier path waits the full queue TTL, and says so', async () => {
    const { internals, speaker, actionTo, answerWhenSent } = setup();
    answerWhenSent(speaker, true);
    await internals.handleVoiceRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'x' } }, 'req', speaker.ws);
    expect(actionTo(speaker)!.payload.expiresInMs).toBe(ROOM_ACTION_QUEUE_TTL_MS);
  });

  test('the panels are told too; a dashboard not asked is not', async () => {
    const { svc, speaker, other, actionTo } = setup();
    // The pebble's request: every panel may answer, so every one is told.
    await svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 20);
    for (const c of [speaker, other]) expect(actionTo(c)!.payload).toMatchObject({ expiresInMs: 20 });
    const { svc: svc2, speaker: s2, other: o2, actionTo: to2 } = setup();
    await svc2.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 20, { client: s2.ws as never });
    expect(to2(s2)!.payload.expiresInMs).toBe(20);
    // The copy every other dashboard gets for a tab switch is not waited on.
    expect(to2(o2)!.payload.resultId).toBeUndefined();
    expect(to2(o2)!.payload.expiresInMs).toBeUndefined();
  });

  test('an accepted presentation action is not reported as work started', async () => {
    const { internals, speaker, answerWhenSent } = setup();
    answerWhenSent(speaker, true);
    const reply = await internals.executeRealtimeNavTool(
      'dashboard_room_action', { room: 'tasks', action: 'set_filter', args: { field: 'status', value: 'pending' } }, speaker.ws);
    expect(reply).not.toContain('started it');
  });

  test('a tab switch by the realtime tool reads like the pebble\'s', async () => {
    const { internals, speaker, answerWhenSent } = setup();
    answerWhenSent(speaker, false);
    expect(await internals.executeRealtimeNavTool(
      'dashboard_room_action', { room: 'settings', action: 'switch_tab', args: { tab: 'billing' } }, speaker.ws))
      .toBe("Settings didn't switch to billing.");
  });

  test('the classifier path acknowledges after the room answers, with what it answered', async () => {
    for (const [accepted, ack] of [[true, 'Switched Agents to builder.'], [false, "Agents didn't switch to builder."]] as const) {
      const { internals, speaker, other, answerWhenSent } = setup();
      answerWhenSent(speaker, accepted);
      await internals.handleVoiceRoomAction({ room: 'agents', action: 'switch_tab', args: { tab: 'builder' } }, 'req-1', speaker.ws);
      const acks = other.sent.filter((m) => m.payload?.source === 'assistant_message').map((m) => m.payload.text);
      expect(acks).toEqual([ack]);
      // The room is opened first, then asked.
      const order = speaker.sent.map((m) => m.payload?.source);
      expect(order.indexOf('navigate_room')).toBeLessThan(order.indexOf('room_action'));
      expect(order.indexOf('room_action')).toBeLessThan(order.indexOf('assistant_message'));
    }
  });

  test('with no answer the classifier path says it cannot tell', async () => {
    const { svc, internals, speaker, other } = setup();
    shortWait(svc);
    // A real action (#969 refuses workflows/run, which no handler runs).
    await internals.handleVoiceRoomAction({ room: 'workflows', action: 'create_from_nl', args: { prompt: '' } }, 'req-2', speaker.ws);
    const acks = other.sent.filter((m) => m.payload?.source === 'assistant_message').map((m) => m.payload.text);
    expect(acks).toEqual(["I sent that to Workflows, but it didn't answer, so I can't tell whether it happened."]);
  });

  test('a dashboard that disconnects while asked gets no_answer at once', async () => {
    const { svc, speaker } = setup();
    const t0 = Date.now();
    const pending = svc.requestRoomAction({ room: 'settings', action: 'enable_tts' }, 60_000, { client: speaker.ws as never });
    (svc as unknown as { roomActionResults: { abandonAnswerer: (ws: unknown) => void } }).roomActionResults.abandonAnswerer(speaker.ws);
    expect(await pending).toBe('no_answer');
    expect(Date.now() - t0).toBeLessThan(1000);
    // Wired to the socket's disconnect: the handler does it.
    const again = svc.requestRoomAction({ room: 'settings', action: 'enable_tts' }, 60_000, { client: speaker.ws as never });
    (svc as unknown as { handleClientDisconnect: (ws: unknown) => void }).handleClientDisconnect(speaker.ws);
    expect(await again).toBe('no_answer');
    expect(Date.now() - t0).toBeLessThan(1000);
    const src = await Bun.file(new URL('./ws-service.ts', import.meta.url)).text();
    expect(src).toContain('onDisconnect: (ws) => this.handleClientDisconnect(ws),');
  });

  test('the realtime tool refuses a room that does not exist without waiting', async () => {
    const { internals, speaker, other } = setup();
    expect(await internals.executeRealtimeNavTool('dashboard_room_action', { room: 'billing', action: 'open' }, speaker.ws))
      .toBe('There is no "billing" room.');
    expect([...speaker.sent, ...other.sent]).toEqual([]);
  });

  test('the realtime tool waits less than the session waits for sibling results', async () => {
    const { svc, internals, speaker } = setup();
    let waited = -1;
    (svc as unknown as { requestRoomAction: (a: unknown, t: number) => Promise<string> }).requestRoomAction =
      async (_a, t) => { waited = t; return 'no_answer'; };
    await internals.executeRealtimeNavTool('dashboard_room_action', { room: 'settings', action: 'enable_tts' }, speaker.ws);
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThan(TOOL_RESULT_GRACE_MS);
  });
});

describe('roomActionReply claims no more than the room said (#965)', () => {
  test('accepted async actions are under way, not done', () => {
    expect(roomActionReply({ room: 'workflows', action: 'create_from_nl', args: { prompt: 'checks AI news every morning' } }, 'accepted'))
      .toBe('Creating an empty workflow. To have me build "checks AI news every morning", ask me in chat.');
    expect(roomActionReply({ room: 'memory', action: 'remember_that', args: { subject: 'alice', predicate: 'birthday', object: 'march 15' } }, 'accepted'))
      .toBe("Saving that alice's birthday is march 15.");
    expect(roomActionReply({ room: 'tools', action: 'something_new' }, 'accepted')).toBe('Tools took that.');
  });

  test('no accepted acknowledgement says it was done', () => {
    // Every action the ack table knows, accepted, with typical args.
    const args = { tab: 'voice', name: 'x', query: 'x', filter: 'x', prompt: 'x', subject: 'a', predicate: 'b', object: 'c', title: 't', when: 'w', provider: 'p', model: 'm' };
    const src = require('node:fs').readFileSync(new URL('./ws-service.ts', import.meta.url), 'utf8') as string;
    const table = src.slice(src.indexOf('function ackForRoomAction('));
    const actions = [...table.matchAll(/case '(\w+)':/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(30);
    for (const action of actions) {
      const reply = roomActionReply({ room: 'settings', action, args }, 'accepted');
      expect(`${action}: ${reply}`).not.toMatch(/: (Done|Remembered|Created|Completed|Finished)\b/);
    }
  });

  test('a tab switch with no tab still reads as a sentence', () => {
    expect(roomActionReply({ room: 'agents', action: 'switch_tab', args: {} }, 'rejected')).toBe("Agents didn't switch to that tab.");
  });
});

// #969: the realtime tool and the classifier path both reached the dashboard
// with any action the model named, authority grants included, and nothing
// on either path consults the authority engine. Only actions a room's handler
// carries out (ROOM_ACTIONS) are sent; anything else is refused before a
// single frame goes out, so no room is opened and no action broadcast.
describe('voice room actions are limited to what the rooms carry out (#969)', () => {
  type Sent = { type: string; payload: Record<string, unknown> };
  const setup = () => {
    const base = makeService();
    base.internals.wsServer.getClients().clear();
    const mk = () => {
      const sent: Sent[] = [];
      return { sent, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); return raw.length; }, sendBinary: () => {} } };
    };
    const speaker = mk();
    const other = mk();
    base.internals.wsServer.getClients().add(speaker.ws);
    base.internals.wsServer.getClients().add(other.ws);
    const internals = base.svc as unknown as {
      executeRealtimeNavTool: (name: string, args: Record<string, unknown>, ws: unknown) => Promise<string | null>;
      handleVoiceRoomAction: (ra: unknown, requestId: string, ws: unknown) => Promise<void>;
    };
    const roomFrames = () => [...speaker.sent, ...other.sent]
      .filter((m) => m.payload?.source === 'room_action' || m.payload?.source === 'navigate_room');
    return { svc: base.svc, internals, speaker, other, roomFrames };
  };

  test('the realtime tool refuses an authority grant or revoke and broadcasts nothing', async () => {
    for (const action of ['grant_access', 'revoke_access']) {
      const { internals, speaker, roomFrames } = setup();
      const reply = await internals.executeRealtimeNavTool(
        'dashboard_room_action', { room: 'authority', action, args: { action: 'send_email' } }, speaker.ws);
      expect(roomFrames()).toEqual([]);
      expect(reply).toBe("Permissions can't be changed by voice. Tell the user to use the Grants tab in Authority.");
    }
  });

  test('the realtime tool refuses an action the room does not carry out and broadcasts nothing', async () => {
    for (const [room, action] of [['settings', 'set_primary_llm'], ['workflows', 'run'], ['usage', 'switch_tab']] as const) {
      const { internals, speaker, roomFrames } = setup();
      const reply = await internals.executeRealtimeNavTool('dashboard_room_action', { room, action, args: {} }, speaker.ws);
      expect(roomFrames()).toEqual([]);
      expect(reply).toMatch(/^.+ has no "\w+" action, so I did not send it\.$/);
    }
  });

  test('the classifier path refuses an authority grant from plain speech and broadcasts nothing', async () => {
    const { internals, speaker, other, roomFrames } = setup();
    await internals.handleVoiceRoomAction(
      { room: 'authority', action: 'grant_access', args: { action: 'send_email' } }, 'req-969', speaker.ws);
    expect(roomFrames()).toEqual([]);
    const acks = other.sent.filter((m) => m.payload?.source === 'assistant_message').map((m) => m.payload.text);
    expect(acks).toEqual(["Permissions can't be changed by voice. Use the Grants tab in Authority."]);
  });

  test('requestRoomAction itself refuses an unlisted action without sending it', async () => {
    const { svc, speaker, roomFrames } = setup();
    expect(await svc.requestRoomAction({ room: 'authority', action: 'grant_access', args: { action: 'send_email' } }, 60_000))
      .toBe('rejected');
    expect(await svc.requestRoomAction({ room: 'authority', action: 'revoke_access' }, 60_000, { client: speaker.ws as never }))
      .toBe('rejected');
    expect(roomFrames()).toEqual([]);
  });

  test('a listed action still goes out', async () => {
    const { svc, speaker, roomFrames } = setup();
    expect(await svc.requestRoomAction({ room: 'authority', action: 'switch_tab', args: { tab: 'audit' } }, 10, { client: speaker.ws as never }))
      .toBe('no_answer');
    expect(roomFrames().map((m) => m.payload.action)).toEqual(['switch_tab', 'switch_tab']);
  });
});

// #969: navigation has no answer to wait for, so the realtime tools say they
// asked rather than that it happened ("Opened the settings room.", "close
// done."), and a room or window action that does not exist is not broadcast.
describe('realtime navigation says it asked, not that it happened (#969)', () => {
  const setup = () => {
    const base = makeService();
    const internals = base.svc as unknown as {
      executeRealtimeNavTool: (name: string, args: Record<string, unknown>, ws: unknown) => Promise<string | null>;
    };
    return { ...base, nav: (name: string, args: Record<string, unknown>) => internals.executeRealtimeNavTool(name, args, base.ws) };
  };
  const unconfirmed = /^Asked the dashboard to .+; it does not report back whether it did\.$/;

  test('opening a room', async () => {
    const { nav, sent } = setup();
    const reply = await nav('open_dashboard_room', { room: 'settings' });
    expect(reply).toMatch(unconfirmed);
    expect(reply).toContain('Settings');
    expect(sent.map((m) => m.payload.source)).toEqual(['navigate_room']);
  });

  test('going back to the thread', async () => {
    const { nav, sent } = setup();
    expect(await nav('go_back_to_thread', {})).toMatch(unconfirmed);
    expect(sent).toHaveLength(1);
  });

  test('a window control', async () => {
    const { nav, sent } = setup();
    expect(await nav('control_dashboard_window', { action: 'close' })).toMatch(unconfirmed);
    expect(sent).toHaveLength(1);
  });

  test('a room or window action that does not exist goes nowhere', async () => {
    const { nav, sent } = setup();
    expect(await nav('open_dashboard_room', { room: 'billing' })).toBe('There is no "billing" room.');
    expect(await nav('control_dashboard_window', { action: 'delete' })).toBe('There is no "delete" window action.');
    expect(await nav('control_dashboard_window', { action: 'close', target: 'billing' })).toBe('There is no "billing" room.');
    expect(sent).toEqual([]);
  });
});

// #974: every dashboard with the room mounted runs the handler it is sent, so
// a broadcast side-effecting action ran once per open dashboard while the user
// heard one answer. Only presentation actions may go to everyone.
describe('a side-effecting room action runs on one dashboard only (#974)', () => {
  type Sent = { type: string; payload: Record<string, unknown> };
  const setup = () => {
    const base = makeService();
    base.internals.wsServer.getClients().clear();
    const mk = () => {
      const sent: Sent[] = [];
      return { sent, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); return raw.length; }, sendBinary: () => {} } };
    };
    const speaker = mk();
    const other = mk();
    const panel = mk();
    for (const c of [speaker, other, panel]) base.internals.wsServer.getClients().add(c.ws);
    const internals = base.svc as unknown as {
      executeRealtimeNavTool: (name: string, args: Record<string, unknown>, ws: unknown) => Promise<string | null>;
      handleVoiceRoomAction: (ra: unknown, requestId: string, ws: unknown) => Promise<void>;
    };
    const real = base.svc.requestRoomAction.bind(base.svc);
    (base.svc as unknown as { requestRoomAction: typeof real }).requestRoomAction = (a, _t, o) => real(a, 20, o);
    const frames = (c: { sent: Sent[] }) => c.sent
      .filter((m) => m.payload?.source === 'room_action' || m.payload?.source === 'navigate_room')
      .map((m) => `${m.payload.source}:${String(m.payload.action ?? m.payload.key)}`);
    return { svc: base.svc, internals, speaker, other, panel, frames };
  };

  const sideEffecting = [
    ['tasks', 'create_task', { title: 'Pay rent', when: 'tomorrow' }],
    ['agents', 'spawn_agent', { specialist: 'research', task: 'look' }],
    ['workspaces', 'create_project', { name: 'demo' }],
    ['settings', 'enable_tts', {}],
  ] as const;

  test('the realtime tool sends a side-effecting action, and its navigation, to the speaker alone', async () => {
    for (const [room, action, args] of sideEffecting) {
      const { internals, speaker, other, panel, frames } = setup();
      await internals.executeRealtimeNavTool('dashboard_room_action', { room, action, args }, speaker.ws);
      expect(frames(speaker)).toEqual([`navigate_room:${room}`, `room_action:${action}`]);
      expect(frames(other)).toEqual([]);
      expect(frames(panel)).toEqual([]);
    }
  });

  test('the classifier path sends a side-effecting action, and its navigation, to the speaker alone', async () => {
    for (const [room, action, args] of sideEffecting) {
      const { internals, speaker, other, panel, frames } = setup();
      await internals.handleVoiceRoomAction({ room, action, args }, 'req-974', speaker.ws);
      expect(frames(speaker)).toEqual([`navigate_room:${room}`, `room_action:${action}`]);
      expect(frames(other)).toEqual([]);
      expect(frames(panel)).toEqual([]);
    }
  });

  test('a tab switch still goes to every dashboard and panel, with the room opened on each', async () => {
    const { internals, speaker, other, panel, frames } = setup();
    await internals.executeRealtimeNavTool('dashboard_room_action', { room: 'agents', action: 'switch_tab', args: { tab: 'builder' } }, speaker.ws);
    for (const c of [speaker, other, panel]) expect(frames(c)).toEqual(['navigate_room:agents', 'room_action:switch_tab']);
    // Only the speaker is asked to answer.
    expect(speaker.sent.find((m) => m.payload?.source === 'room_action')!.payload.resultFrom).toBe('dashboard');
    expect(other.sent.find((m) => m.payload?.source === 'room_action')!.payload.resultId).toBeUndefined();
  });

  test('requestRoomAction refuses a side-effecting action with nobody named to run it', async () => {
    const { svc, speaker, other, panel, frames } = setup();
    expect(await svc.requestRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'x' } }, 20)).toBe('rejected');
    for (const c of [speaker, other, panel]) expect(frames(c)).toEqual([]);
    // A presentation action with nobody named still goes to the panels.
    expect(await svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 20)).toBe('no_answer');
    for (const c of [speaker, other, panel]) expect(frames(c)).toEqual(['room_action:switch_tab']);
  });
});

// #973: a room action's handler makes REST calls the daemon takes as clicks,
// so no authority, taint or blocked-category check saw what a voice path sent.
// Voice is the person's authority, so an untainted realtime session acts; the
// line is taint, as on its own tool calls. The classifier has no taint to
// check and grades its own reading, so it repeats a governed action back.
describe('voice room actions are held to what their handlers do (#973)', () => {
  type Sent = { type: string; payload: Record<string, unknown> };
  const setup = (opts: { tainted?: boolean; gating?: Parameters<typeof buildTaintGating>[0] } = {}) => {
    const orchestrator = new AgentOrchestrator();
    orchestrator.setTaintGating(buildTaintGating(opts.gating));
    if (opts.tainted) {
      (orchestrator as unknown as { realtimeTaint: Set<string> }).realtimeTaint.add('browser_navigate');
      // The service reads it through the public accessor, outside any turn.
      expect([...orchestrator.getTurnTaint()]).toEqual(['browser_navigate']);
    }
    const base = makeService(orchestrator);
    base.internals.wsServer.getClients().clear();
    const mk = () => {
      const sent: Sent[] = [];
      return { sent, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); return raw.length; }, sendBinary: () => {} } };
    };
    const speaker = mk();
    const other = mk();
    for (const c of [speaker, other]) base.internals.wsServer.getClients().add(c.ws);
    const internals = base.svc as unknown as {
      executeRealtimeNavTool: (name: string, args: Record<string, unknown>, ws: unknown, opts?: { blockedCategories?: string[] }) => Promise<string | null>;
      routeClassifiedVoiceIntent: (intent: Intent, trimmed: string, requestId: string, ws: unknown) => Promise<void>;
      resolveVoiceConfirmation: (id: string, decision: 'confirm' | 'cancel') => Promise<{ ok: boolean }>;
      pendingVoiceConfirmations: Map<string, unknown>;
    };
    const real = base.svc.requestRoomAction.bind(base.svc);
    (base.svc as unknown as { requestRoomAction: typeof real }).requestRoomAction = (a, _t, o) => real(a, 20, o);
    // What the rooms would list (#1008): a held action's item is found here.
    (base.svc as unknown as { roomActionTargetLists: () => RoomActionTargetLists }).roomActionTargetLists = () => ({
      project: async () => [{ id: 'proj-demo', name: 'demo' }],
      content: async () => [{ id: 'c-1', title: 'Launch post' }],
      task: async () => [{ id: 't-1', what: 'Pay rent' }],
    });
    const frames = () => [...speaker.sent, ...other.sent]
      .filter((m) => m.payload?.source === 'room_action' || m.payload?.source === 'navigate_room')
      .map((m) => `${m.payload.source}:${String(m.payload.action ?? m.payload.key)}`);
    const realtime = (room: string, action: string, args: Record<string, unknown> = {}, blockedCategories?: string[]) =>
      internals.executeRealtimeNavTool('dashboard_room_action', { room, action, args }, speaker.ws, { blockedCategories });
    return { svc: base.svc, orchestrator, internals, speaker, other, frames, realtime };
  };

  // The actions the issue named, and the one it missed: opening a stopped
  // project starts its dev server.
  const governed = [
    ['tasks', 'create_task', { title: 'Pay rent', when: 'tomorrow' }, 'write_data'],
    ['calendar', 'schedule_event', { title: 'Call', when: 'in 5 minutes' }, 'write_data'],
    ['workspaces', 'start_server', { name: 'demo' }, 'execute_command'],
    ['workspaces', 'select_project', { name: 'demo' }, 'execute_command'],
    ['workspaces', 'create_project', { name: 'demo' }, 'install_software'],
    ['settings', 'enable_telegram', {}, 'modify_settings'],
    ['settings', 'enable_discord', {}, 'modify_settings'],
    ['settings', 'restart_daemon', {}, 'execute_command'],
    ['settings', 'replay_onboarding', {}, 'delete_data'],
    ['settings', 'set_model', { ref: 'evil:model' }, 'modify_settings'],
    ['memory', 'remember_that', { subject: 'me', predicate: 'password', object: 'x' }, 'write_data'],
    ['agents', 'spawn_agent', { specialist: 'research', task: 'x' }, 'spawn_agent'],
  ] as const;

  test('an untainted realtime session runs a high-impact action', async () => {
    for (const [room, action, args] of governed) {
      const { frames, realtime } = setup();
      const reply = await realtime(room, action, args);
      expect(reply).not.toContain('[BLOCKED]');
      expect(frames()).toEqual([`navigate_room:${room}`, `room_action:${action}`]);
    }
  });

  test('a tainted realtime session is refused it, and nothing is sent', async () => {
    for (const [room, action, args, category] of governed) {
      const { frames, realtime } = setup({ tainted: true });
      expect(await realtime(room, action, args)).toBe(
        `[BLOCKED] ${room}/${action} (${category}) was not sent: this session read outside content (browser_navigate) and voice cannot approve it. `
        + 'Tell the user what you wanted to do and ask them to say it again as a fresh request.');
      expect(frames()).toEqual([]);
    }
  });

  test('once the person speaks again the same action goes', async () => {
    const { orchestrator, frames, realtime } = setup({ tainted: true });
    expect(await realtime('tasks', 'create_task', { title: 'x' })).toContain('[BLOCKED]');
    orchestrator.resetRealtimeTaint();
    expect(await realtime('tasks', 'create_task', { title: 'x' })).not.toContain('[BLOCKED]');
    expect(frames()).toEqual(['navigate_room:tasks', 'room_action:create_task']);
  });

  test('a tainted session may still change what the screen shows', async () => {
    const { frames, realtime } = setup({ tainted: true });
    expect(await realtime('tasks', 'set_filter', { field: 'status', value: 'pending' })).not.toContain('[BLOCKED]');
    // Both dashboards get it: the speaker's frames, then the other's.
    expect(frames()).toEqual(['navigate_room:tasks', 'room_action:set_filter', 'navigate_room:tasks', 'room_action:set_filter']);
  });

  test('the owner\'s taint gating decides, as on the session\'s own tool calls', async () => {
    // Gating off, or the category not governed: the tainted session acts.
    for (const gating of [{ enabled: false }, { governed_categories: ['execute_command'] }] as const) {
      const { frames, realtime } = setup({ tainted: true, gating: gating as never });
      expect(await realtime('tasks', 'create_task', { title: 'x' })).not.toContain('[BLOCKED]');
      expect(frames()).toEqual(['navigate_room:tasks', 'room_action:create_task']);
    }
  });

  test('the realtime blocked categories apply, tainted or not', async () => {
    const { frames, realtime } = setup();
    expect(await realtime('workspaces', 'start_server', { name: 'demo' }, ['execute_command']))
      .toBe('[BLOCKED] workspaces/start_server (execute_command) is in the realtime blocked-categories list and was not sent.');
    expect(frames()).toEqual([]);
    expect(await realtime('tasks', 'create_task', { title: 'x' }, ['execute_command'])).not.toContain('[BLOCKED]');
  });

  test('under Pause or Kill nothing beyond the screen is sent', async () => {
    for (const halt of ['pause', 'kill'] as const) {
      const { orchestrator, frames, realtime } = setup();
      const emergency = new EmergencyController();
      emergency[halt]();
      orchestrator.setEmergencyController(emergency);
      const state = emergency.getState();
      expect(await realtime('tasks', 'create_task', { title: 'x' }))
        .toBe(`[SYSTEM ${state.toUpperCase()}] tasks/create_task was not sent: actions are suspended while the system is ${state}.`);
      expect(frames()).toEqual([]);
      expect(await realtime('agents', 'switch_tab', { tab: 'builder' })).not.toContain('[SYSTEM');
    }
  });

  test('the live session passes its blocked categories to the room action tool', async () => {
    const src = await Bun.file(new URL('./ws-service.ts', import.meta.url)).text();
    expect(src).toContain('this.executeRealtimeNavTool(name, args, ws, { blockedCategories: resolved.blockedCategories })');
  });

  const intent = (room: string, action: string, args: Record<string, unknown>, over: Partial<Intent> = {}): Intent => ({
    id: `i-${room}-${action}`, utterance: 'x', verb: 'show', object: null, args: {},
    impact: 'read', confidence: 0.99, room_action: { room: room as never, action, args }, ...over,
  });

  test('the classifier repeats a high-impact action back however sure it says it is, and runs nothing', async () => {
    // The card shows the action as it will run (#1008): the handler's
    // defaults filled in, and the project found and pinned by id. It used to
    // show only what the classifier wrote, so "replay onboarding" hid the
    // scope "all" that clears the profile.
    const shown: Record<string, Record<string, unknown>> = {
      'workspaces/start_server': { name: 'demo', id: 'proj-demo' },
      'workspaces/select_project': { name: 'demo', id: 'proj-demo' },
      'workspaces/create_project': { name: 'demo', template: 'vite-react' },
      'settings/replay_onboarding': { scope: 'all' },
    };
    for (const [room, action, args] of governed) {
      const { internals, speaker, other, frames } = setup();
      await internals.routeClassifiedVoiceIntent(intent(room, action, args), 'do it', 'req', speaker.ws);
      expect(frames()).toEqual([]);
      const card = other.sent.find((m) => m.payload?.source === 'repeat_back_request');
      const runs = { room, action, args: shown[`${room}/${action}`] ?? args };
      expect(card?.payload).toMatchObject({ id: `i-${room}-${action}`, transcript: 'do it', action: describeRoomAction(runs) });
      expect(internals.pendingVoiceConfirmations.size).toBe(1);
    }
    expect(describeRoomAction({ room: 'settings', action: 'replay_onboarding', args: { scope: 'all' } }))
      .toBe('Settings: replay onboarding {"scope": "all"} (deletes data; changes settings)');
  });

  test('confirming runs what the card showed, whatever the selection or the list did meanwhile (#1008)', async () => {
    const { svc, internals, speaker, other } = setup();
    await internals.routeClassifiedVoiceIntent(intent('workspaces', 'stop_server', { name: 'dem' }), 'stop demo', 'req', speaker.ws);
    expect(other.sent.find((m) => m.payload?.source === 'repeat_back_request')!.payload.action)
      .toBe('Workspaces: stop server {"name": "demo"} (runs a command on this machine)');
    // A project created in between that "dem" would now match first changes nothing.
    (svc as unknown as { roomActionTargetLists: () => RoomActionTargetLists }).roomActionTargetLists = () => ({
      project: async () => [{ id: 'proj-dem', name: 'dem' }, { id: 'proj-demo', name: 'demo' }],
      content: async () => [], task: async () => [],
    });
    expect(await internals.resolveVoiceConfirmation('i-workspaces-stop_server', 'confirm')).toEqual({ ok: true });
    const sent = speaker.sent.find((m) => m.payload?.source === 'room_action')!;
    expect(sent.payload).toMatchObject({ room: 'workspaces', action: 'stop_server', args: { name: 'demo', id: 'proj-demo' } });
  });

  test('a held action that would act on the selection, or on nothing, is not held: the person is asked to name it (#1008)', async () => {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ['workspaces', 'start_server', {}, 'I haven\'t done "Workspaces: start server": say which project by name, and I\'ll show you which one before I do it.'],
      ['content', 'advance', {}, 'I haven\'t done "Content: advance": say which content item by name, and I\'ll show you which one before I do it.'],
      ['tasks', 'complete_task', { name: 'zebra' }, 'I haven\'t done "Tasks: complete task": I couldn\'t find a task called "zebra".'],
    ];
    for (const [room, action, args, said] of cases) {
      const { internals, speaker, other, frames } = setup();
      await internals.routeClassifiedVoiceIntent(intent(room, action, args), 'do it', 'req', speaker.ws);
      expect(frames()).toEqual([]);
      expect(other.sent.some((m) => m.payload?.source === 'repeat_back_request')).toBe(false);
      expect(internals.pendingVoiceConfirmations.size).toBe(0);
      expect(other.sent.filter((m) => m.payload?.source === 'assistant_message').map((m) => m.payload.text)).toEqual([said]);
    }
  });

  test('the lists a held action is settled against are the ones the rooms load (#1008)', async () => {
    initDatabase(':memory:', { quiet: true });
    try {
      createCommitment('Pay rent');
      createContent('Launch post');
      const svc = makeService().svc as unknown as { roomActionTargetLists: () => RoomActionTargetLists };
      const lists = svc.roomActionTargetLists();
      expect((await lists.task()).map((t) => t.what)).toEqual(['Pay rent']);
      expect((await lists.content()).map((c) => c.title)).toEqual(['Launch post']);
      // No site builder, no projects: the hold is refused, not guessed.
      await expect(lists.project()).rejects.toThrow('site builder not available');
    } finally {
      closeDb();
    }
  });

  test('a side-effecting action held at low confidence is settled the same way (#1008)', async () => {
    // Narrowed governed categories: create_project is held only by the
    // confidence route, not the governed one.
    const { internals, speaker, other } = setup({ gating: { governed_categories: ['send_message'] } as never });
    await internals.routeClassifiedVoiceIntent(intent('workspaces', 'create_project', { name: 'site' }, { confidence: 0.7 }), 'x', 'req', speaker.ws);
    expect(other.sent.find((m) => m.payload?.source === 'repeat_back_request')!.payload.action)
      .toBe('Workspaces: create project {"name": "site", "template": "vite-react"} (installs software; runs a command on this machine)');
  });

  test('confirming the repeat-back runs the held action on the dashboard that spoke', async () => {
    const { internals, speaker, other, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('tasks', 'create_task', { title: 'Pay rent' }), 'add pay rent', 'req', speaker.ws);
    expect(await internals.resolveVoiceConfirmation('i-tasks-create_task', 'confirm')).toEqual({ ok: true });
    expect(frames()).toEqual(['navigate_room:tasks', 'room_action:create_task']);
    expect(speaker.sent.find((m) => m.payload?.source === 'room_action')!.payload.args).toEqual({ title: 'Pay rent' });
    // Not handed to chat as a transcript: the acknowledgement is the room's.
    const acks = other.sent.filter((m) => m.payload?.source === 'assistant_message').map((m) => m.payload.text);
    expect(acks).toEqual(["I sent that to Tasks, but it didn't answer, so I can't tell whether it happened."]);
  });

  test('cancelling it runs nothing', async () => {
    const { internals, speaker, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('tasks', 'create_task', { title: 'x' }), 'x', 'req', speaker.ws);
    expect(await internals.resolveVoiceConfirmation('i-tasks-create_task', 'cancel')).toEqual({ ok: true });
    expect(frames()).toEqual([]);
  });

  test('the classifier still acts at once on a presentation action', async () => {
    const { internals, speaker, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('tasks', 'set_filter', { field: 'status', value: 'pending' }), 'x', 'req', speaker.ws);
    expect(frames().filter((f) => f === 'room_action:set_filter').length).toBe(2);
    expect(internals.pendingVoiceConfirmations.size).toBe(0);
  });

  const yes = (over: Partial<Intent> = {}): Intent => ({
    id: `yes-${Math.random()}`, utterance: 'yes', verb: 'ask', object: null, args: {}, impact: 'read',
    confidence: 0.6, confirmation_response: 'approve', ...over,
  });
  const acksOf = (c: { sent: Sent[] }) => c.sent.filter((m) => m.payload?.source === 'assistant_message').map((m) => String(m.payload.text));

  test('a plain spoken yes on the same dashboard runs the held action, with only the room\'s answer', async () => {
    const { internals, speaker, other, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('tasks', 'create_task', { title: 'Pay rent' }), 'add pay rent', 'req', speaker.ws);
    await internals.routeClassifiedVoiceIntent(yes(), 'Yes.', 'req2', speaker.ws);
    expect(frames()).toEqual(['navigate_room:tasks', 'room_action:create_task']);
    expect(acksOf(other)).toEqual(["I sent that to Tasks, but it didn't answer, so I can't tell whether it happened."]);
  });

  test('a yes the classifier inferred, from elsewhere, late, or among several holds runs nothing', async () => {
    const cases: Array<[string, (t: ReturnType<typeof setup>) => Promise<void>, RegExp]> = [
      ['inferred', async ({ internals, speaker }) => {
        await internals.routeClassifiedVoiceIntent(yes(), 'that sounds about right I guess', 'r', speaker.ws);
      }, /say "yes" on its own or click its card/],
      ['other dashboard', async ({ internals, other }) => {
        await internals.routeClassifiedVoiceIntent(yes(), 'yes', 'r', other.ws);
      }, /waiting on another dashboard/],
      ['late', async ({ internals, speaker }) => {
        for (const p of internals.pendingVoiceConfirmations.values()) (p as { createdAt: number }).createdAt -= 61_000;
        await internals.routeClassifiedVoiceIntent(yes(), 'yes', 'r', speaker.ws);
      }, /waiting too long/],
      ['several', async ({ internals, speaker }) => {
        await internals.routeClassifiedVoiceIntent(intent('settings', 'restart_daemon', {}), 'restart', 'r0', speaker.ws);
        await internals.routeClassifiedVoiceIntent(yes(), 'yes', 'r', speaker.ws);
      }, /2 actions are waiting/],
    ];
    for (const [name, act, said] of cases) {
      const t = setup();
      await t.internals.routeClassifiedVoiceIntent(intent('tasks', 'create_task', { title: 'x' }), 'x', 'req', t.speaker.ws);
      await act(t);
      expect([name, t.frames()]).toEqual([name, []]);
      expect(acksOf(t.other).at(-1)).toMatch(said);
      expect(t.internals.pendingVoiceConfirmations.size).toBeGreaterThan(0);
    }
  });

  test('a clarified presentation action runs on any yes, and does not count as a held action', async () => {
    const { internals, speaker, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('tasks', 'set_filter', { field: 'status', value: 'done' }, { confidence: 0.3 }), 'x', 'req', speaker.ws);
    await internals.routeClassifiedVoiceIntent(yes(), 'that one I think', 'r', speaker.ws);
    expect(frames().filter((f) => f === 'room_action:set_filter').length).toBe(2);
  });

  test('a spoken no cancels a held action', async () => {
    const { internals, speaker, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('tasks', 'create_task', { title: 'x' }), 'x', 'req', speaker.ws);
    await internals.routeClassifiedVoiceIntent(yes({ confirmation_response: 'cancel' }), 'no', 'r', speaker.ws);
    expect(frames()).toEqual([]);
    expect(internals.pendingVoiceConfirmations.size).toBe(0);
  });

  test('a hold confirmed after Kill does not run', async () => {
    const { orchestrator, internals, speaker, other, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('tasks', 'create_task', { title: 'x' }), 'x', 'req', speaker.ws);
    const emergency = new EmergencyController();
    emergency.kill();
    orchestrator.setEmergencyController(emergency);
    expect(await internals.resolveVoiceConfirmation('i-tasks-create_task', 'confirm')).toEqual({ ok: true });
    expect(frames()).toEqual([]);
    expect(acksOf(other)).toEqual([`I didn't do that: actions are suspended while the system is ${emergency.getState()}. Ask again once it is resumed.`]);
  });

  test('a side-effecting action the classifier was unsure of is repeated back with what it runs, and confirming runs it', async () => {
    const { internals, speaker, other, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('settings', 'test_provider', { provider: 'openai' }, { confidence: 0.7 }), 'x', 'req', speaker.ws);
    expect(other.sent.some((m) => m.payload?.source === 'clarifier_request')).toBe(false);
    expect(other.sent.find((m) => m.payload?.source === 'repeat_back_request')?.payload.action)
      .toBe(describeRoomAction({ room: 'settings', action: 'test_provider', args: { provider: 'openai' } }));
    expect(await internals.resolveVoiceConfirmation('i-settings-test_provider', 'confirm')).toEqual({ ok: true });
    expect(frames()).toEqual(['navigate_room:settings', 'room_action:test_provider']);
  });

  test('a side-effecting action outside the governed categories needs the confidence of a write', async () => {
    // test_provider reads; the classifier called it "read" at 0.7, which
    // used to act. Its impact comes from the table now, so it clarifies.
    const { internals, speaker, other, frames } = setup();
    await internals.routeClassifiedVoiceIntent(intent('settings', 'test_provider', { provider: 'openai' }, { confidence: 0.7 }), 'x', 'req', speaker.ws);
    expect(frames()).toEqual([]);
    // Held for confirmation, on the card that shows the action.
    expect(other.sent.some((m) => m.payload?.source === 'repeat_back_request')).toBe(true);
  });
});

describe('describeRoomAction shows every argument the classifier filled in (#973)', () => {
  test('room, action, arguments in full and quoted, and what it can do', () => {
    expect(describeRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'Pay rent', when: 'tomorrow' } }))
      .toBe('Tasks: create task {"title": "Pay rent", "when": "tomorrow"} (saves data)');
    expect(describeRoomAction({ room: 'settings', action: 'restart_daemon' })).toBe('Settings: restart daemon (runs a command on this machine)');
    expect(describeRoomAction({ room: 'tasks', action: 'set_filter', args: { field: 'status' } })).toBe('Tasks: set filter {"field": "status"}');
    const long = 'y'.repeat(200);
    expect(describeRoomAction({ room: 'memory', action: 'remember_that', args: { object: long } })).toContain(long);
  });

  test('a value cannot pass for another argument', () => {
    const shown = describeRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'Pay rent", "when": "never' } });
    expect(shown).toBe('Tasks: create task {"title": "Pay rent\\", \\"when\\": \\"never"} (saves data)');
  });

  test('a bidi override or invisible character is shown, not obeyed (#1008)', () => {
    // Built from code points so this file holds none of them itself.
    const [rlo, zwsp, lsep] = [0x202e, 0x200b, 0x2028].map((c) => String.fromCodePoint(c));
    const shown = describeRoomAction({ room: 'tasks', action: 'create_task', args: { title: `Pay ${rlo}rent${zwsp}`, [`x${lsep}`]: 1 } });
    expect(shown).toBe('Tasks: create task {"title": "Pay \\u202erent\\u200b", "x\\u2028": 1} (saves data)');
    expect([...shown].filter((ch) => [0x202e, 0x200b, 0x2028].includes(ch.codePointAt(0)!))).toEqual([]);
  });

  test('a pinned item is shown by its name, without the id it is pinned by (#1008)', () => {
    expect(describeRoomAction({ room: 'tasks', action: 'complete_task', args: { name: 'Pay rent', id: 't-1' } }))
      .toBe('Tasks: complete task {"name": "Pay rent"} (saves data)');
    // An action that pins nothing shows every argument.
    expect(describeRoomAction({ room: 'tasks', action: 'create_task', args: { title: 'x', id: 'y' } }))
      .toBe('Tasks: create task {"title": "x", "id": "y"} (saves data)');
  });
});

describe('isVoiceAffirmative reads a plain yes from the transcript (#973)', () => {
  test('yes in its plain forms, with or without the wake word', () => {
    for (const t of ['yes', 'Yes.', 'yeah', 'yep!', 'yes please', 'yes, go ahead', 'Do it.', 'go ahead', 'confirm', 'Jarvis, yes', 'hey jarvis yes do it']) {
      expect([t, isVoiceAffirmative(t)]).toEqual([t, true]);
    }
  });

  test('anything else is not a yes', () => {
    for (const t of ['', 'yes but wait', 'not yet', 'yesterday', 'no', 'sure', 'ok', 'that sounds right', 'yes delete everything', 'jarvis']) {
      expect([t, isVoiceAffirmative(t)]).toEqual([t, false]);
    }
  });
});

// #1011: a clarifier or repeat-back request goes to every dashboard, but a
// hold swept when its dashboard closed, or dropped by the TTL sweep, was only
// ever reported to the socket that spoke, in a message no dashboard handled.
// The card stayed live-looking everywhere, and a click on it got a 404.
describe('a voice confirmation that ends is taken down where it was shown (#1011)', () => {
  type Sent = { type: string; payload: Record<string, unknown> };
  const setup = () => {
    const base = makeService();
    base.internals.wsServer.getClients().clear();
    const mk = () => {
      const sent: Sent[] = [];
      return { sent, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); return raw.length; }, sendBinary: () => {} } };
    };
    const speaker = mk();
    const other = mk();
    const panel = mk();
    for (const c of [speaker, other, panel]) base.internals.wsServer.getClients().add(c.ws);
    const internals = base.svc as unknown as {
      routeClassifiedVoiceIntent: (intent: Intent, trimmed: string, requestId: string, ws: unknown) => Promise<void>;
      handleClientDisconnect: (ws: unknown) => void;
      sweepVoiceConfirmations: (now: number) => void;
      pendingVoiceConfirmations: Map<string, { createdAt: number }>;
      wsServer: { getClients: () => Set<unknown> };
    };
    const held = (id: string, ws: unknown, over: Partial<Intent> = {}) => internals.routeClassifiedVoiceIntent({
      id, utterance: 'x', verb: 'show', object: null, args: {}, impact: 'read', confidence: 0.99,
      room_action: { room: 'tasks' as never, action: 'create_task', args: { title: id } }, ...over,
    }, 'add it', 'req', ws);
    const gone = (c: { sent: Sent[] }) => c.sent
      .filter((m) => m.type === 'notification' && m.payload?.source === 'voice_confirmation_expired')
      .map((m) => `${String(m.payload.id)}:${String(m.payload.reason)}`);
    const requested = (c: { sent: Sent[] }) => c.sent
      .filter((m) => m.payload?.source === 'repeat_back_request' || m.payload?.source === 'clarifier_request')
      .map((m) => String(m.payload.id));
    return { internals, speaker, other, panel, held, gone, requested };
  };

  test('closing the dashboard a hold is for takes its card down on every other one', async () => {
    const { internals, speaker, other, panel, held, gone, requested } = setup();
    await held('mine', speaker.ws);
    await held('theirs', other.ws);
    // Not vacuous: everyone was shown both.
    for (const c of [speaker, other, panel]) expect(requested(c)).toEqual(['mine', 'theirs']);
    internals.wsServer.getClients().delete(speaker.ws);
    internals.handleClientDisconnect(speaker.ws);
    for (const c of [other, panel]) expect(gone(c)).toEqual(['mine:disconnected']);
    expect([...internals.pendingVoiceConfirmations.keys()]).toEqual(['theirs']);
  });

  test('a clarifier is taken down the same way', async () => {
    const { internals, speaker, other, held, gone, requested } = setup();
    await held('vague', speaker.ws, { room_action: undefined, verb: 'ask', impact: 'write', confidence: 0.7 });
    expect(requested(other)).toEqual(['vague']);
    expect(other.sent.find((m) => m.payload?.source === 'clarifier_request')).toBeDefined();
    internals.wsServer.getClients().delete(speaker.ws);
    internals.handleClientDisconnect(speaker.ws);
    expect(gone(other)).toEqual(['vague:disconnected']);
  });

  test('a card that times out is taken down on every dashboard, not just the one that spoke', async () => {
    const { internals, speaker, other, panel, held, gone } = setup();
    await held('old', speaker.ws);
    await held('fresh', speaker.ws);
    internals.pendingVoiceConfirmations.get('old')!.createdAt -= 10 * 60_000 + 1;
    internals.sweepVoiceConfirmations(Date.now());
    for (const c of [speaker, other, panel]) expect(gone(c)).toEqual(['old:expired']);
    expect([...internals.pendingVoiceConfirmations.keys()]).toEqual(['fresh']);
    // Nothing goes out as the old top-level type no dashboard handled.
    expect(speaker.sent.some((m) => m.type === 'voice_confirmation_expired')).toBe(false);
  });

  test('a dashboard back from a dropped socket can ask which cards are still live', async () => {
    const { internals, speaker, other, held } = setup();
    await held('mine', speaker.ws);
    await held('theirs', other.ws);
    internals.wsServer.getClients().delete(speaker.ws);
    internals.handleClientDisconnect(speaker.ws);
    const route = createApiRoutes({ wsService: internals } as unknown as ApiContext)['/api/voice/confirmations'] as { GET: () => Response };
    const before = Date.now();
    const body = await route.GET().json() as { ids: string[]; at: number };
    expect(body.ids).toEqual(['theirs']);
    expect(body.at).toBeGreaterThanOrEqual(before);
  });

  test('nothing is said about a dashboard that held nothing', async () => {
    const { internals, speaker, other, held, gone } = setup();
    await held('theirs', other.ws);
    internals.wsServer.getClients().delete(speaker.ws);
    internals.handleClientDisconnect(speaker.ws);
    expect(gone(other)).toEqual([]);
    internals.sweepVoiceConfirmations(Date.now());
    expect(gone(other)).toEqual([]);
  });
});
