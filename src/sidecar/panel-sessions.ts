/**
 * Panel sessions: what authenticates a panel webview's data-plane traffic.
 *
 * REPLACES putting a short-lived access JWT in the cookie. That design made
 * the cookie's lifetime the session's lifetime: at 10 minutes the JWT expired,
 * every /api call started 401ing and the panel's /ws could never reconnect,
 * and nothing in the page could fix it (the cookie is HttpOnly and only the
 * sidecar, which holds the enrollment JWT, may mint). The window had to be
 * closed and reopened. See the TTL note on issueAccessToken.
 *
 * The access token is now a BOOTSTRAP credential only: the sidecar mints one,
 * puts it in the spawn URL, and the brain exchanges it for a session. The
 * session id -- an opaque random string that grants nothing on its own and
 * carries no claims -- is what lives in the cookie afterwards.
 *
 * That exchange is NOT single-use, and saying so matters. There is no `jti` on
 * an access token to record, and the sidecar deliberately caches one token and
 * reuses it for every panel spawned in the following ~9 minutes (see
 * accessTokenProvider in sidecar/access_token.go), so enforcing single-use
 * would break the second window a user opens. A spawn URL that leaks inside
 * the token's TTL therefore opens sessions, and what bounds those is the list
 * below rather than the token's expiry.
 *
 * WHAT BOUNDS A LEAKED COOKIE, now that it is not a 10-minute JWT:
 *
 *  1. The absolute cap here. A session cannot outlive it under any traffic
 *     pattern, so a stolen cookie has a hard deadline like the JWT did -- a
 *     much longer one, which is the cost of this change and is only worth
 *     paying because of 2 and 3.
 *  2. Enrollment, re-checked on every request by the resolver (the store holds
 *     `sid` for exactly this). `verifyAccessToken` skipped that lookup on the
 *     grounds that the short TTL was the revocation mechanism; a session that
 *     can outlive one TTL has to do the check it was trading away.
 *  3. Teardown on revocation: immediately, and within 30s for a revocation
 *     performed by the separate `jarvis revoke` process. Both hang up on the
 *     session's open sockets, which are authorized once at the upgrade and
 *     never re-checked.
 *
 * Idle collection (PANEL_SESSION_IDLE_MS) is deliberately NOT on that list. It
 * reclaims sessions whose windows are gone; it bounds no adversary, because
 * one holding the cookie holds a socket open and never goes idle.
 *
 * And one more that is the same product decision as the enroll note above:
 * DELETE /api/sidecars/:id is authorized by the same cookie, so a stolen one
 * can also revoke the owner's OTHER devices -- denial of service on top of the
 * laundering.
 *
 * WHAT IS NOT BOUNDED, recorded so the trade is made knowingly: POST
 * /api/sidecars/enroll (src/daemon/api-routes.ts) is authorized by nothing but
 * a data-plane cookie and returns a fresh long-lived enrollment JWT under a
 * NEW sid. A stolen cookie can therefore be laundered into a credential that
 * outlives every bound above, and revoking the original device does not touch
 * it. That path predates this change -- it was reachable with the access-token
 * cookie too -- but the window to use it grows from 10 minutes to the cap, so
 * it wants a real fix: enrollment is a control-plane act and should not be
 * authorized by a panel session.
 *
 * Held in memory for the read path and written through to `panel_sessions` for
 * durability. A brain serves ONE user, so a lookup is a Map hit and not a
 * per-tenant round trip; the table exists because the brain is restarted
 * routinely (every hosted update runs `systemctl restart` on the instance
 * unit) and an in-memory-only session would strand every open panel on a 401
 * no page could recover from.
 */

/**
 * Cookie name. Deliberately NOT the old `token`: a stale cookie from the
 * previous scheme holds a JWT, and a resolver that read it as a session id
 * would simply miss, which is the behaviour we want (fall through to the
 * bootstrap exchange) rather than anything ambiguous.
 */
export const PANEL_SESSION_COOKIE = 'panel_session';

/**
 * The hard ceiling on one session. Long enough that a working day never hits
 * it, short enough to bound a leaked cookie on a machine that never revokes
 * anything.
 *
 * Be honest about what reaching it looks like: nothing renews, so the panel
 * gets the ORIGINAL failure back -- 401s and a /ws reconnect loop -- and has
 * to be closed and reopened. That is a deliberately accepted edge at 12 hours
 * where it was intolerable at 10 minutes, not a case that is handled. Handling
 * it properly means the sidecar re-navigating a stranded panel, which it
 * cannot do today (sidecar/access_token.go calls live re-injection a
 * follow-up).
 */
export const PANEL_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * How long a session with NO open panel socket and no requests survives before
 * it is collected.
 *
 * This is what reclaims a session when the window closes, and it is
 * deliberately not built on panel ids. The sidecar does emit `panel.closed`
 * with one, but binding it to a session would mean threading an identifier
 * through every spawn path -- the brain's panel.spawn RPC, the tray's own
 * OpenChat, and whatever spawns next -- in Go, per platform, where the cost of
 * missing one is a session that is silently never collected. Worse, panels
 * SHARE a session: every webview in the sidecar process shares a cookie jar,
 * so a second window opened while the first's cookie is live never exchanges a
 * token at all, and closing on one panel's id would kill its siblings. A
 * window going away takes its WebSocket with it, on every platform and every
 * spawn path, and the last socket going is exactly "the last window closed".
 *
 * HYGIENE, NOT A BOUND. It reclaims sessions whose panels are gone; it defends
 * against nobody, because an adversary holding the cookie also holds a socket
 * open and never goes idle. The bounds are the cap and revocation.
 *
 * Which is why this is generous, and why `sweep` will not apply it to a
 * session whose sidecar is OFFLINE. Two ways a live panel looks idle:
 *
 *  1. The machine sleeps. The socket dies within a couple of minutes, no
 *     requests arrive, and the window is still on screen when the user
 *     returns. Two things cover this: the sweep will not idle-collect while
 *     the sidecar is disconnected, and `touchBySid` grants a fresh window when
 *     it reconnects -- because the sidecar's socket comes back a second or two
 *     before the panel's, and the gate alone would leave that gap open.
 *  2. The page never opens a socket at all. The onboarding wizard renders
 *     instead of the app shell, and the task/answer/palette rooms only fetch.
 *     A user who leaves the wizard to go and find an API key is idle at the
 *     highest-friction moment in the product, with the sidecar online -- so
 *     the gate does not cover this one and only the length of the window does.
 *
 * Collecting either would strand the panel on a permanent 401 it cannot
 * recover from: the failure this whole change exists to remove, arriving on a
 * more common trigger than the 10-minute expiry ever was. Hours, therefore,
 * and short enough only to still beat the 12-hour cap to the work.
 */
export const PANEL_SESSION_IDLE_MS = 4 * 60 * 60 * 1000;

/**
 * Just enough of a WebSocket to hold and hang up on. Structural so this module
 * never imports Bun's ServerWebSocket, and so a test can pass a recorder.
 */
export interface PanelSocket {
  close(code?: number, reason?: string): void;
}

/** Close code sent to a panel whose session was torn down under it. In the
 *  4000-4999 application range; the page sees a clean close, not a network
 *  error, and its reconnect will be refused at the upgrade. */
export const PANEL_SESSION_CLOSED_CODE = 4401;

/**
 * Durable backing for the store. Kept as a seam rather than reaching for the
 * vault DB directly so the store stays a plain data structure with an
 * injectable clock, and so a caller that genuinely wants a throwaway store
 * (tests, the setup-only open-access mode) can have one by passing nothing.
 *
 * Every method is best-effort from the store's point of view: a persistence
 * failure must never take out the in-memory session, because that would turn
 * a disk hiccup into the exact permanent-401 the sessions exist to prevent.
 */
export interface PanelSessionSink {
  insert(session: PanelSession): void;
  remove(ids: readonly string[]): void;
  load(): PanelSession[];
}

export interface PanelSession {
  /** Opaque, 256 bits of randomness. The cookie value. */
  readonly id: string;
  /** The enrolled sidecar this session belongs to. Drives the enrollment
   *  re-check and every teardown path. */
  readonly sid: string;
  readonly createdAt: number;
  /** Last time this session authenticated a request. Read by the idle rule in
   *  `sweep`, together with whether any socket is open. */
  lastSeenAt: number;
}

/** 32 bytes of CSPRNG as base64url. Unguessable, so a Map lookup is a safe
 *  index -- there is no secret being compared here, only one being found. */
function newSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export class PanelSessionStore {
  private sessions = new Map<string, PanelSession>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly sink: PanelSessionSink | null;
  private readonly idleMs: number;
  /**
   * Open panel sockets per session. Holds the sockets themselves rather than a
   * count for two jobs at once: an open socket is liveness (so an idle-but-open
   * window is never collected), AND a torn-down session has to HANG UP on them.
   *
   * That second job is not optional. A socket is authorized once, at the
   * upgrade, and never re-checked; deleting the session only stops the next
   * HTTP request and the next reconnect. Without this, revoking a stolen
   * laptop left its already-open chat panel streaming.
   */
  private live = new Map<string, Set<PanelSocket>>();

  constructor(
    opts: { now?: () => number; maxAgeMs?: number; idleMs?: number; sink?: PanelSessionSink } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? PANEL_SESSION_MAX_AGE_MS;
    this.idleMs = opts.idleMs ?? PANEL_SESSION_IDLE_MS;
    this.sink = opts.sink ?? null;
  }

  /** A panel socket opened on this session. Unknown ids are ignored: the
   *  session may have been collected between the upgrade and this call. */
  socketOpened(id: string, socket: PanelSocket): void {
    if (!this.sessions.has(id)) {
      // Collected between the upgrade and this call. The socket is already
      // connected and authorized, and nothing would ever be able to reach it
      // again (it is in no session's set), so close it here or it outlives the
      // session that justified it.
      try {
        socket.close(PANEL_SESSION_CLOSED_CODE, 'panel session closed');
      } catch {
        /* already gone */
      }
      return;
    }
    const open = this.live.get(id);
    if (open) open.add(socket);
    else this.live.set(id, new Set([socket]));
  }

  /** A panel socket closed. The session becomes idle-collectable once the last
   *  one goes, which is what happens when the window is closed. */
  socketClosed(id: string, socket: PanelSocket): void {
    const open = this.live.get(id);
    if (!open) return;
    open.delete(socket);
    if (open.size === 0) this.live.delete(id);
  }

  /** Open panel sockets on a session. For tests and ops surfaces. */
  socketsOpen(id: string): number {
    return this.live.get(id)?.size ?? 0;
  }

  /**
   * Drop a session's sockets and hang up on them. Called from every path that
   * ends a session, because none of them are complete without it.
   *
   * Best-effort per socket: one that throws on close (already gone) must not
   * stop the rest from being closed.
   */
  private hangUp(id: string): void {
    const open = this.live.get(id);
    if (!open) return;
    this.live.delete(id);
    for (const socket of open) {
      try {
        socket.close(PANEL_SESSION_CLOSED_CODE, 'panel session closed');
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Read persisted sessions back in, dropping anything already past the cap.
   * Call once at startup, before the server accepts a request: a panel that
   * was open across a brain restart presents its cookie immediately.
   *
   * Returns how many were restored. Never throws -- a store that cannot read
   * its backing is an empty store, which costs the user a reopened window,
   * whereas a throw here would cost them a brain that will not start.
   */
  hydrate(): number {
    if (!this.sink) return 0;
    let restored = 0;
    try {
      const at = this.now();
      const stale: string[] = [];
      for (const session of this.sink.load()) {
        if (at - session.createdAt >= this.maxAgeMs) {
          stale.push(session.id);
          continue;
        }
        // lastSeenAt is restored as of the last write, which for a session
        // that sat through a long downtime would read as instantly idle. The
        // panel is about to reconnect (its /ws retries every 2s), so give it a
        // full window to do so rather than collecting it before it can.
        this.sessions.set(session.id, { ...session, lastSeenAt: at });
        restored++;
      }
      if (stale.length > 0) this.sink.remove(stale);
    } catch (err) {
      console.error('[PanelSessions] Could not restore sessions:', err);
    }
    return restored;
  }

  /** Persistence is best-effort by construction: see PanelSessionSink. */
  private persist(fn: (sink: PanelSessionSink) => void): void {
    if (!this.sink) return;
    try {
      fn(this.sink);
    } catch (err) {
      console.error('[PanelSessions] Persistence failed (session still live):', err);
    }
  }

  /** Open a session for an enrolled sidecar. The caller is responsible for
   *  having established that `sid` is enrolled (the bootstrap exchange does
   *  it by verifying a brain-minted access token). */
  create(sid: string): PanelSession {
    const at = this.now();
    const session: PanelSession = { id: newSessionId(), sid, createdAt: at, lastSeenAt: at };
    this.sessions.set(session.id, session);
    this.persist((sink) => sink.insert(session));
    return session;
  }

  /**
   * Resolve a cookie value, or null when it names nothing / has aged out.
   *
   * Expiry is enforced HERE rather than only in the periodic sweep, so a
   * session is dead the moment it is too old even if no sweep has run since.
   * Aged-out entries are dropped on the way past, which is what keeps an
   * abandoned panel's session from sitting in the map forever.
   */
  get(id: string): PanelSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const at = this.now();
    if (at - session.createdAt >= this.maxAgeMs) {
      this.sessions.delete(id);
      this.hangUp(id);
      this.persist((sink) => sink.remove([id]));
      return null;
    }
    // Deliberately NOT written through. lastSeenAt moves on every authenticated
    // request; a write per request would put a disk round trip on the hot path
    // to keep a field nothing AUTHORIZES on (the cap is measured from
    // createdAt, and authorization never reads this). The idle rule in `sweep`
    // does read it, which is the reason hydrate() resets it to the restore
    // time rather than trusting the on-disk value -- that value is always the
    // one written at INSERT, and would read as instantly idle.
    session.lastSeenAt = at;
    return session;
  }

  /**
   * Give every session of one sidecar a fresh idle window.
   *
   * Called when that sidecar (re)connects, and it is what makes the idle rule
   * safe. `lastSeenAt` only advances on an authenticated HTTP REQUEST -- an
   * open socket protects a session but never touches it -- so a panel that has
   * been open and quiet for longer than the idle window carries an ancient
   * `lastSeenAt` while being perfectly alive. On wake the sidecar's own socket
   * comes back a second or two before the panel's does, and a sweep landing in
   * that gap would see no sockets, a stale `lastSeenAt` and a connected
   * sidecar, and collect a window that is still on the user's screen.
   *
   * Same treatment `hydrate` gives a restored session, for the same reason:
   * something just came back and its panels are about to.
   */
  touchBySid(sid: string): number {
    const at = this.now();
    let touched = 0;
    for (const session of this.sessions.values()) {
      if (session.sid === sid) {
        session.lastSeenAt = at;
        touched++;
      }
    }
    return touched;
  }

  /** Close one session. Returns whether it existed. */
  delete(id: string): boolean {
    const existed = this.sessions.delete(id);
    this.hangUp(id);
    if (existed) this.persist((sink) => sink.remove([id]));
    return existed;
  }

  /** Close EVERY session belonging to one sidecar, hanging up on their sockets.
   *  Called on REVOCATION only -- a mere disconnect deliberately leaves panels
   *  alone (see handleSidecarDisconnect). Returns how many were closed. */
  deleteBySid(sid: string): number {
    const gone: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.sid === sid) {
        this.sessions.delete(id);
        this.hangUp(id);
        gone.push(id);
      }
    }
    if (gone.length > 0) this.persist((sink) => sink.remove(gone));
    return gone.length;
  }

  /**
   * Drop everything past the cap, and everything idle enough to be gone.
   * Returns how many went.
   *
   * `canIdle` decides whether a session is even eligible for the idle rule.
   * The manager passes "is this session's sidecar connected right now", so a
   * sleeping or partitioned machine accrues no idle time at all -- its panels
   * are still on screen, and collecting them would strand a working user. The
   * cap ignores it: that one is a bound and applies unconditionally.
   */
  sweep(canIdle: (sid: string) => boolean = () => true): number {
    const at = this.now();
    const gone: string[] = [];
    for (const [id, session] of this.sessions) {
      const expired = at - session.createdAt >= this.maxAgeMs;
      // An open socket is liveness on its own; only a session with none can be
      // idle. See PANEL_SESSION_IDLE_MS.
      const idle =
        (this.live.get(id)?.size ?? 0) === 0 &&
        at - session.lastSeenAt >= this.idleMs &&
        canIdle(session.sid);
      if (expired || idle) {
        this.sessions.delete(id);
        this.hangUp(id);
        gone.push(id);
      }
    }
    if (gone.length > 0) this.persist((sink) => sink.remove(gone));
    return gone.length;
  }

  /** Live sessions. For tests and ops surfaces. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Forget everything in memory WITHOUT touching the backing store, so a
   * stopped manager resolves no cookies while a restart can still restore the
   * panels that were open. Anything that should not come back must be closed
   * through `delete`/`deleteBySid`, which do write through.
   */
  clear(): void {
    this.sessions.clear();
    // No hangUp: this is a stop, not a teardown, and a 4401 would tell a panel
    // it was revoked when its session is on disk waiting for the restart.
    // (Bun's server.stop() without closeActiveConnections does not close them
    // either; process exit does. That is fine -- the panel sees a dropped
    // connection and reconnects, which is what should happen.)
    this.live.clear();
  }

  /**
   * Snapshot, newest first. For an ops surface that lists open panels.
   *
   * Filters what `get` would already refuse: an aged-out session that nothing
   * has looked up yet is still in the map, and reporting it as an open panel
   * would be a lie told to whoever is reading the list to decide something.
   */
  list(): PanelSession[] {
    const at = this.now();
    return [...this.sessions.values()]
      .filter((s) => at - s.createdAt < this.maxAgeMs)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

/**
 * The vault-backed sink. Lives here rather than in the store so the store
 * itself never imports the DB, and so the SQL for one table sits next to the
 * shape it persists.
 *
 * `getDb` is injected because the vault opens lazily and a module-level handle
 * would bind this to whichever database existed at import time -- which in the
 * test suite is a different one per file.
 */
export function vaultPanelSessionSink(getDb: () => {
  run(sql: string, params?: unknown[]): unknown;
  query(sql: string): { all(...params: unknown[]): unknown[] };
}): PanelSessionSink {
  return {
    insert(session) {
      // Plain INSERT: a collision on a 256-bit random id is a bug in the id
      // generator, and OR REPLACE would hide it.
      getDb().run(
        'INSERT INTO panel_sessions (id, sidecar_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
        [session.id, session.sid, session.createdAt, session.lastSeenAt],
      );
    },
    remove(ids) {
      if (ids.length === 0) return;
      const db = getDb();
      // Chunked because SQLite caps bound variables (32766 on the bundled
      // build) and this list is not bounded by anything the code controls: the
      // bootstrap token is reusable inside its TTL, so a leaked spawn URL can
      // open an unlimited number of sessions for one sid, and the deleteBySid
      // that eventually cleans them up would throw "too many SQL variables"
      // forever -- swallowed by persist(), leaving the rows on disk for good.
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        // Parameterised placeholders, not interpolation: these ids are ours,
        // but this table is one revoked-device teardown away from being fed a
        // value that came off a cookie.
        const holes = chunk.map(() => '?').join(',');
        db.run(`DELETE FROM panel_sessions WHERE id IN (${holes})`, [...chunk]);
      }
    },
    load() {
      const rows = getDb()
        .query('SELECT id, sidecar_id, created_at, last_seen_at FROM panel_sessions')
        .all() as Array<{ id: string; sidecar_id: string; created_at: number; last_seen_at: number }>;
      return rows.map((r) => ({
        id: r.id,
        sid: r.sidecar_id,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
      }));
    },
  };
}
