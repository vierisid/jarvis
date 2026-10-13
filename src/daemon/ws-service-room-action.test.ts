/**
 * The daemon's half of a room action that reports back (#933): the action is
 * broadcast with a resultId, and a panel's `room_action_result` on the
 * dashboard socket decides what the pebble says. The service is constructed
 * but never start()ed; broadcast() reaches the fake client registered here.
 */

import { describe, expect, test } from 'bun:test';
import { roomActionReply, WebSocketService } from './ws-service.ts';
import { TOOL_RESULT_GRACE_MS } from '../comms/realtime.ts';
import type { JarvisConfig } from '../config/types.ts';

const makeService = () => {
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => ({ llm: { providers: {} } }) as unknown as JarvisConfig,
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
    expect(await svc.requestRoomAction({ room: 'workflows', action: 'switch_tab', args: { tab: 'editor' } }, 10))
      .toBe('no_answer');
  });

  test('with no client connected it says so at once, not after the timeout', async () => {
    const { svc, internals } = makeService();
    internals.wsServer.getClients().clear();
    const t0 = Date.now();
    expect(await svc.requestRoomAction({ room: 'settings', action: 'switch_tab', args: { tab: 'voice' } }, 60_000))
      .toBe('no_answer');
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
    const pending = svc.requestRoomAction({ room: 'settings', action: 'enable_tts' }, 200, { client: speaker.ws as never });
    const mine = actionTo(speaker)!;
    const theirs = actionTo(other)!;
    // Everyone still receives the action; only the speaker is asked.
    expect(mine.payload).toMatchObject({ room: 'settings', action: 'enable_tts', resultFrom: 'dashboard' });
    expect(typeof mine.payload.resultId).toBe('string');
    expect(theirs.payload).toMatchObject({ room: 'settings', action: 'enable_tts' });
    expect(theirs.payload.resultId).toBeUndefined();
    // Another client that learned the id does not settle it.
    await answer(other, mine.payload.resultId, false);
    await answer(speaker, mine.payload.resultId, true);
    expect(await pending).toBe('accepted');
  });

  test('a dashboard that is gone gets no_answer at once', async () => {
    const { svc } = setup();
    const gone = client();
    const t0 = Date.now();
    expect(await svc.requestRoomAction({ room: 'settings', action: 'enable_tts' }, 60_000, { client: gone.ws as never }))
      .toBe('no_answer');
    expect(Date.now() - t0).toBeLessThan(1000);
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
    await internals.handleVoiceRoomAction({ room: 'workflows', action: 'run', args: { name: 'morning brief' } }, 'req-2', speaker.ws);
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
    // Wired to the socket's disconnect.
    const src = await Bun.file(new URL('./ws-service.ts', import.meta.url)).text();
    const hook = src.slice(src.indexOf('onDisconnect: (ws) => {'), src.indexOf('onDisconnect: (ws) => {') + 400);
    expect(hook).toContain('this.roomActionResults.abandonAnswerer(ws);');
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
