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
import { Database } from "bun:sqlite";
import { readWrikeConnection, wrikeStatus } from "./wrike-connection";
import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { JarvisWrikeConnectionSource } from "../workflows/credentials/wrike-source";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "../workflows/runtime/piece-effects";
let dir: string, config: any, grant: any;
const receipt = randomUUID();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wrike-connection-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  };
  grant = {
    version: 1,
    provider: "wrike",
    status: "connected",
    generation: randomUUID(),
    access_token: "a1",
    refresh_token: "r1",
    expires_at: new Date(Date.now() - 1000).toISOString(),
    account: { id: "KUAAAAAA", label: "Owner" },
    workspaces: [{ id: "IEAAAAAA", name: "Sandbox" }],
    settings: { api_host: "app-eu.wrike.com" },
    definition: { allowedApiHosts: ["app-eu.wrike.com"] },
    connected_at: new Date().toISOString(),
    refresh: {
      url: "https://app.usejarvis.dev/api/integrations/wrike/refresh",
      instance_id: randomUUID(),
      secret: "a".repeat(64),
    },
  };
  writeFileSync(join(dir, "connections/wrike.json"), JSON.stringify(grant));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () =>
  createManagedRotatingRefresher("wrike", "Wrike", readWrikeConnection);
const rotated = () =>
  Response.json({
    access_token: "a2",
    refresh_token: "r2",
    expires_at: new Date(Date.now() + 604800000).toISOString(),
    receipt,
  });
function transport(fn: (body: any) => Response | Promise<Response>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(grant.refresh.url);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("x-jarvis-signature")).toBe(
      createHmac("sha256", grant.refresh.secret)
        .update(String(init?.body))
        .digest("hex"),
    );
    return fn(JSON.parse(String(init?.body)));
  }) as unknown as typeof fetch;
}
test("persist rotated pair before ack, survive restart, leave delivered grant untouched", async () => {
  const original = readFileSync(join(dir, "connections/wrike.json"), "utf8");
  let calls = 0;
  const request = transport((body) => {
    calls++;
    if (!body.ack) {
      expect(body.refreshToken).toBe("r1");
      return rotated();
    }
    const db = new Database(join(dir, "connections/wrike-renewal.sqlite"), {
      readonly: true,
    });
    const row = db.query("SELECT value FROM renewal").get() as any;
    db.close();
    expect(JSON.parse(row.value)).toMatchObject({
      refresh_token: "r2",
      receipt,
    });
    return Response.json({ acknowledged: true });
  });
  expect((await fresh().fresh(config, request)).access_token).toBe("a2");
  expect(calls).toBe(2);
  expect((await fresh().fresh(config, request)).refresh_token).toBe("r2");
  expect(calls).toBe(2);
  expect(readFileSync(join(dir, "connections/wrike.json"), "utf8")).toBe(
    original,
  );
  expect(
    statSync(join(dir, "connections/wrike-renewal.sqlite")).mode & 0o777,
  ).toBe(0o600);
});

test("only a host-bound grant is connected; status and engine auth keep refresh secrets private", async () => {
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  const save = () =>
    writeFileSync(join(dir, "connections/wrike.json"), JSON.stringify(grant));
  save();
  expect(wrikeStatus(config)).toMatchObject({
    connected: true,
    external_id: "jarvis:wrike",
  });
  expect(JSON.stringify(wrikeStatus(config))).not.toContain("r1");
  const source = new JarvisWrikeConnectionSource(config);
  const value = await source.resolve("jarvis:wrike");
  expect(value).toMatchObject({
    type: "OAUTH2",
    value: {
      access_token: "a1",
      api_host: "app-eu.wrike.com",
      jarvis_managed: "wrike",
      refresh_token: "",
    },
  });
  expect(JSON.stringify(value)).not.toContain(grant.refresh.secret);
  expect(await source.resolve("jarvis:linear")).toBeNull();
  const identity = source.identity("jarvis:wrike");
  grant.generation = randomUUID();
  save();
  expect(source.identity("jarvis:wrike")).not.toBe(identity);
  grant.settings.api_host = "evil.test";
  save();
  expect(readWrikeConnection(dir)).toBeNull();
  grant.settings.api_host = "www.wrike.com";
  save();
  expect(readWrikeConnection(dir)).toBeNull();
});
test("managed scope rejects another piece and unqualified Wrike actions", async () => {
  const source = new JarvisWrikeConnectionSource(config);
  expect(source.pieceDetails["@activepieces/piece-wrike"].actions).toEqual([
    "find_task",
    "create_task",
    "update_task",
    "add_comment",
  ]);
  expect(
    resolveGovernedPieceAction("@activepieces/piece-wrike", "find_task")
      ?.category,
  ).toBe("read_data");
  expect(
    tracksPieceCompletion("@activepieces/piece-wrike", "create_task"),
  ).toBe(true);
});
