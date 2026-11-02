import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";
interface ManagedRefreshConnection {
  generation: string;
  account: { id: string };
  access_token: string;
  refresh_token: string;
  /** null only for a provider that opts in with `allowUnknownExpiry`. */
  expires_at: string | null;
  refresh: { url: string; instance_id: string; secret: string };
}
interface Cached {
  key: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: string | null;
  receipt?: string;
  reconnect?: boolean;
}
/** How long a renewal waits for another process's renewal of the same grant.
 * Longer than one renewal round trip (the 20s request timeout), so a waiter
 * outlasts the holder and then reuses its stored result instead of failing. */
const LOCK_WAIT_MS = 25000;
/** A short synchronous wait for the commit window of another connection. */
const COMMIT_WAIT_MS = 250;
const busy = (error: unknown) =>
  /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(
    String((error as { code?: unknown })?.code ?? "") +
      " " +
      String((error as { message?: unknown })?.message ?? ""),
  );
/** Tenant-owned durable cache. SQLite FULL commits before ack; an OS-backed write lock
 * serializes processes and is released automatically on crash. Hosting's grant is never overwritten.
 * The file is created 0600 before SQLite opens it, and SQLite gives its rollback
 * journal the database file's mode, so the refresh token is never readable by others.
 */
export function createManagedRotatingRefresher<
  T extends ManagedRefreshConnection,
>(
  provider: string,
  name: string,
  read: (dir: string) => T | null,
  options: {
    lockWaitMs?: number;
    /** The provider issues rotating pairs without an expiry (hosting delivers
     * `expires_at: null` for a refreshable grant). A null expiry then counts
     * as unexpired, so pair it with `validateAccess`. Off by default. */
    allowUnknownExpiry?: boolean;
    /** Ask the provider whether an access token still works: true when it
     * does, false when the provider refused it (a 401), and throw for anything
     * else (throttling, an outage, a changed account), which never rotates.
     * When set, a token is used only after it passes, a refusal renews once,
     * and a renewed token that is refused needs reconnect. Off by default. */
    validateAccess?: (connection: T, request: typeof fetch) => Promise<boolean>;
  } = {},
) {
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const flights = new Map<string, Promise<T>>();
  const grantKey = (c: T) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          c.generation,
          c.account.id,
          c.access_token,
          c.refresh_token,
          c.refresh,
        ]),
      )
      .digest("hex");
  const dbPath = (config: JarvisConfig) =>
    join(config.daemon.data_dir, "connections", provider + "-renewal.sqlite");
  function open(config: JarvisConfig) {
    const path = dbPath(config);
    // Create it owner-only up front: SQLite would create it at 0644 minus the
    // umask, leaving a window before any chmod. An existing file is tightened.
    try {
      closeSync(
        openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        ),
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "EEXIST") throw error;
    }
    if (!lstatSync(path).isFile())
      throw new Error(`${name} renewal storage is not a regular file.`);
    chmodSync(path, 0o600);
    const db = new Database(path, { readwrite: true, create: false });
    try {
      db.exec(
        `PRAGMA busy_timeout=${COMMIT_WAIT_MS}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS renewal (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`,
      );
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  }
  /** Take the write lock, waiting without blocking the event loop while
   * another process renews the same grant. Each attempt fails fast (busy
   * timeout 0) and the wait happens between attempts. */
  async function lock(db: Database) {
    const deadline = Date.now() + lockWaitMs;
    db.exec("PRAGMA busy_timeout=0");
    try {
      for (;;) {
        try {
          db.exec("BEGIN IMMEDIATE");
          return;
        } catch (error) {
          if (!busy(error) || Date.now() >= deadline)
            throw new Error(
              `${name} renewal is in progress. Try again shortly.`,
            );
          await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
        }
      }
    } finally {
      db.exec(`PRAGMA busy_timeout=${COMMIT_WAIT_MS}`);
    }
  }
  const get = (db: Database, key: string): Cached | null => {
    const row = db.query("SELECT value FROM renewal WHERE id=1").get() as {
      value: string;
    } | null;
    if (!row) return null;
    const v = JSON.parse(row.value) as Cached;
    return v.key === key ? v : null;
  };
  const save = (db: Database, value: Cached) =>
    db
      .query(
        "INSERT INTO renewal VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(value));
  const same = (config: JarvisConfig, c: T) => {
    const current = read(config.daemon.data_dir);
    return !!current && grantKey(current) === grantKey(c);
  };
  const usable = (v: Cached | T | null) =>
    !!v &&
    typeof v.access_token === "string" &&
    v.access_token.length > 0 &&
    v.access_token.length <= 16384 &&
    ((options.allowUnknownExpiry === true && v.expires_at === null) ||
      (typeof v.expires_at === "string" &&
        Date.parse(v.expires_at) > Date.now() + 60000));
  /** The stored pair as a connection, to check or hand out. */
  const withToken = (c: T, v: Cached): T => ({
    ...c,
    access_token: v.access_token!,
    refresh_token: v.refresh_token!,
    expires_at: v.expires_at as T["expires_at"],
  });
  /** A status read: never creates the renewal file, and never writes. */
  function needsReconnect(config: JarvisConfig, c: T): boolean {
    let db: Database | undefined;
    try {
      const path = dbPath(config);
      if (!existsSync(path)) return false;
      db = new Database(path, { readonly: true });
      db.exec(`PRAGMA busy_timeout=${COMMIT_WAIT_MS}`);
      return get(db, grantKey(c))?.reconnect === true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }
  async function post(
    config: JarvisConfig,
    c: T,
    token: string,
    request: typeof fetch,
    receipt?: string,
  ): Promise<{ response: Response; value: any }> {
    let origin: URL, endpoint: URL;
    try {
      origin = new URL(config.usejarvis_integrations?.page_url ?? "");
      endpoint = new URL(c.refresh.url);
    } catch {
      throw new Error(`${name} renewal is not configured. Reconnect ${name}.`);
    }
    if (
      origin.protocol !== "https:" ||
      endpoint.origin !== origin.origin ||
      endpoint.pathname !== "/api/integrations/" + provider + "/refresh" ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error(`${name} renewal is not configured. Reconnect ${name}.`);
    const body = JSON.stringify({
      instanceId: c.refresh.instance_id,
      generation: c.generation,
      refreshToken: token,
      at: new Date().toISOString(),
      ...(receipt ? { ack: true, receipt } : {}),
    });
    let response: Response;
    try {
      response = await request(endpoint.href, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          "Content-Type": "application/json",
          "x-jarvis-signature": createHmac("sha256", c.refresh.secret)
            .update(body)
            .digest("hex"),
        },
        body,
      });
    } catch {
      throw new Error(`Could not renew ${name} access. Try again shortly.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${name} renewal returned an empty response.`);
    try {
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw new Error();
        chunks.push(value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return { response, value };
    } catch {
      throw new Error(
        `${name} renewal returned an invalid response. Try again shortly.`,
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async function fresh(
    config: JarvisConfig,
    request: typeof fetch = fetch,
  ): Promise<T> {
    const c = read(config.daemon.data_dir);
    if (!c) throw new Error(`Connect ${name} in your account page.`);
    const key = grantKey(c),
      flight = config.daemon.data_dir + ":" + key;
    const pending = flights.get(flight);
    if (pending) return pending;
    const operation = (async () => {
      let db: Database | undefined,
        transaction = false;
      try {
        db = open(config);
        await lock(db);
        transaction = true;
        const saved = get(db, key);
        if (saved?.reconnect)
          throw new Error(`Reconnect ${name} in your account page.`);
        let current: Cached = saved ?? {
          key,
          access_token: c.access_token,
          refresh_token: c.refresh_token,
          expires_at: c.expires_at,
        };
        if (!same(config, c))
          throw new Error(`${name} connection changed. Try again.`);
        // A pending acknowledgement must finish before any further rotation, even after a long outage.
        if (current.receipt) {
          db.exec("COMMIT");
          transaction = false;
          let ack: Awaited<ReturnType<typeof post>> | null;
          try {
            ack = await post(
              config,
              c,
              current.refresh_token!,
              request,
              current.receipt,
            );
          } catch {
            ack = null;
          }
          if (!ack || ack.response.status !== 409) {
            if (!ack || !ack.response.ok || ack.value.acknowledged !== true) {
              // Hosting is unreachable or failed: the acknowledgement stays
              // pending and is retried next time. Hosting's contract forbids
              // renewing before it is acknowledged, so no rotation happens
              // here, but a stored access token that is still valid for this
              // exact grant is safe to use meanwhile.
              const latest = get(db, key);
              // A token of unknown expiry is served only once the provider
              // confirms it still works; without a check it is never served.
              if (
                latest &&
                !latest.reconnect &&
                usable(latest) &&
                same(config, c) &&
                (latest.expires_at !== null ||
                  (!!options.validateAccess &&
                    (await options.validateAccess(withToken(c, latest), request)) &&
                    same(config, c)))
              )
                return withToken(c, latest);
              throw new Error(
                `Could not confirm ${name} renewal. Try again shortly.`,
              );
            }
          }
          await lock(db);
          transaction = true;
          if (
            ack.response.status === 409 &&
            ack.value.reconnect === true &&
            same(config, c)
          ) {
            const latest = get(db, key);
            if (latest?.receipt === current.receipt)
              save(db, { key, reconnect: true });
            db.exec("COMMIT");
            transaction = false;
            throw new Error(`Reconnect ${name} in your account page.`);
          }
          if (!ack.response.ok || ack.value.acknowledged !== true)
            throw new Error(
              `Could not confirm ${name} renewal. Try again shortly.`,
            );
          const latest = get(db, key);
          if (!same(config, c))
            throw new Error(`${name} connection changed. Try again.`);
          if (latest?.receipt === current.receipt) {
            current = { ...latest, receipt: undefined };
            save(db, current);
          } else if (latest) current = latest;
        }
        const accepted =
          usable(current) &&
          (!options.validateAccess ||
            (await options.validateAccess(withToken(c, current), request)));
        if (!same(config, c))
          throw new Error(`${name} connection changed. Try again.`);
        if (!accepted) {
          const { response, value } = await post(
            config,
            c,
            current.refresh_token!,
            request,
          );
          if (!same(config, c))
            throw new Error(`${name} connection changed. Try again.`);
          if (response.status === 409 && value.reconnect === true) {
            save(db, { key, reconnect: true });
            db.exec("COMMIT");
            transaction = false;
            throw new Error(`Reconnect ${name} in your account page.`);
          }
          if (!response.ok)
            throw new Error(
              `Could not renew ${name} access. Try again shortly.`,
            );
          if (
            !usable(value) ||
            typeof value.refresh_token !== "string" ||
            !value.refresh_token ||
            value.refresh_token.length > 16384 ||
            typeof value.receipt !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(value.receipt)
          )
            throw new Error(
              `${name} renewal returned an unsupported response.`,
            );
          current = {
            key,
            access_token: value.access_token,
            refresh_token: value.refresh_token,
            expires_at: value.expires_at,
            receipt: value.receipt,
          };
          save(db, current);
        }
        db.exec("COMMIT");
        transaction = false;
        // Success is durable locally before the control plane may erase its delivery cache.
        if (current.receipt) {
          try {
            const ack = await post(
              config,
              c,
              current.refresh_token!,
              request,
              current.receipt,
            );
            if (
              ack.response.ok &&
              ack.value.acknowledged === true &&
              same(config, c)
            ) {
              await lock(db);
              transaction = true;
              const latest = get(db, key);
              if (latest?.receipt === current.receipt)
                save(db, { ...latest, receipt: undefined });
              db.exec("COMMIT");
              transaction = false;
            }
          } catch {
            if (transaction) {
              db.exec("ROLLBACK");
              transaction = false;
            } /* keep receipt for next call */
          }
        }
        if (!same(config, c))
          throw new Error(`${name} connection changed. Try again.`);
        // A token the provider refused was renewed above; if the renewed one is
        // refused as well, renewing again cannot help.
        if (
          !accepted &&
          options.validateAccess &&
          !(await options.validateAccess(withToken(c, current), request))
        ) {
          await lock(db);
          transaction = true;
          if (same(config, c)) save(db, { key, reconnect: true });
          db.exec("COMMIT");
          transaction = false;
          throw new Error(`Reconnect ${name} in your account page.`);
        }
        if (!same(config, c))
          throw new Error(`${name} connection changed. Try again.`);
        return withToken(c, current);
      } finally {
        if (transaction) db?.exec("ROLLBACK");
        db?.close();
      }
    })();
    flights.set(flight, operation);
    try {
      return await operation;
    } finally {
      flights.delete(flight);
    }
  }
  return { fresh, needsReconnect, grantKey };
}
