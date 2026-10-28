import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import type { JarvisConfig } from "../config/types";
import { readAsanaConnection, asanaStatus } from "./asana-connection";
import {
  freshAsanaConnection,
  asanaNeedsReconnect,
  asanaGrantKey,
} from "./asana-refresh";
import { JarvisAsanaConnectionSource } from "../workflows/credentials/asana-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
let dir: string, config: JarvisConfig;
const doc = () => ({
  version: 1 as const,
  provider: "asana" as const,
  status: "connected" as const,
  generation: randomUUID(),
  access_token: "OLD_ACCESS",
  refresh_token: "PRIVATE_REFRESH",
  expires_at: new Date(0).toISOString(),
  account: { id: "1234", label: "owner@example.test" },
  workspaces: [{ id: "123", name: "Jarvis sandbox" }],
  connected_at: new Date().toISOString(),
  refresh: {
    url: "https://app.usejarvis.dev/api/integrations/asana/refresh",
    instance_id: randomUUID(),
    secret: "a".repeat(64),
  },
});
const write = (v: unknown) =>
  writeFileSync(join(dir, "connections/asana.json"), JSON.stringify(v));
const success = () =>
  Response.json({
    access_token: "NEW_ACCESS",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "asana-unit-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  } as JarvisConfig;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test("status is secret-free, malformed grants fail closed and only qualified actions can use the credential", () => {
  const c = doc();
  write(c);
  const source = new JarvisAsanaConnectionSource(config);
  expect(asanaStatus(config)).toMatchObject({
    connected: true,
    connect_url: "https://app.usejarvis.dev/account?integration=asana",
  });
  expect(JSON.stringify(asanaStatus(config))).not.toMatch(
    /OLD_ACCESS|PRIVATE_REFRESH|aaaaaaa/,
  );
  for (const action of ["custom_api_call", "delete_task", "new_task"])
    expect(
      managedConnectionMisuse(
        source,
        source.pieceNames[0]!,
        "settings.input.auth",
        { actionName: action },
      ),
    ).not.toBeNull();
  expect(
    managedConnectionMisuse(
      source,
      source.pieceNames[0]!,
      "settings.input.auth",
      { actionName: "get_task" },
    ),
  ).toBeNull();
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-http",
      "settings.input.auth",
      {},
    ),
  ).not.toBeNull();
  for (const bad of [
    { ...c, refresh: null },
    { ...c, expires_at: "invalid" },
    { ...c, workspaces: [] },
    { ...c, provider: "other" },
  ]) {
    write(bad);
    expect(readAsanaConnection(dir)).toBeNull();
  }
  writeFileSync(join(dir, "connections/asana.json"), "x".repeat(65537));
  expect(readAsanaConnection(dir)).toBeNull();
});
test("concurrent renewal signs exact bytes, caches atomically and preserves grant identity across restart", async () => {
  const c = doc();
  write(c);
  let calls = 0;
  const request = (async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe(c.refresh.url);
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("x-jarvis-signature")).toBe(
      createHmac("sha256", c.refresh.secret)
        .update(String(init.body))
        .digest("hex"),
    );
    expect(JSON.parse(String(init.body)).refreshToken).toBe("PRIVATE_REFRESH");
    await Bun.sleep(5);
    return success();
  }) as unknown as typeof fetch;
  const source = new JarvisAsanaConnectionSource(config, request),
    identity = source.identity("jarvis:asana");
  const results = await Promise.all(
    Array.from({ length: 8 }, () => source.resolve("jarvis:asana")),
  );
  expect(calls).toBe(1);
  expect(results.every((x) => x?.value.access_token === "NEW_ACCESS")).toBe(
    true,
  );
  expect(source.identity("jarvis:asana")).toBe(identity);
  expect(readFileSync(join(dir, "connections/asana.json"), "utf8")).toBe(
    JSON.stringify(c),
  );
  expect(
    statSync(join(dir, "connections/asana-access.json")).mode & 0o777,
  ).toBe(0o600);
  expect(
    (
      await new JarvisAsanaConnectionSource(config, request).resolve(
        "jarvis:asana",
      )
    )?.value.refresh_token,
  ).toBe("");
  expect(calls).toBe(1);
  write({ ...c, status: "disconnected" });
  expect(await source.resolve("jarvis:asana")).toBeNull();
  expect(source.identity("jarvis:asana")).toBeNull();
});
test("a disconnect or reconnect during renewal cannot resurrect the previous grant", async () => {
  const c = doc();
  write(c);
  await expect(
    freshAsanaConnection(config, (async () => {
      write({ ...c, status: "disconnected" });
      return success();
    }) as unknown as typeof fetch),
  ).rejects.toThrow("changed");
  write(c);
  await expect(
    freshAsanaConnection(config, (async () => {
      write(doc());
      return success();
    }) as unknown as typeof fetch),
  ).rejects.toThrow("changed");
});
test("revocation requests reconnect, transient failures preserve the binding, renewal cannot leave hosting origin", async () => {
  const c = doc();
  write(c);
  for (const status of [404, 429, 502, 503]) {
    await expect(
      freshAsanaConnection(config, (async () =>
        Response.json(
          { error: "secret" },
          { status },
        )) as unknown as typeof fetch),
    ).rejects.toThrow("Try again");
    expect(asanaNeedsReconnect(config, c)).toBe(false);
  }
  await expect(
    freshAsanaConnection(config, (async () =>
      Response.json(
        { reconnect: true },
        { status: 409 },
      )) as unknown as typeof fetch),
  ).rejects.toThrow("Reconnect");
  expect(asanaNeedsReconnect(config, c)).toBe(true);
  write({
    ...doc(),
    refresh: { ...c.refresh, url: "https://attacker.test/refresh" },
  });
  let calls = 0;
  await expect(
    freshAsanaConnection(config, (async () => {
      calls++;
      return success();
    }) as unknown as typeof fetch),
  ).rejects.toThrow("not configured");
  expect(calls).toBe(0);
});
test("a 429 or a stale 409 uses the token another process renewed, and fails only when none is valid", async () => {
  const c = doc();
  write(c);
  const cache = join(dir, "connections/asana-access.json");
  const otherProcess = (expiresIn: number) =>
    writeFileSync(
      cache,
      JSON.stringify({
        key: asanaGrantKey(c),
        access_token: "OTHER_ACCESS",
        expires_at: new Date(Date.now() + expiresIn).toISOString(),
      }),
    );
  const replies: Array<[number, Record<string, unknown>]> = [
    [429, { error: "refreshed too recently" }],
    [409, { error: "stale refresh token; re-read the stored one" }],
  ];
  for (const [status, body] of replies) {
    rmSync(cache, { force: true });
    let calls = 0;
    const renewedElsewhere = (async () => {
      calls++;
      otherProcess(3600000);
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    const result = await freshAsanaConnection(config, renewedElsewhere);
    expect(result.access_token).toBe("OTHER_ACCESS");
    expect(result.refresh_token).toBe("PRIVATE_REFRESH");
    expect(calls).toBe(1);
    expect(asanaNeedsReconnect(config, c)).toBe(false);
    for (const prepare of [
      () => rmSync(cache, { force: true }),
      () => otherProcess(30000),
    ]) {
      prepare();
      await expect(
        freshAsanaConnection(config, (async () =>
          Response.json(body, { status })) as unknown as typeof fetch),
      ).rejects.toThrow("Try again shortly");
      expect(asanaNeedsReconnect(config, c)).toBe(false);
    }
  }
});
