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
  expires_at: string;
  refresh: { url: string; instance_id: string; secret: string };
}
interface Cached {
  key: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
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
  options: { lockWaitMs?: number } = {},
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
    typeof v.expires_at === "string" &&
    Date.parse(v.expires_at) > Date.now() + 60000;
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
    const origin = new URL(config.usejarvis_integrations?.page_url ?? "");
    const endpoint = new URL(c.refresh.url);
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
          const ack = await post(
            config,
            c,
            current.refresh_token!,
            request,
            current.receipt,
          );
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
        if (!usable(current)) {
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
        return {
          ...c,
          access_token: current.access_token!,
          refresh_token: current.refresh_token!,
          expires_at: current.expires_at!,
        };
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
