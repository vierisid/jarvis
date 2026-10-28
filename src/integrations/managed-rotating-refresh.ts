import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";
interface ManagedRefreshConnection {
  generation: string;
  account: { id: string };
  access_token: string;
  refresh_token: string;
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
/** Tenant-owned durable cache. SQLite FULL commits before ack; an OS-backed write lock
 * serializes processes and is released automatically on crash. Hosting's grant is never overwritten.
 */
export function createManagedRotatingRefresher<
  T extends ManagedRefreshConnection,
>(provider: string, name: string, read: (dir: string) => T | null, options: {
  allowUnknownExpiry?: boolean;
  validateAccess?: (connection: T, request: typeof fetch) => Promise<boolean>;
} = {}) {
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
  function open(config: JarvisConfig) {
    const path = join(
      config.daemon.data_dir,
      "connections",
      provider + "-renewal.sqlite",
    );
    const db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    db.exec(
      "PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS renewal (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    return db;
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
    (options.allowUnknownExpiry && v.expires_at === null || typeof v.expires_at === "string" && Date.parse(v.expires_at) > Date.now() + 60000);
  function needsReconnect(config: JarvisConfig, c: T): boolean {
    let db: Database | undefined;
    try {
      db = open(config);
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
        try {
          db.exec("BEGIN IMMEDIATE");
          transaction = true;
        } catch {
          throw new Error(`${name} renewal is in progress. Try again shortly.`);
        }
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
          db.exec("BEGIN IMMEDIATE");
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
        const accepted = usable(current) && (!options.validateAccess || await options.validateAccess({...c, ...current} as T, request));
        if (!same(config, c)) throw new Error(`${name} connection changed. Try again.`);
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
              db.exec("BEGIN IMMEDIATE");
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
        if (!accepted && options.validateAccess && !await options.validateAccess({...c, ...current} as T, request)) {
          db.exec("BEGIN IMMEDIATE"); transaction = true;
          if (same(config, c)) save(db, {key, reconnect:true});
          db.exec("COMMIT"); transaction = false;
          throw new Error(`Reconnect ${name} in your account page.`);
        }
        if (!same(config, c)) throw new Error(`${name} connection changed. Try again.`);
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
