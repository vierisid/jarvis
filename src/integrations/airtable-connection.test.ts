import { airtableOptions } from "./airtable-options";
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
import { readAirtableConnection, airtableStatus } from "./airtable-connection";
import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { JarvisAirtableConnectionSource } from "../workflows/credentials/airtable-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
let dir: string, config: any, grant: any;
const receipt = randomUUID();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "airtable-connection-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  };
  grant = {
    version: 1,
    provider: "airtable",
    status: "connected",
    generation: randomUUID(),
    access_token: "a1",
    refresh_token: "r1",
    expires_at: new Date(Date.now() - 1000).toISOString(),
    account: { id: "u1", label: "Owner" },
    workspaces: [],
    connected_at: new Date().toISOString(),
    refresh: {
      url: "https://app.usejarvis.dev/api/integrations/airtable/refresh",
      instance_id: randomUUID(),
      secret: "a".repeat(64),
    },
  };
  writeFileSync(join(dir, "connections/airtable.json"), JSON.stringify(grant));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () =>
  createManagedRotatingRefresher(
    "airtable",
    "Airtable",
    readAirtableConnection,
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
  expect(readAirtableConnection(dir)).not.toBeNull();
  expect(airtableStatus(config).connected).toBe(true);
  expect(JSON.stringify(airtableStatus(config))).not.toContain("r1");
});
test("persist rotated pair before ack, survive restart, leave delivered grant untouched", async () => {
  const original = readFileSync(join(dir, "connections/airtable.json"), "utf8");
  let calls = 0;
  const request = transport((body) => {
    calls++;
    if (!body.ack) {
      expect(body.refreshToken).toBe("r1");
      return rotated();
    }
    const db = new Database(join(dir, "connections/airtable-renewal.sqlite"), {
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
  expect(readFileSync(join(dir, "connections/airtable.json"), "utf8")).toBe(
    original,
  );
  expect(
    statSync(join(dir, "connections/airtable-renewal.sqlite")).mode & 0o777,
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
      join(dir, "connections/airtable.json"),
      JSON.stringify({ ...grant, status: "disconnected" }),
    );
    return rotated();
  });
  await expect(fresh().fresh(config, request)).rejects.toThrow("changed");
  expect(readAirtableConnection(dir)).toBeNull();
});
test("permanent reconnect and temporary outage remain distinct", async () => {
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ error: "outage" }, { status: 503 })),
    ),
  ).rejects.toThrow("Try again");
  expect(airtableStatus(config).connected).toBe(true);
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ reconnect: true }, { status: 409 })),
    ),
  ).rejects.toThrow("Reconnect");
  expect(airtableStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});
test("renewal URL cannot redirect the grant outside the configured origin", async () => {
  grant.refresh.url = "https://evil.test/api/integrations/airtable/refresh";
  writeFileSync(join(dir, "connections/airtable.json"), JSON.stringify(grant));
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
  writeFileSync(join(dir, "connections/airtable.json"), JSON.stringify(grant));
  const source = new JarvisAirtableConnectionSource(config);
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-airtable",
      "settings.input.auth",
      { actionName: "get_record" },
    ),
  ).toBeNull();
  for (const settings of [
    { actionName: "airtable_create_base" },
    { triggerName: "new_record" },
    { actionName: "get_record", triggerName: "new_record" },
    { actionName: "custom_api_call" },
  ])
    expect(
      managedConnectionMisuse(
        source,
        "@activepieces/piece-airtable",
        "settings.input.auth",
        settings,
      ),
    ).not.toBeNull();
  const result = await source.resolve("jarvis:airtable");
  expect(result?.value).toMatchObject({
    secret_text: "a1",
    jarvis_managed: "airtable",
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
  expect(airtableStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});

test("base choices paginate with encoded cursors, fresh credentials and generation fences", async () => {
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  writeFileSync(join(dir, "connections/airtable.json"), JSON.stringify(grant));
  const calls: string[] = [];
  const request = (async (url, init) => {
    calls.push(String(url));
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer a1");
    return Response.json({
      bases: [{ id: "appAAAAAAAAAAAAAA", name: "Sandbox" }],
      ...(calls.length === 1 ? { offset: "cursor/next" } : {}),
    });
  }) as typeof fetch;
  const result = await airtableOptions(config, new URLSearchParams(), request);
  expect(result.options).toHaveLength(2);
  expect(calls[1]).toBe(
    "https://api.airtable.com/v0/meta/bases?offset=cursor%2Fnext",
  );
  expect(JSON.stringify(result)).not.toContain("a1");
  await expect(
    airtableOptions(config, new URLSearchParams({ base: "../evil" }), request),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    airtableOptions(
      config,
      new URLSearchParams({ generation: "stale" }),
      request,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    airtableOptions(config, new URLSearchParams(), (async () => {
      writeFileSync(
        join(dir, "connections/airtable.json"),
        JSON.stringify({ ...grant, generation: randomUUID() }),
      );
      return Response.json({ bases: [] });
    }) as unknown as typeof fetch),
  ).rejects.toMatchObject({ status: 409 });
});
test("schema choices return fields and views without leaking credentials; rate limits are actionable", async () => {
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  writeFileSync(join(dir, "connections/airtable.json"), JSON.stringify(grant));
  const result = await airtableOptions(
    config,
    new URLSearchParams({ base: "appAAAAAAAAAAAAAA" }),
    (async (url) => {
      expect(String(url)).toBe(
        "https://api.airtable.com/v0/meta/bases/appAAAAAAAAAAAAAA/tables",
      );
      return Response.json({
        tables: [
          {
            id: "tblAAAAAAAAAAAAAA",
            name: "Tasks",
            fields: [
              { id: "fldAAAAAAAAAAAAAA", name: "Name", type: "singleLineText" },
            ],
            views: [],
          },
        ],
      });
    }) as typeof fetch,
  );
  expect(result.tables).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("a1");
  await expect(
    airtableOptions(config, new URLSearchParams(), (async () =>
      Response.json(
        { secret: "PRIVATE" },
        { status: 429 },
      )) as unknown as typeof fetch),
  ).rejects.toMatchObject({ status: 429 });
});
