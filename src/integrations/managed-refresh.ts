import {createHash, createHmac, randomUUID} from "node:crypto";
import {join} from "node:path";
import {writeFileSync, renameSync, unlinkSync} from "node:fs";
import type {JarvisConfig} from "../config/types";
import {readManagedConnectionFile} from "./managed-connection-file";
export interface ManagedRefreshConnection {
  generation:string; account:{id:string}; access_token:string; refresh_token:string; expires_at:string;
  refresh:{url:string;instance_id:string;secret:string};
}
/** Shared instance-side renewal for providers with stable refresh tokens.
 * Hosting owns the delivered grant; this cache never overwrites a reconnect or tombstone.
 * Strict/lenient token rotation is deliberately refused until durable rotation is qualified.
 */
export function createManagedTokenRefresher<T extends ManagedRefreshConnection>(provider:string,name:string,readConnection:(dataDir:string)=>T|null) {
  const flights = new Map<string, Promise<T>>();
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  /** Stable across ordinary access-token renewal, different for every delivered grant. */
  const grantKey = (c: T) =>
    hash(
      JSON.stringify([
        c.generation,
        c.account.id,
        c.access_token,
        c.refresh_token,
        c.refresh,
      ]),
    );
  const cachePath = (config: JarvisConfig) =>
    join(config.daemon.data_dir, "connections", provider + "-access.json");
  interface Cache {
    key: string;
    access_token?: string;
    expires_at?: string;
    reconnect?: boolean;
  }
  function cached(config: JarvisConfig, c: T): Cache | null {
    try {
      const value = JSON.parse(readManagedConnectionFile(cachePath(config))) as Cache;
      return value.key === grantKey(c) ? value : null;
    } catch {
      return null;
    }
  }
  function needsReconnect(
    config: JarvisConfig,
    c: T,
  ): boolean {
    return cached(config, c)?.reconnect === true;
  }
  function save(config: JarvisConfig, value: Cache) {
    const path = cachePath(config),
      temp = path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* already renamed */
      }
    }
  }
  function sameGrant(config: JarvisConfig, c: T): boolean {
    const live = readConnection(config.daemon.data_dir);
    return !!live && grantKey(live) === grantKey(c);
  }
  function usable(token: unknown, expiry: unknown): boolean {
    return (
      typeof token === "string" &&
      !!token &&
      token.length <= 16384 &&
      typeof expiry === "string" &&
      Date.parse(expiry) > Date.now() + 60000
    );
  }
  /** Refresh through the configured hosting origin, never a URL chosen by a workflow. */
  async function fresh(
    config: JarvisConfig,
    request: typeof fetch = fetch,
  ): Promise<T> {
    const c = readConnection(config.daemon.data_dir);
    if (!c) throw new Error(`Connect ${name} in your account page.`);
    const key = grantKey(c),
      saved = cached(config, c);
    if (saved?.reconnect)
      throw new Error(`Reconnect ${name} in your account page.`);
    if (usable(saved?.access_token, saved?.expires_at))
      return {
        ...c,
        access_token: saved!.access_token!,
        expires_at: saved!.expires_at!,
      };
    if (usable(c.access_token, c.expires_at)) return c;
    const flightKey = config.daemon.data_dir + ":" + key;
    const pending = flights.get(flightKey);
    if (pending) return pending;
    const operation = (async () => {
      let endpoint: URL;
      try {
        const origin = new URL(config.usejarvis_integrations!.page_url!);
        endpoint = new URL(c.refresh.url);
        if (
          origin.protocol !== "https:" ||
          endpoint.origin !== origin.origin ||
          endpoint.pathname !== "/api/integrations/" + provider + "/refresh" ||
          endpoint.search ||
          endpoint.hash ||
          endpoint.username ||
          endpoint.password
        )
          throw new Error();
      } catch {
        throw new Error(`${name} renewal is not configured. Reconnect ${name}.`);
      }
      const body = JSON.stringify({
        instanceId: c.refresh.instance_id,
        refreshToken: c.refresh_token,
        at: new Date().toISOString(),
      });
      let response: Response;
      try {
        response = await request(endpoint.toString(), {
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
      let text = "";
      const reader = response.body?.getReader();
      try {
        if (!reader) throw new Error();
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 65536) throw new Error();
          chunks.push(value);
        }
        text = Buffer.concat(chunks).toString("utf8");
      } catch {
        throw new Error(
          `${name} renewal returned an invalid response. Try again shortly.`,
        );
      } finally {
        await reader?.cancel().catch(() => {});
      }
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error(`${name} renewal returned an invalid response.`);
      }
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error(`${name} renewal returned an invalid response.`);
      if (!sameGrant(config, c))
        throw new Error(`${name} connection changed. Try again.`);
      if (response.status === 409 && result.reconnect === true) {
        save(config, { key, reconnect: true });
        throw new Error(`Reconnect ${name} in your account page.`);
      }
      if (!response.ok)
        throw new Error(`Could not renew ${name} access. Try again shortly.`);
      if (
        !usable(result.access_token, result.expires_at) ||
        (result.refresh_token !== undefined &&
          result.refresh_token !== c.refresh_token)
      )
        throw new Error(
          `${name} renewal returned an unsupported token response.`,
        );
      save(config, {
        key,
        access_token: result.access_token as string,
        expires_at: result.expires_at as string,
      });
      if (!sameGrant(config, c))
        throw new Error(`${name} connection changed. Try again.`);
      return {
        ...c,
        access_token: result.access_token as string,
        expires_at: result.expires_at as string,
      };
    })();
    flights.set(flightKey, operation);
    try {
      return await operation;
    } finally {
      flights.delete(flightKey);
    }
  }

  return {fresh, needsReconnect, grantKey};
}
