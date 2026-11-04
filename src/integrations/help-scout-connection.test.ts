import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
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
import {
  readHelpScoutConnection,
  helpScoutStatus,
} from "./help-scout-connection";
import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { JarvisHelpScoutConnectionSource } from "../workflows/credentials/help-scout-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
let dir: string, config: any, grant: any;
const receipt = randomUUID();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "help-scout-connection-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  };
  grant = {
    version: 1,
    provider: "help-scout",
    status: "connected",
    generation: randomUUID(),
    access_token: "a1",
    refresh_token: "r1",
    expires_at: new Date(Date.now() - 1000).toISOString(),
    account: { id: "123", label: "Owner" },
    workspaces: [],
    connected_at: new Date().toISOString(),
    refresh: {
      url: "https://app.usejarvis.dev/api/integrations/help-scout/refresh",
      instance_id: randomUUID(),
      secret: "a".repeat(64),
    },
  };
  writeFileSync(
    join(dir, "connections/help-scout.json"),
    JSON.stringify(grant),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () =>
  createManagedRotatingRefresher(
    "help-scout",
    "Help Scout",
    readHelpScoutConnection,
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
  expect(readHelpScoutConnection(dir)).not.toBeNull();
  expect(helpScoutStatus(config).connected).toBe(true);
  expect(JSON.stringify(helpScoutStatus(config))).not.toContain("r1");
});
test("persist rotated pair before ack, survive restart, leave delivered grant untouched", async () => {
  const original = readFileSync(
    join(dir, "connections/help-scout.json"),
    "utf8",
  );
  let calls = 0;
  const request = transport((body) => {
    calls++;
    if (!body.ack) {
      expect(body.refreshToken).toBe("r1");
      return rotated();
    }
    const db = new Database(
      join(dir, "connections/help-scout-renewal.sqlite"),
      {
        readonly: true,
      },
    );
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
  expect(readFileSync(join(dir, "connections/help-scout.json"), "utf8")).toBe(
    original,
  );
  expect(
    statSync(join(dir, "connections/help-scout-renewal.sqlite")).mode & 0o777,
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
test("a hosting outage during a pending acknowledgement keeps serving the still-valid token without rotating", async () => {
  const store = join(dir, "connections/help-scout-renewal.sqlite");
  const row = () => {
    const db = new Database(store, { readonly: true });
    try {
      return JSON.parse(
        (db.query("SELECT value FROM renewal").get() as any).value,
      );
    } finally {
      db.close();
    }
  };
  let refreshes = 0,
    acks = 0,
    hosting: "down" | "error" | "stale" | "up" = "down";
  const request = transport((body) => {
    if (!body.ack) {
      refreshes++;
      return rotated();
    }
    acks++;
    if (hosting === "down") throw new Error("hosting unreachable");
    if (hosting === "error")
      return Response.json({ error: "x" }, { status: 503 });
    if (hosting === "stale")
      return Response.json({ error: "stale" }, { status: 409 });
    return Response.json({ acknowledged: true });
  });
  // The rotation lands, its acknowledgement does not.
  expect((await fresh().fresh(config, request)).access_token).toBe("a2");
  expect(row().receipt).toBe(receipt);
  for (const state of ["down", "error"] as const) {
    hosting = state;
    const got = await fresh().fresh(config, request);
    expect([got.access_token, got.refresh_token]).toEqual(["a2", "r2"]);
    expect(row().receipt).toBe(receipt);
  }
  expect(refreshes).toBe(1);
  // A 409 without reconnect means the grant moved on: never served.
  hosting = "stale";
  await expect(fresh().fresh(config, request)).rejects.toThrow();
  // Hosting back: the pending acknowledgement completes, still no rotation.
  hosting = "up";
  expect((await fresh().fresh(config, request)).access_token).toBe("a2");
  expect(row().receipt).toBeUndefined();
  expect(refreshes).toBe(1);
  expect(acks).toBe(5);
});
test("an expired token with an unacknowledged rotation is refused, never renewed again", async () => {
  const store = join(dir, "connections/help-scout-renewal.sqlite");
  let refreshes = 0;
  const request = transport((body) => {
    if (!body.ack) {
      refreshes++;
      return rotated();
    }
    throw new Error("hosting unreachable");
  });
  await fresh().fresh(config, request);
  const db = new Database(store);
  const value = JSON.parse(
    (db.query("SELECT value FROM renewal").get() as any).value,
  );
  db.query("UPDATE renewal SET value=? WHERE id=1").run(
    JSON.stringify({
      ...value,
      expires_at: new Date(Date.now() + 30000).toISOString(),
    }),
  );
  db.close();
  await expect(fresh().fresh(config, request)).rejects.toThrow(
    "Could not confirm",
  );
  expect(refreshes).toBe(1);
});
test("a concurrent renewal in another instance waits for the first and reuses its rotation", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  let started = false,
    refreshes = 0,
    acks = 0;
  const request = transport(async (body) => {
    if (body.ack) {
      acks++;
      return Response.json({ acknowledged: true });
    }
    refreshes++;
    expect(body.refreshToken).toBe("r1");
    started = true;
    await wait;
    return rotated();
  });
  const first = fresh().fresh(config, request);
  for (let i = 0; i < 100 && !started; i++) await Bun.sleep(1);
  expect(started).toBe(true);
  // The second holds no lock yet: it waits instead of failing or refreshing.
  let settled = false;
  const second = fresh()
    .fresh(config, request)
    .finally(() => (settled = true));
  await Bun.sleep(250);
  expect(settled).toBe(false);
  release();
  const [a, b] = await Promise.all([first, second]);
  expect([a.access_token, b.access_token]).toEqual(["a2", "a2"]);
  expect([a.refresh_token, b.refresh_token]).toEqual(["r2", "r2"]);
  // One provider rotation only; the single-use r1 is never presented twice.
  expect(refreshes).toBe(1);
  expect(acks).toBeGreaterThanOrEqual(1);
  expect((await fresh().fresh(config, request)).access_token).toBe("a2");
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
  const impatient = createManagedRotatingRefresher(
    "help-scout",
    "Help Scout",
    readHelpScoutConnection,
    { lockWaitMs: 150 },
  );
  await expect(impatient.fresh(config, request)).rejects.toThrow("in progress");
  expect(refreshes).toBe(1);
  release();
  expect((await first).access_token).toBe("a2");
});
test("the renewal store is created owner-only without relying on a later chmod", async () => {
  const previous = process.umask(0o022);
  const chmod = spyOn(fs, "chmodSync").mockImplementation(() => {});
  try {
    const request = transport((body) =>
      body.ack ? Response.json({ acknowledged: true }) : rotated(),
    );
    await fresh().fresh(config, request);
  } finally {
    chmod.mockRestore();
    process.umask(previous);
  }
  const path = join(dir, "connections/help-scout-renewal.sqlite");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  // SQLite gives the rollback journal the database file's mode.
  const db = new Database(path);
  try {
    expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe(
      "delete",
    );
    // PERSIST (this connection only) keeps the journal after commit so its mode can be read.
    db.exec("PRAGMA journal_mode=PERSIST");
    expect(
      db.query("UPDATE renewal SET value=value || ' ' WHERE id=1").run()
        .changes,
    ).toBe(1);
    expect(statSync(path + "-journal").mode & 0o777).toBe(0o600);
  } finally {
    db.close();
  }
});
test("a status read never creates the renewal store", () => {
  const path = join(dir, "connections/help-scout-renewal.sqlite");
  expect(helpScoutStatus(config)).toMatchObject({
    connected: true,
    reconnect: false,
  });
  expect(
    new JarvisHelpScoutConnectionSource(config).identity("jarvis:help-scout"),
  ).not.toBeNull();
  expect(existsSync(path)).toBe(false);
});
test("disconnect or reconnect during renewal never resurrects old credentials", async () => {
  const request = transport(() => {
    writeFileSync(
      join(dir, "connections/help-scout.json"),
      JSON.stringify({ ...grant, status: "disconnected" }),
    );
    return rotated();
  });
  await expect(fresh().fresh(config, request)).rejects.toThrow("changed");
  expect(readHelpScoutConnection(dir)).toBeNull();
});
test("permanent reconnect and temporary outage remain distinct", async () => {
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ error: "outage" }, { status: 503 })),
    ),
  ).rejects.toThrow("Try again");
  expect(helpScoutStatus(config).connected).toBe(true);
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ reconnect: true }, { status: 409 })),
    ),
  ).rejects.toThrow("Reconnect");
  expect(helpScoutStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});
test("renewal URL cannot redirect the grant outside the configured origin", async () => {
  grant.refresh.url = "https://evil.test/api/integrations/help-scout/refresh";
  writeFileSync(
    join(dir, "connections/help-scout.json"),
    JSON.stringify(grant),
  );
  let calls = 0;
  await expect(
    fresh().fresh(config, (async () => {
      calls++;
      return rotated();
    }) as unknown as typeof fetch),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
test("only the three reviewed actions may resolve the managed credential", async () => {
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  writeFileSync(
    join(dir, "connections/help-scout.json"),
    JSON.stringify(grant),
  );
  const source = new JarvisHelpScoutConnectionSource(config);
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-help-scout",
      "settings.input.auth",
      { actionName: "find_customer" },
    ),
  ).toBeNull();
  for (const settings of [
    { actionName: "send_reply" },
    { triggerName: "conversation_created" },
    { actionName: "find_customer", triggerName: "conversation_created" },
    { actionName: "custom_api_call" },
  ])
    expect(
      managedConnectionMisuse(
        source,
        "@activepieces/piece-help-scout",
        "settings.input.auth",
        settings,
      ),
    ).not.toBeNull();
  const result = await source.resolve("jarvis:help-scout");
  expect(result?.value).toMatchObject({
    access_token: "a1",
    jarvis_user: "123",
    jarvis_managed: "help-scout",
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
  expect(helpScoutStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});
