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
import { readTypeformConnection, typeformStatus } from "./typeform-connection";
import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { JarvisTypeformConnectionSource } from "../workflows/credentials/typeform-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
import { MANAGED_PIECE_ADAPTERS, resolveGovernedPieceAction } from "../workflows/runtime/piece-effects";
import { MANAGED_TYPEFORM_ACTIONS } from "../workflows/runtime/managed-typeform";
let dir: string, config: any, grant: any;
const receipt = randomUUID();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "typeform-connection-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  };
  grant = {
    version: 1,
    provider: "typeform",
    status: "connected",
    generation: randomUUID(),
    access_token: "a1",
    refresh_token: "r1",
    expires_at: new Date(Date.now() - 1000).toISOString(),
    account: { id: "u1", label: "Owner" },
    workspaces: [],
    connected_at: new Date().toISOString(),
    refresh: {
      url: "https://app.usejarvis.dev/api/integrations/typeform/refresh",
      instance_id: randomUUID(),
      secret: "a".repeat(64),
    },
  };
  writeFileSync(join(dir, "connections/typeform.json"), JSON.stringify(grant));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () =>
  createManagedRotatingRefresher(
    "typeform",
    "Typeform",
    readTypeformConnection,
  );
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
test("empty workspaces are valid, status exposes no secrets", () => {
  expect(readTypeformConnection(dir)).not.toBeNull();
  expect(typeformStatus(config).connected).toBe(true);
  expect(JSON.stringify(typeformStatus(config))).not.toContain("r1");
});
test("persist rotated pair before ack, survive restart, leave delivered grant untouched", async () => {
  const original = readFileSync(join(dir, "connections/typeform.json"), "utf8");
  let calls = 0;
  const request = transport((body) => {
    calls++;
    if (!body.ack) {
      expect(body.refreshToken).toBe("r1");
      return rotated();
    }
    const db = new Database(join(dir, "connections/typeform-renewal.sqlite"), {
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
  expect(readFileSync(join(dir, "connections/typeform.json"), "utf8")).toBe(
    original,
  );
  expect(
    statSync(join(dir, "connections/typeform-renewal.sqlite")).mode & 0o777,
  ).toBe(0o600);
});
test("lost ack is retried from durable storage without another provider refresh", async () => {
  let refreshes = 0,
    acks = 0;
  const request = transport((body) => {
    if (!body.ack) {
      refreshes++;
      return rotated();
    }
    acks++;
    if (acks === 1) throw new Error("lost ack");
    return Response.json({ acknowledged: true });
  });
  await fresh().fresh(config, request);
  expect((await fresh().fresh(config, request)).refresh_token).toBe("r2");
  expect(refreshes).toBe(1);
  expect(acks).toBe(2);
});
test("two independent refresher instances cannot overwrite each other's rotation", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  let started = false;
  const request = transport(async (body) => {
    if (body.ack) return Response.json({ acknowledged: true });
    started = true;
    await wait;
    return rotated();
  });
  const first = fresh().fresh(config, request);
  for (let i = 0; i < 100 && !started; i++) await Bun.sleep(1);
  await expect(fresh().fresh(config, request)).rejects.toThrow("in progress");
  release();
  await first;
  expect((await fresh().fresh(config, request)).access_token).toBe("a2");
});
test("disconnect or reconnect during renewal never resurrects old credentials", async () => {
  const request = transport(() => {
    writeFileSync(
      join(dir, "connections/typeform.json"),
      JSON.stringify({ ...grant, status: "disconnected" }),
    );
    return rotated();
  });
  await expect(fresh().fresh(config, request)).rejects.toThrow("changed");
  expect(readTypeformConnection(dir)).toBeNull();
});
test("permanent reconnect and temporary outage remain distinct", async () => {
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ error: "outage" }, { status: 503 })),
    ),
  ).rejects.toThrow("Try again");
  expect(typeformStatus(config).connected).toBe(true);
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ reconnect: true }, { status: 409 })),
    ),
  ).rejects.toThrow("Reconnect");
  expect(typeformStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});
test("renewal URL cannot redirect the grant outside the configured origin", async () => {
  grant.refresh.url = "https://evil.test/api/integrations/typeform/refresh";
  writeFileSync(join(dir, "connections/typeform.json"), JSON.stringify(grant));
  let calls = 0;
  await expect(
    fresh().fresh(config, (async () => {
      calls++;
      return rotated();
    }) as unknown as typeof fetch),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
test("only the four reviewed actions may resolve the managed credential", async () => {
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  writeFileSync(join(dir, "connections/typeform.json"), JSON.stringify(grant));
  const source = new JarvisTypeformConnectionSource(config);
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-typeform",
      "settings.input.auth",
      { actionName: "get_form" },
    ),
  ).toBeNull();
  for (const settings of [
    { actionName: "create_form" },
    { triggerName: "new_submission" },
    { actionName: "get_form", triggerName: "new_submission" },
    { actionName: "custom_api_call" },
  ])
    expect(
      managedConnectionMisuse(
        source,
        "@activepieces/piece-typeform",
        "settings.input.auth",
        settings,
      ),
    ).not.toBeNull();
  const result = await source.resolve("jarvis:typeform");
  expect(result?.value).toMatchObject({
    access_token: "a1",
    refresh_token: "",
    jarvis_managed: "typeform",
  });
  expect(JSON.stringify(result)).not.toContain("r1");
});

test("expired delivery receipt asks for reconnect instead of repeating acknowledgements forever", async () => {
  let ackCount=0;
  const request=transport(body=>{if(!body.ack)return rotated();ackCount++;return ackCount===1 ? Response.json({error:"temporary"},{status:503}) : Response.json({reconnect:true},{status:409});});
  await fresh().fresh(config,request);
  await expect(fresh().fresh(config,request)).rejects.toThrow("Reconnect");
  expect(typeformStatus(config)).toMatchObject({connected:false,reconnect:true});
});

test("an unacknowledged rotation keeps serving its valid access token while hosting is unavailable", async () => {
  let acks = 0, renewals = 0;
  const down = transport(body => { if (body.ack) { acks++; return Response.json({error:"unavailable"}, {status:503}); } renewals++; return rotated(); });
  await fresh().fresh(config, down);
  const second = await fresh().fresh(config, down);
  expect(second.access_token).toBe("a2");
  expect(renewals).toBe(1);
  expect(acks).toBe(2);
  // The receipt is still pending, so a later call acknowledges it before anything else.
  const up = transport(body => body.ack ? Response.json({acknowledged:true}) : rotated());
  expect((await fresh().fresh(config, up)).access_token).toBe("a2");
  const thrown = transport(() => { throw new Error("offline"); });
  expect((await fresh().fresh(config, thrown)).access_token).toBe("a2");
});

/** Every action of the pinned @activepieces/piece-typeform 0.7.1 bundle, read from
 * its `actions()` (custom_api_call is added by the framework and stays unmapped). */
const TYPEFORM_071_ACTIONS = [
  "get_me", "list_forms", "get_form", "create_form", "update_form", "replace_form", "duplicate_form",
  "update_choice_options", "delete_form", "get_form_messages", "update_form_messages", "list_responses",
  "delete_responses", "list_workspaces", "get_workspace", "create_workspace", "update_workspace",
  "delete_workspace", "list_themes", "get_theme", "create_theme", "update_theme", "delete_theme",
  "list_images", "get_image", "upload_image", "delete_image",
];
test("the Typeform adapter names every action of the pinned bundle, and nothing else", () => {
  const piece = "@activepieces/piece-typeform";
  const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === piece)!;
  const mapped = Object.values(adapter.categories).flat() as string[];
  expect(TYPEFORM_071_ACTIONS).toHaveLength(27);
  expect([...mapped].sort()).toEqual([...TYPEFORM_071_ACTIONS].sort());
  expect(resolveGovernedPieceAction(piece, "custom_api_call")).toMatchObject({ category: "modify_settings", known: false });
  for (const action of MANAGED_TYPEFORM_ACTIONS) {
    expect(TYPEFORM_071_ACTIONS).toContain(action);
    expect(resolveGovernedPieceAction(piece, action)).toMatchObject({ category: "read_data", known: true });
  }
});
