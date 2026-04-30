import { describe, expect, test } from 'bun:test';
import {
  cleanupPerSocketMaps,
  sweepExpiredVoiceConfirmations,
} from './ws-service.ts';

// We use `unknown` as the socket placeholder type and `Symbol`-tagged
// objects as fake sockets so identity equality (===) matches what the
// real ServerWebSocket comparison does in cleanupPerSocketMaps.
const makeFakeSocket = (label: string) => Object.freeze({ __socket: label });

describe('cleanupPerSocketMaps', () => {
  test('removes the disconnecting socket from voiceSessions and interviewSessions, and sweeps pendingVoiceConfirmations entries that reference it', () => {
    const ws1 = makeFakeSocket('ws1');
    const ws2 = makeFakeSocket('ws2');

    const voiceSessions = new Map<typeof ws1 | typeof ws2, unknown>([
      [ws1, { sessionId: 'v1' }],
      [ws2, { sessionId: 'v2' }],
    ]);
    const interviewSessions = new Map<typeof ws1 | typeof ws2, unknown>([
      [ws1, { turn: 3 }],
    ]);
    const pendingVoiceConfirmations = new Map<string, { ws: typeof ws1 | typeof ws2 }>([
      ['p1', { ws: ws1 }],
      ['p2', { ws: ws1 }],
      ['p3', { ws: ws2 }],
    ]);

    const result = cleanupPerSocketMaps(
      ws1,
      voiceSessions,
      interviewSessions,
      pendingVoiceConfirmations,
    );

    expect(result.voiceRemoved).toBe(true);
    expect(result.interviewRemoved).toBe(true);
    expect(result.pendingRemoved).toBe(2);

    // ws1 entries are gone, ws2 entries are intact (other clients
    // disconnecting must NOT take down unrelated sessions).
    expect(voiceSessions.has(ws1)).toBe(false);
    expect(voiceSessions.has(ws2)).toBe(true);
    expect(interviewSessions.has(ws1)).toBe(false);
    expect(pendingVoiceConfirmations.has('p1')).toBe(false);
    expect(pendingVoiceConfirmations.has('p2')).toBe(false);
    expect(pendingVoiceConfirmations.has('p3')).toBe(true);
  });

  test('disconnecting a socket that was never tracked is a complete no-op (no throw, no false-positive deletes)', () => {
    const ghostSocket = makeFakeSocket('ghost');
    const trackedSocket = makeFakeSocket('tracked');

    const voiceSessions = new Map<typeof trackedSocket, unknown>([[trackedSocket, {}]]);
    const interviewSessions = new Map<typeof trackedSocket, unknown>([[trackedSocket, {}]]);
    const pendingVoiceConfirmations = new Map<string, { ws: typeof trackedSocket }>([
      ['p1', { ws: trackedSocket }],
    ]);

    const result = cleanupPerSocketMaps(
      ghostSocket as unknown as typeof trackedSocket,
      voiceSessions,
      interviewSessions,
      pendingVoiceConfirmations,
    );

    expect(result.voiceRemoved).toBe(false);
    expect(result.interviewRemoved).toBe(false);
    expect(result.pendingRemoved).toBe(0);

    // The tracked socket's entries are untouched.
    expect(voiceSessions.size).toBe(1);
    expect(interviewSessions.size).toBe(1);
    expect(pendingVoiceConfirmations.size).toBe(1);
  });

  test('a socket present in only one of the three maps still cleans up just that one (no all-or-nothing semantics)', () => {
    const ws = makeFakeSocket('partial');
    const voiceSessions = new Map<typeof ws, unknown>();
    const interviewSessions = new Map<typeof ws, unknown>([[ws, {}]]);
    const pendingVoiceConfirmations = new Map<string, { ws: typeof ws }>();

    const result = cleanupPerSocketMaps(ws, voiceSessions, interviewSessions, pendingVoiceConfirmations);

    expect(result.voiceRemoved).toBe(false);
    expect(result.interviewRemoved).toBe(true);
    expect(result.pendingRemoved).toBe(0);
    expect(interviewSessions.size).toBe(0);
  });
});

describe('sweepExpiredVoiceConfirmations', () => {
  const ws = makeFakeSocket('ws');

  test('removes only entries strictly older than the TTL', () => {
    const now = 10_000;
    const ttl = 1_000;
    // boundary cases: createdAt = 9_000 means age = 1000 = TTL, NOT expired.
    // createdAt = 8_999 means age = 1001 > TTL, expired.
    const pending = new Map<string, { ws: typeof ws; createdAt: number }>([
      ['fresh', { ws, createdAt: 9_500 }],     // age 500 — keep
      ['boundary', { ws, createdAt: 9_000 }],  // age 1000 — keep (NOT strictly older)
      ['old', { ws, createdAt: 8_999 }],       // age 1001 — drop
      ['ancient', { ws, createdAt: 0 }],       // age 10000 — drop
    ]);

    const expired = sweepExpiredVoiceConfirmations(pending, now, ttl);

    expect(expired.map((e) => e.id).sort()).toEqual(['ancient', 'old']);
    expect(pending.has('fresh')).toBe(true);
    expect(pending.has('boundary')).toBe(true);
    expect(pending.has('old')).toBe(false);
    expect(pending.has('ancient')).toBe(false);
  });

  test('returns the originating ws alongside each expired id so the caller can notify the client', () => {
    const wsA = makeFakeSocket('A');
    const wsB = makeFakeSocket('B');
    const pending = new Map<string, { ws: typeof wsA | typeof wsB; createdAt: number }>([
      ['idA', { ws: wsA, createdAt: 0 }],
      ['idB', { ws: wsB, createdAt: 0 }],
    ]);

    const expired = sweepExpiredVoiceConfirmations(pending, 10_000, 1_000);

    expect(expired).toHaveLength(2);
    const byId = new Map(expired.map((e) => [e.id, e.ws]));
    expect(byId.get('idA')).toBe(wsA);
    expect(byId.get('idB')).toBe(wsB);
  });

  test('an empty map sweeps cleanly (no throw, empty result)', () => {
    const empty = new Map<string, { ws: typeof ws; createdAt: number }>();
    expect(sweepExpiredVoiceConfirmations(empty, Date.now(), 1_000)).toEqual([]);
  });

  test('a TTL of 0 expires literally everything (degenerate but well-defined)', () => {
    const pending = new Map<string, { ws: typeof ws; createdAt: number }>([
      ['x', { ws, createdAt: 999 }],
      ['y', { ws, createdAt: 1000 }],  // age 0 — but TTL is 0, age > 0 fails so it's KEPT (not strictly older)
    ]);
    // With now=1000, ttl=0: x has age 1 > 0 → expired. y has age 0 not > 0 → kept.
    const expired = sweepExpiredVoiceConfirmations(pending, 1_000, 0);
    expect(expired.map((e) => e.id)).toEqual(['x']);
    expect(pending.has('y')).toBe(true);
  });

  test('does not allocate a notify list when nothing is expired (cheap fast path)', () => {
    const pending = new Map<string, { ws: typeof ws; createdAt: number }>([
      ['fresh', { ws, createdAt: Date.now() }],
    ]);
    const expired = sweepExpiredVoiceConfirmations(pending, Date.now(), 10_000);
    expect(expired).toEqual([]);
    expect(pending.size).toBe(1);
  });
});
