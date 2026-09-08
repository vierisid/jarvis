import { describe, expect, test } from 'bun:test';
import {
  PanelSessionStore,
  PANEL_SESSION_MAX_AGE_MS,
  PANEL_SESSION_CLOSED_CODE,
  type PanelSession,
  type PanelSessionSink,
} from './panel-sessions.ts';

/**
 * The store exists because the panel's auth used to expire at 10 minutes with
 * no way to renew. So the cases that matter are the two ends of that: a
 * session must survive ordinary use indefinitely, and it must still have a
 * hard end -- the cap is the only thing left bounding a leaked cookie once
 * the JWT's TTL is gone.
 */
describe('PanelSessionStore', () => {
  const at = (start = 0) => {
    let clock = start;
    return {
      now: () => clock,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };

  test('ids are opaque and unique', () => {
    const store = new PanelSessionStore();
    const a = store.create('sid-1');
    const b = store.create('sid-1');
    expect(a.id).not.toBe(b.id);
    // No claims, no structure to parse: base64url of 32 bytes.
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toContain('.');
  });

  test('survives well past the old 10-minute TTL', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now });
    const session = store.create('sid-1');

    clock.advance(10 * 60 * 1000);
    expect(store.get(session.id)?.sid).toBe('sid-1');
    clock.advance(60 * 60 * 1000);
    expect(store.get(session.id)?.sid).toBe('sid-1');
  });

  test('use does not extend it: the cap is absolute', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, maxAgeMs: 1000 });
    const session = store.create('sid-1');

    // Busy right up to the deadline.
    for (let i = 0; i < 9; i++) {
      clock.advance(100);
      expect(store.get(session.id)).not.toBeNull();
    }
    clock.advance(100);
    expect(store.get(session.id)).toBeNull();
  });

  test('an aged-out session is refused on the request that notices, not at the next sweep', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, maxAgeMs: 1000 });
    const session = store.create('sid-1');
    clock.advance(1000);

    expect(store.get(session.id)).toBeNull();
    // ...and dropped on the way past, so an abandoned panel does not leak an entry.
    expect(store.size).toBe(0);
  });

  test('lastSeenAt tracks use, createdAt does not move', () => {
    const clock = at(5_000);
    const store = new PanelSessionStore({ now: clock.now });
    const session = store.create('sid-1');
    expect(session.createdAt).toBe(5_000);

    clock.advance(2_000);
    const seen = store.get(session.id);
    expect(seen?.createdAt).toBe(5_000);
    expect(seen?.lastSeenAt).toBe(7_000);
  });

  test('an unknown id resolves to nothing', () => {
    const store = new PanelSessionStore();
    expect(store.get('not-a-session')).toBeNull();
    expect(store.get('')).toBeNull();
  });

  test('deleteBySid closes every panel of one device and leaves the others', () => {
    const store = new PanelSessionStore();
    const a1 = store.create('sid-a');
    const a2 = store.create('sid-a');
    const b1 = store.create('sid-b');

    expect(store.deleteBySid('sid-a')).toBe(2);
    expect(store.get(a1.id)).toBeNull();
    expect(store.get(a2.id)).toBeNull();
    expect(store.get(b1.id)?.sid).toBe('sid-b');
  });

  test('deleteBySid on a device with no panels is a no-op', () => {
    const store = new PanelSessionStore();
    store.create('sid-a');
    expect(store.deleteBySid('sid-b')).toBe(0);
    expect(store.size).toBe(1);
  });

  test('delete closes exactly one session', () => {
    const store = new PanelSessionStore();
    const a = store.create('sid-1');
    const b = store.create('sid-1');

    expect(store.delete(a.id)).toBe(true);
    expect(store.delete(a.id)).toBe(false);
    expect(store.get(b.id)).not.toBeNull();
  });

  test('sweep drops only what is past the cap', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, maxAgeMs: 1000 });
    const old = store.create('sid-1');
    clock.advance(600);
    const fresh = store.create('sid-1');
    clock.advance(400);

    expect(store.sweep()).toBe(1);
    expect(store.get(old.id)).toBeNull();
    expect(store.get(fresh.id)).not.toBeNull();
  });

  test('the default cap is the documented 12 hours', () => {
    expect(PANEL_SESSION_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now });
    const session = store.create('sid-1');
    clock.advance(PANEL_SESSION_MAX_AGE_MS - 1);
    expect(store.get(session.id)).not.toBeNull();
    clock.advance(1);
    expect(store.get(session.id)).toBeNull();
  });
});

/**
 * Persistence exists for one reason: the brain is restarted routinely (every
 * hosted update runs `systemctl restart` on the instance unit), and a session
 * that did not survive that would strand open panels on a permanent 401 -- the
 * same failure the sessions were introduced to remove, from a different cause.
 */
describe('PanelSessionStore persistence', () => {
  const fakeSink = () => {
    const rows = new Map<string, PanelSession>();
    return {
      rows,
      sink: {
        insert: (s: PanelSession) => {
          rows.set(s.id, { ...s });
        },
        remove: (ids: readonly string[]) => {
          for (const id of ids) rows.delete(id);
        },
        load: () => [...rows.values()],
      } satisfies PanelSessionSink,
    };
  };

  test('a session opened before a restart still authorizes after one', () => {
    const { sink } = fakeSink();
    const before = new PanelSessionStore({ sink });
    const session = before.create('sid-1');

    // A new process, same disk.
    const after = new PanelSessionStore({ sink });
    expect(after.hydrate()).toBe(1);
    expect(after.get(session.id)?.sid).toBe('sid-1');
  });

  test('hydrate drops what aged out while the brain was down, and forgets it', () => {
    const clock = { t: 0 };
    const { rows, sink } = fakeSink();
    const before = new PanelSessionStore({ sink, now: () => clock.t, maxAgeMs: 1000 });
    const stale = before.create('sid-1');
    clock.t += 600;
    const live = before.create('sid-1');

    clock.t += 400; // stale is exactly at the cap, live is not
    const after = new PanelSessionStore({ sink, now: () => clock.t, maxAgeMs: 1000 });
    expect(after.hydrate()).toBe(1);
    expect(after.get(stale.id)).toBeNull();
    expect(after.get(live.id)).not.toBeNull();
    expect(rows.has(stale.id)).toBe(false);
  });

  test('every close is written through, so nothing resurrects on the next start', () => {
    const { rows, sink } = fakeSink();
    const store = new PanelSessionStore({ sink });
    const a = store.create('sid-a');
    const b = store.create('sid-a');
    const c = store.create('sid-b');
    expect(rows.size).toBe(3);

    store.delete(a.id);
    expect(rows.has(a.id)).toBe(false);

    store.deleteBySid('sid-a');
    expect(rows.has(b.id)).toBe(false);
    expect(rows.has(c.id)).toBe(true);

    const revived = new PanelSessionStore({ sink });
    revived.hydrate();
    expect(revived.size).toBe(1);
  });

  test('an aged-out session is forgotten by the sweep and by the request that finds it', () => {
    const clock = { t: 0 };
    const { rows, sink } = fakeSink();
    const store = new PanelSessionStore({ sink, now: () => clock.t, maxAgeMs: 1000 });
    const viaGet = store.create('sid-1');
    const viaSweep = store.create('sid-1');
    clock.t += 1000;

    expect(store.get(viaGet.id)).toBeNull();
    expect(rows.has(viaGet.id)).toBe(false);
    expect(store.sweep()).toBe(1);
    expect(rows.has(viaSweep.id)).toBe(false);
  });

  test('a failing disk never takes out a live session', () => {
    const angry: PanelSessionSink = {
      insert: () => {
        throw new Error('disk full');
      },
      remove: () => {
        throw new Error('disk full');
      },
      load: () => {
        throw new Error('disk gone');
      },
    };
    const store = new PanelSessionStore({ sink: angry });

    // Hydration failure is an empty store, not a brain that will not boot.
    expect(store.hydrate()).toBe(0);

    // And a session that cannot be persisted is still a working session: the
    // user keeps their panel, they just lose it across the next restart.
    const session = store.create('sid-1');
    expect(store.get(session.id)?.sid).toBe('sid-1');
    expect(store.delete(session.id)).toBe(true);
  });

  test('with no sink at all it is a plain in-memory store', () => {
    const store = new PanelSessionStore();
    const session = store.create('sid-1');
    expect(store.hydrate()).toBe(0);
    expect(store.get(session.id)).not.toBeNull();
  });
});

/**
 * How a CLOSED panel's session gets cleaned up. Not by panel id: all of a
 * sidecar's webviews share a cookie jar, so a second panel opened while the
 * first's cookie is valid never exchanges a token and rides the same session.
 * A session therefore has no single panel identity, and "close it when panel P
 * closes" would kill P's siblings. Sockets give the right semantics for free:
 * the session goes when the LAST window holding it goes.
 */
describe('PanelSessionStore liveness', () => {
  const at = (start = 0) => {
    let clock = start;
    return { now: () => clock, advance: (ms: number) => { clock += ms; } };
  };

  /** A socket that records being hung up on. */
  const sock = () => {
    const closed: Array<{ code?: number; reason?: string }> = [];
    return { closed, close: (code?: number, reason?: string) => closed.push({ code, reason }) };
  };

  test('an open socket keeps an otherwise silent panel alive', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, idleMs: 1000 });
    const session = store.create('sid-1');
    store.socketOpened(session.id, sock());

    // A healthy /ws makes no HTTP requests at all, so lastSeenAt never moves.
    // Collecting here would be the original bug with a new trigger.
    clock.advance(100_000);
    expect(store.sweep()).toBe(0);
    expect(store.get(session.id)).not.toBeNull();
  });

  test('the session goes once the window closes and stays shut', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, idleMs: 1000 });
    const session = store.create('sid-1');
    const ws = sock();
    store.socketOpened(session.id, ws);

    store.socketClosed(session.id, ws);
    // Not immediately: a reconnect (brain restart, network blip) reopens within
    // seconds, and the panel is still on screen.
    clock.advance(999);
    expect(store.sweep()).toBe(0);

    clock.advance(1);
    expect(store.sweep()).toBe(1);
    expect(store.get(session.id)).toBeNull();
  });

  test('sibling panels sharing one session: collected only when the last closes', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, idleMs: 1000 });
    const session = store.create('sid-1');
    const first = sock();
    const second = sock();
    store.socketOpened(session.id, first);
    store.socketOpened(session.id, second);
    expect(store.socketsOpen(session.id)).toBe(2);

    store.socketClosed(session.id, first);
    clock.advance(5000);
    expect(store.sweep()).toBe(0);
    expect(store.get(session.id)).not.toBeNull();

    store.socketClosed(session.id, second);
    clock.advance(5000);
    expect(store.sweep()).toBe(1);
  });

  test('a reconnecting panel is not collected', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, idleMs: 1000 });
    const session = store.create('sid-1');
    const dropped = sock();
    store.socketOpened(session.id, dropped);
    store.socketClosed(session.id, dropped);

    clock.advance(500);
    store.socketOpened(session.id, sock()); // the 2s reconnect loop got through
    clock.advance(100_000);
    expect(store.sweep()).toBe(0);
  });

  test('socket bookkeeping ignores ids it does not know', () => {
    const store = new PanelSessionStore();
    expect(() => store.socketOpened('nope', sock())).not.toThrow();
    expect(() => store.socketClosed('nope', sock())).not.toThrow();
    expect(store.socketsOpen('nope')).toBe(0);
    // An unbalanced close, or a close naming a socket that was never opened,
    // cannot drive the count negative or strand it above zero.
    const session = store.create('sid-1');
    store.socketClosed(session.id, sock());
    expect(store.socketsOpen(session.id)).toBe(0);
    const ws = sock();
    store.socketOpened(session.id, ws);
    store.socketClosed(session.id, sock());
    expect(store.socketsOpen(session.id)).toBe(1);
    store.socketClosed(session.id, ws);
    expect(store.socketsOpen(session.id)).toBe(0);
  });

  test('a session restored from disk gets a full window to reconnect in', () => {
    const rows = new Map<string, PanelSession>();
    const sink: PanelSessionSink = {
      insert: (s) => { rows.set(s.id, { ...s }); },
      remove: (ids) => { for (const id of ids) rows.delete(id); },
      load: () => [...rows.values()],
    };
    const clock = at();
    const before = new PanelSessionStore({ now: clock.now, idleMs: 1000, sink });
    const session = before.create('sid-1');

    // The brain was down for a long time. lastSeenAt on disk is ancient, but
    // the panel is still open and its /ws is retrying every 2s.
    clock.advance(60_000);
    const after = new PanelSessionStore({ now: clock.now, idleMs: 1000, sink });
    expect(after.hydrate()).toBe(1);
    expect(after.sweep()).toBe(0);
    expect(after.get(session.id)).not.toBeNull();
  });

  test('the cap still wins over an open socket', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, maxAgeMs: 1000, idleMs: 100_000 });
    const session = store.create('sid-1');
    store.socketOpened(session.id, sock());

    clock.advance(1000);
    expect(store.sweep()).toBe(1);
    expect(store.get(session.id)).toBeNull();
  });

  test('teardown hangs up on the open sockets, it does not just forget them', () => {
    // A socket is authorized ONCE, at the upgrade, and never re-checked. So a
    // revoked laptop with a chat panel open keeps chatting unless the session
    // closes the socket itself. Deleting the map entry is not enough.
    const store = new PanelSessionStore();
    const session = store.create('sid-1');
    const ws = sock();
    store.socketOpened(session.id, ws);

    store.delete(session.id);

    expect(ws.closed).toHaveLength(1);
    expect(ws.closed[0]!.code).toBe(PANEL_SESSION_CLOSED_CODE);
    expect(store.socketsOpen(session.id)).toBe(0);
  });

  test('revoking a device hangs up on every one of its panels', () => {
    const store = new PanelSessionStore();
    const mine = store.create('sid-a');
    const alsoMine = store.create('sid-a');
    const theirs = store.create('sid-b');
    const a1 = sock();
    const a2 = sock();
    const b1 = sock();
    store.socketOpened(mine.id, a1);
    store.socketOpened(alsoMine.id, a2);
    store.socketOpened(theirs.id, b1);

    store.deleteBySid('sid-a');

    expect(a1.closed).toHaveLength(1);
    expect(a2.closed).toHaveLength(1);
    expect(b1.closed).toHaveLength(0);
  });

  test('the cap and the sweep hang up too', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, maxAgeMs: 1000, idleMs: 100_000 });
    const viaGet = store.create('sid-1');
    const viaSweep = store.create('sid-1');
    const g = sock();
    const w = sock();
    store.socketOpened(viaGet.id, g);
    store.socketOpened(viaSweep.id, w);

    clock.advance(1000);
    expect(store.get(viaGet.id)).toBeNull();
    expect(g.closed).toHaveLength(1);
    store.sweep();
    expect(w.closed).toHaveLength(1);
  });

  test('a socket that throws on close does not block the others', () => {
    const store = new PanelSessionStore();
    const session = store.create('sid-1');
    const angry = { close: () => { throw new Error('already gone'); } };
    const ok = sock();
    store.socketOpened(session.id, angry);
    store.socketOpened(session.id, ok);

    expect(() => store.delete(session.id)).not.toThrow();
    expect(ok.closed).toHaveLength(1);
  });

  test('a sleeping machine accrues no idle time: its windows are still on screen', () => {
    // The lid-closed case. The socket dies within a couple of minutes, no
    // requests arrive, and the panel is still there when the user comes back.
    // Collecting it would strand them on a 401 nothing in the page can fix --
    // the exact failure this work removes, on a commoner trigger than the
    // 10-minute expiry ever was.
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, idleMs: 1000 });
    const session = store.create('sid-1');
    const ws = sock();
    store.socketOpened(session.id, ws);
    store.socketClosed(session.id, ws);

    const offline = () => false;
    const online = () => true;
    clock.advance(100_000);
    expect(store.sweep(offline)).toBe(0);
    // `list`, not `get`: a get IS a request, so it would refresh lastSeenAt and
    // quietly make the session fresh again before the next assertion.
    expect(store.list().map((x) => x.id)).toContain(session.id);

    // WAKE, in the order it actually happens: the sidecar's own socket returns
    // first and the panel's reconnect loop follows a second or two later. A
    // sweep in that gap sees no panel socket, a lastSeenAt hours old, and a
    // connected sidecar. The gate alone would collect a window still on screen.
    store.touchBySid('sid-1');
    expect(store.sweep(online)).toBe(0);
    expect(store.list().map((x) => x.id)).toContain(session.id);

    // The panel reconnects and life goes on.
    store.socketOpened(session.id, sock());
    clock.advance(100_000);
    expect(store.sweep(online)).toBe(0);
  });

  test('a connected sidecar with no window really does get collected', () => {
    // The other side of the wake test: touchBySid grants a window, it is not a
    // reprieve. A device that is online and opens no panel socket for the whole
    // window has genuinely closed its windows.
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, idleMs: 1000 });
    const session = store.create('sid-1');
    store.touchBySid('sid-1');

    clock.advance(1000);
    expect(store.sweep(() => true)).toBe(1);
    expect(store.list()).toHaveLength(0);
  });

  test('touchBySid refreshes only the named device', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, idleMs: 1000 });
    const mine = store.create('sid-a');
    const theirs = store.create('sid-b');
    clock.advance(999);

    expect(store.touchBySid('sid-a')).toBe(1);
    clock.advance(1);
    expect(store.sweep(() => true)).toBe(1);
    expect(store.list().map((x) => x.id)).toEqual([mine.id]);
    expect(store.list().map((x) => x.id)).not.toContain(theirs.id);
  });

  test('a socket that arrives after its session was collected is hung up on', () => {
    // Upgrade succeeded, then the sweep ran before open() did. Returning early
    // would leave it connected, authorized, and in no session's set -- so no
    // teardown could ever reach it.
    const store = new PanelSessionStore();
    const late = sock();
    store.socketOpened('already-collected', late);

    expect(late.closed).toHaveLength(1);
    expect(late.closed[0]!.code).toBe(PANEL_SESSION_CLOSED_CODE);
  });

  test('the cap ignores the gate: it is a bound, not hygiene', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, maxAgeMs: 1000, idleMs: 100_000 });
    const session = store.create('sid-1');

    clock.advance(1000);
    expect(store.sweep(() => false)).toBe(1);
    expect(store.get(session.id)).toBeNull();
  });

  test('the gate is asked about the right device', () => {
    const clock = at();
    const store = new PanelSessionStore({ now: clock.now, idleMs: 1000 });
    const online = store.create('sid-online');
    const offline = store.create('sid-offline');
    clock.advance(5000);

    expect(store.sweep((sid) => sid === 'sid-online')).toBe(1);
    expect(store.get(online.id)).toBeNull();
    expect(store.get(offline.id)).not.toBeNull();
  });

  test('stopping is not revocation: clear() does not hang up', () => {
    // A 4401 would tell a panel it was revoked when the brain is merely
    // restarting around it, and its session is on disk waiting for it.
    const store = new PanelSessionStore();
    const session = store.create('sid-1');
    const ws = sock();
    store.socketOpened(session.id, ws);

    store.clear();
    expect(ws.closed).toHaveLength(0);
  });
});
