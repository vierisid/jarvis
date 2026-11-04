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
import {
  readPipedriveConnection,
  pipedriveStatus,
} from "./pipedrive-connection";
import {
  freshPipedriveConnection,
  pipedriveNeedsReconnect,
} from "./pipedrive-refresh";
import { JarvisPipedriveConnectionSource } from "../workflows/credentials/pipedrive-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
let dir: string, config: JarvisConfig;
const doc = () => ({
  version: 1 as const,
  provider: "pipedrive" as const,
  status: "connected" as const,
  generation: randomUUID(),
  access_token: "OLD_ACCESS",
  refresh_token: "PRIVATE_REFRESH",
  expires_at: new Date(0).toISOString(),
  account: { id: "123:1234", label: "owner@example.test" },
  workspaces: [{ id: "123", name: "Jarvis sandbox" }],
  settings: { api_host: "sandbox.pipedrive.com", company_id: "123" },
  definition: { allowedApiHosts: ["sandbox.pipedrive.com"] },
  connected_at: new Date().toISOString(),
  refresh: {
    url: "https://app.usejarvis.dev/api/integrations/pipedrive/refresh",
    instance_id: randomUUID(),
    secret: "a".repeat(64),
  },
});
const write = (v: unknown) =>
  writeFileSync(join(dir, "connections/pipedrive.json"), JSON.stringify(v));
const success = () =>
  Response.json({
    access_token: "NEW_ACCESS",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipedrive-unit-"));
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
  const source = new JarvisPipedriveConnectionSource(config);
  expect(pipedriveStatus(config)).toMatchObject({
    connected: true,
    connect_url: "https://app.usejarvis.dev/account?integration=pipedrive",
  });
  expect(JSON.stringify(pipedriveStatus(config))).not.toMatch(
    /OLD_ACCESS|PRIVATE_REFRESH|aaaaaaa/,
  );
  for (const action of [
    "custom_api_call",
    "delete-person",
    "new_person",
    "find-person",
    "list-deals",
  ])
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
      { actionName: "get-person" },
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
    { ...c, settings: { ...c.settings, api_host: "attacker.test" } },
    { ...c, definition: { allowedApiHosts: ["*.pipedrive.com"] } },
    { ...c, account: { ...c.account, id: "999:1234" } },
  ]) {
    write(bad);
    expect(readPipedriveConnection(dir)).toBeNull();
  }
  writeFileSync(join(dir, "connections/pipedrive.json"), "x".repeat(65537));
  expect(readPipedriveConnection(dir)).toBeNull();
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
  const source = new JarvisPipedriveConnectionSource(config, request),
    identity = source.identity("jarvis:pipedrive");
  const results = await Promise.all(
    Array.from({ length: 8 }, () => source.resolve("jarvis:pipedrive")),
  );
  expect(calls).toBe(1);
  expect(results.every((x) => x?.value.access_token === "NEW_ACCESS")).toBe(
    true,
  );
  expect(source.identity("jarvis:pipedrive")).toBe(identity);
  expect(readFileSync(join(dir, "connections/pipedrive.json"), "utf8")).toBe(
    JSON.stringify(c),
  );
  expect(
    statSync(join(dir, "connections/pipedrive-access.json")).mode & 0o777,
  ).toBe(0o600);
  expect(
    (
      await new JarvisPipedriveConnectionSource(config, request).resolve(
        "jarvis:pipedrive",
      )
    )?.value.refresh_token,
  ).toBe("");
  expect(calls).toBe(1);
  write({ ...c, status: "disconnected" });
  expect(await source.resolve("jarvis:pipedrive")).toBeNull();
  expect(source.identity("jarvis:pipedrive")).toBeNull();
});
test("a disconnect or reconnect during renewal cannot resurrect the previous grant", async () => {
  const c = doc();
  write(c);
  await expect(
    freshPipedriveConnection(config, (async () => {
      write({ ...c, status: "disconnected" });
      return success();
    }) as unknown as typeof fetch),
  ).rejects.toThrow("changed");
  write(c);
  await expect(
    freshPipedriveConnection(config, (async () => {
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
      freshPipedriveConnection(config, (async () =>
        Response.json(
          { error: "secret" },
          { status },
        )) as unknown as typeof fetch),
    ).rejects.toThrow("Try again");
    expect(pipedriveNeedsReconnect(config, c)).toBe(false);
  }
  await expect(
    freshPipedriveConnection(config, (async () =>
      Response.json(
        { reconnect: true },
        { status: 409 },
      )) as unknown as typeof fetch),
  ).rejects.toThrow("Reconnect");
  expect(pipedriveNeedsReconnect(config, c)).toBe(true);
  // The Brief reads this status directly, so a revoked grant must not show as connected there.
  expect(pipedriveStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
  write({
    ...doc(),
    refresh: { ...c.refresh, url: "https://attacker.test/refresh" },
  });
  let calls = 0;
  await expect(
    freshPipedriveConnection(config, (async () => {
      calls++;
      return success();
    }) as unknown as typeof fetch),
  ).rejects.toThrow("not configured");
  expect(calls).toBe(0);
});
