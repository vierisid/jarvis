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
import { readMondayConnection, mondayStatus } from "./monday-connection";
import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { JarvisMondayConnectionSource } from "../workflows/credentials/monday-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
let dir: string, config: any, grant: any;
const receipt = randomUUID();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "monday-connection-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  };
  grant = {
    version: 1,
    provider: "monday",
    status: "connected",
    generation: randomUUID(),
    access_token: "a1",
    refresh_token: "r1",
    expires_at: new Date(Date.now() - 1000).toISOString(),
    account: { id: "123:456", label: "Owner" },
    workspaces: [],
    connected_at: new Date().toISOString(),
    refresh: {
      url: "https://app.usejarvis.dev/api/integrations/monday/refresh",
      instance_id: randomUUID(),
      secret: "a".repeat(64),
    },
  };
  writeFileSync(join(dir, "connections/monday.json"), JSON.stringify(grant));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () =>
  createManagedRotatingRefresher("monday", "monday.com", readMondayConnection);
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
  expect(readMondayConnection(dir)).not.toBeNull();
  expect(mondayStatus(config).connected).toBe(true);
  expect(JSON.stringify(mondayStatus(config))).not.toContain("r1");
});
test("persist rotated pair before ack, survive restart, leave delivered grant untouched", async () => {
  const original = readFileSync(join(dir, "connections/monday.json"), "utf8");
  let calls = 0;
  const request = transport((body) => {
    calls++;
    if (!body.ack) {
      expect(body.refreshToken).toBe("r1");
      return rotated();
    }
    const db = new Database(join(dir, "connections/monday-renewal.sqlite"), {
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
  expect(readFileSync(join(dir, "connections/monday.json"), "utf8")).toBe(
    original,
  );
  expect(
    statSync(join(dir, "connections/monday-renewal.sqlite")).mode & 0o777,
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
test("a concurrent renewal in another instance waits for the first and reuses its rotation", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  let started = false,
    refreshes = 0;
  const request = transport(async (body) => {
    if (body.ack) return Response.json({ acknowledged: true });
    refreshes++;
    expect(body.refreshToken).toBe("r1");
    started = true;
    await wait;
    return rotated();
  });
  const first = fresh().fresh(config, request);
  for (let i = 0; i < 100 && !started; i++) await Bun.sleep(1);
  expect(started).toBe(true);
  // The second instance waits for the lock instead of failing or refreshing.
  let settled = false;
  const second = fresh()
    .fresh(config, request)
    .finally(() => (settled = true));
  await Bun.sleep(250);
  expect(settled).toBe(false);
  release();
  const [x, y] = await Promise.all([first, second]);
  expect([x.access_token, y.access_token]).toEqual(["a2", "a2"]);
  expect([x.refresh_token, y.refresh_token]).toEqual(["r2", "r2"]);
  // One provider rotation only: the single-use r1 is never presented twice.
  expect(refreshes).toBe(1);
});
test("a renewal that outlasts the wait is refused, never repeated", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  let refreshes = 0;
  const request = transport(async (body) => {
    if (body.ack) return Response.json({ acknowledged: true });
    refreshes++;
    await wait;
    return rotated();
  });
  const first = fresh().fresh(config, request);
  for (let i = 0; i < 100 && refreshes === 0; i++) await Bun.sleep(1);
  const impatient = createManagedRotatingRefresher("monday", "monday.com", readMondayConnection, { lockWaitMs: 150 });
  await expect(impatient.fresh(config, request)).rejects.toThrow("in progress");
  expect(refreshes).toBe(1);
  release();
  expect((await first).access_token).toBe("a2");
});
test("disconnect or reconnect during renewal never resurrects old credentials", async () => {
  const request = transport(() => {
    writeFileSync(
      join(dir, "connections/monday.json"),
      JSON.stringify({ ...grant, status: "disconnected" }),
    );
    return rotated();
  });
  await expect(fresh().fresh(config, request)).rejects.toThrow("changed");
  expect(readMondayConnection(dir)).toBeNull();
});
test("permanent reconnect and temporary outage remain distinct", async () => {
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ error: "outage" }, { status: 503 })),
    ),
  ).rejects.toThrow("Try again");
  expect(mondayStatus(config).connected).toBe(true);
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ reconnect: true }, { status: 409 })),
    ),
  ).rejects.toThrow("Reconnect");
  expect(mondayStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});
test("renewal URL cannot redirect the grant outside the configured origin", async () => {
  grant.refresh.url = "https://evil.test/api/integrations/monday/refresh";
  writeFileSync(join(dir, "connections/monday.json"), JSON.stringify(grant));
  let calls = 0;
  await expect(
    fresh().fresh(config, (async () => {
      calls++;
      return rotated();
    }) as unknown as typeof fetch),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
test("only the five reviewed actions may resolve the managed credential", async () => {
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  writeFileSync(join(dir, "connections/monday.json"), JSON.stringify(grant));
  const source = new JarvisMondayConnectionSource(config);
  expect(source.pieceDetails["@activepieces/piece-monday"].apiHosts).toEqual([
    "api.monday.com",
  ]);
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-monday",
      "settings.input.auth",
      { actionName: "monday_get_item_column_values" },
    ),
  ).toBeNull();
  for (const settings of [
    { actionName: "monday_create_column" },
    { triggerName: "new_item_in_board" },
    {
      actionName: "monday_get_item_column_values",
      triggerName: "new_item_in_board",
    },
    { actionName: "custom_api_call" },
  ])
    expect(
      managedConnectionMisuse(
        source,
        "@activepieces/piece-monday",
        "settings.input.auth",
        settings,
      ),
    ).not.toBeNull();
  const result = await source.resolve("jarvis:monday");
  expect(result?.value).toMatchObject({
    secret_text: "a1",
    jarvis_managed: "monday",
  });
  expect(JSON.stringify(result)).not.toContain("r1");
});

test("expired delivery receipt asks for reconnect instead of repeating acknowledgements forever", async () => {
  let ackCount = 0;
  const request = transport((body) => {
    if (!body.ack) return rotated();
    ackCount++;
    return ackCount === 1
      ? Response.json({ error: "temporary" }, { status: 503 })
      : Response.json({ reconnect: true }, { status: 409 });
  });
  await fresh().fresh(config, request);
  await expect(fresh().fresh(config, request)).rejects.toThrow("Reconnect");
  expect(mondayStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});

test("board and group choices use the renewed grant and validate pagination", async () => {
  const { mondayOptions } = await import("./monday-options");
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  writeFileSync(join(dir, "connections/monday.json"), JSON.stringify(grant));
  const request = (async (url: any, init: any) => {
    expect(String(url)).toBe("https://api.monday.com/v2");
    expect(new Headers(init.headers).get("authorization")).toBe("a1");
    const body = JSON.parse(init.body);
    if (body.query.includes("JarvisBoards")) {
      expect(body.variables.page).toBe(2);
      return Response.json({ data: { boards: [{ id: "123", name: "Work" }] } });
    }
    return Response.json({
      data: {
        boards: [
          {
            id: "123",
            name: "Work",
            groups: [{ id: "topics", title: "Tasks" }],
            columns: [],
          },
        ],
      },
    });
  }) as typeof fetch;
  expect(await mondayOptions(config, "boards", null, "2", request)).toEqual({
    options: [{ value: "123", label: "Work" }],
    next_cursor: null,
  });
  expect(await mondayOptions(config, "groups", "123", null, request)).toEqual({
    options: [{ value: "topics", label: "Tasks" }],
    next_cursor: null,
  });
  expect(await mondayOptions(config, "groups", null, null, request)).toEqual({
    options: [],
    next_cursor: null,
  });
  // Caller mistakes are input errors (the route answers 400), never sent anywhere.
  const { MondayOptionsInputError } = await import("./monday-options");
  for (const [kind, board, cursor] of [
    ["boards", null, "https://evil.test"],
    ["groups", "wrong", null],
    ["groups", "123", "2"],
  ] as const)
    await expect(
      mondayOptions(config, kind, board, cursor, request),
    ).rejects.toBeInstanceOf(MondayOptionsInputError);
  // A provider failure is not (the route answers 502).
  const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  const failure = await mondayOptions(config, "boards", null, null, failing).catch((e) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(MondayOptionsInputError);
});
