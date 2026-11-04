import { notionOptions } from "./notion-options";

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
import { readNotionConnection, notionStatus } from "./notion-connection";
import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { JarvisNotionConnectionSource } from "../workflows/credentials/notion-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
let dir: string, config: any, grant: any;
const receipt = randomUUID();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notion-connection-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  };
  grant = {
    version: 1,
    provider: "notion",
    status: "connected",
    generation: randomUUID(),
    access_token: "a1",
    refresh_token: "r1",
    expires_at: new Date(Date.now() - 1000).toISOString(),
    account: { id: "u1", label: "Owner" },
    workspaces: [],
    connected_at: new Date().toISOString(),
    refresh: {
      url: "https://app.usejarvis.dev/api/integrations/notion/refresh",
      instance_id: randomUUID(),
      secret: "a".repeat(64),
    },
  };
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () =>
  createManagedRotatingRefresher("notion", "Notion", readNotionConnection);
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
  }) as unknown as unknown as typeof fetch;
}
test("empty workspaces are valid, status exposes no secrets", () => {
  expect(readNotionConnection(dir)).not.toBeNull();
  expect(notionStatus(config).connected).toBe(true);
  expect(JSON.stringify(notionStatus(config))).not.toContain("r1");
});
test("persist rotated pair before ack, survive restart, leave delivered grant untouched", async () => {
  const original = readFileSync(join(dir, "connections/notion.json"), "utf8");
  let calls = 0;
  const request = transport((body) => {
    calls++;
    if (!body.ack) {
      expect(body.refreshToken).toBe("r1");
      return rotated();
    }
    const db = new Database(join(dir, "connections/notion-renewal.sqlite"), {
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
  expect(readFileSync(join(dir, "connections/notion.json"), "utf8")).toBe(
    original,
  );
  expect(
    statSync(join(dir, "connections/notion-renewal.sqlite")).mode & 0o777,
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
  let refreshes = 0;
  const request = transport(async (body) => {
    if (body.ack) return Response.json({ acknowledged: true });
    refreshes++;
    await wait;
    return rotated();
  });
  const first = fresh().fresh(config, request);
  for (let i = 0; i < 100 && refreshes === 0; i++) await Bun.sleep(1);
  // One that cannot outlast the holder is refused, never repeated.
  const impatient = createManagedRotatingRefresher("notion", "Notion", readNotionConnection, { lockWaitMs: 150 });
  await expect(impatient.fresh(config, request)).rejects.toThrow("in progress");
  // One that waits gets the holder's stored pair, without a second rotation.
  const second = fresh().fresh(config, request);
  await Bun.sleep(20);
  release();
  const [x, y] = await Promise.all([first, second]);
  expect([x.access_token, y.access_token]).toEqual(["a2", "a2"]);
  expect(refreshes).toBe(1);
});
test("disconnect or reconnect during renewal never resurrects old credentials", async () => {
  const request = transport(() => {
    writeFileSync(
      join(dir, "connections/notion.json"),
      JSON.stringify({ ...grant, status: "disconnected" }),
    );
    return rotated();
  });
  await expect(fresh().fresh(config, request)).rejects.toThrow("changed");
  expect(readNotionConnection(dir)).toBeNull();
});
test("permanent reconnect and temporary outage remain distinct", async () => {
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ error: "outage" }, { status: 503 })),
    ),
  ).rejects.toThrow("Try again");
  expect(notionStatus(config).connected).toBe(true);
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ reconnect: true }, { status: 409 })),
    ),
  ).rejects.toThrow("Reconnect");
  expect(notionStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});
test("renewal URL cannot redirect the grant outside the configured origin", async () => {
  grant.refresh.url = "https://evil.test/api/integrations/notion/refresh";
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  let calls = 0;
  await expect(
    fresh().fresh(config, (async () => {
      calls++;
      return rotated();
    }) as unknown as unknown as typeof fetch),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
test("only the four reviewed actions may resolve the managed credential", async () => {
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  const source = new JarvisNotionConnectionSource(config, (async () =>
    Response.json({ id: "u1", type: "bot" })) as unknown as typeof fetch);
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-notion",
      "settings.input.auth",
      { actionName: "notion_get_block_children" },
    ),
  ).toBeNull();
  for (const settings of [
    { actionName: "notion_create_base" },
    { triggerName: "new_record" },
    { actionName: "notion_get_block_children", triggerName: "new_record" },
    { actionName: "custom_api_call" },
  ])
    expect(
      managedConnectionMisuse(
        source,
        "@activepieces/piece-notion",
        "settings.input.auth",
        settings,
      ),
    ).not.toBeNull();
  const result = await source.resolve("jarvis:notion");
  expect(result?.value).toMatchObject({
    access_token: "a1",
    jarvis_managed: "notion",
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
  expect(notionStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});

test("unknown expiry is checked before dispatch and a 401 renews once without inventing an expiry", async () => {
  grant.expires_at = null;
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  const calls: string[] = [];
  let renewals = 0;
  const source = new JarvisNotionConnectionSource(config, (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/users/me"))
      return new Headers(init?.headers).get("Authorization") === "Bearer a1"
        ? Response.json({ message: "PRIVATE" }, { status: 401 })
        : Response.json({ id: "u1", type: "bot" });
    expect(u).toBe(grant.refresh.url);
    const body = JSON.parse(String(init?.body));
    if (body.ack) return Response.json({ acknowledged: true });
    renewals++;
    return Response.json({
      access_token: "a2",
      refresh_token: "r2",
      expires_at: null,
      receipt,
    });
  }) as unknown as typeof fetch);
  expect((await source.resolve("jarvis:notion"))?.value).toMatchObject({
    access_token: "a2",
  });
  expect((await source.resolve("jarvis:notion"))?.value).toMatchObject({
    access_token: "a2",
  });
  expect(renewals).toBe(1);
  expect(calls.filter((u) => u.endsWith("/users/me"))).toHaveLength(3);
  const db = new Database(join(dir, "connections/notion-renewal.sqlite"), {
    readonly: true,
  });
  const saved = JSON.parse(
    (db.query("SELECT value FROM renewal").get() as any).value,
  );
  db.close();
  expect(saved.expires_at).toBeNull();
});
test("a live token with unknown expiry and temporary identity failures never rotate", async () => {
  grant.expires_at = null;
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  for (const status of [200, 429, 503]) {
    let calls = 0;
    const source = new JarvisNotionConnectionSource(config, (async (url: Parameters<typeof fetch>[0]) => {
      calls++;
      expect(String(url)).toBe("https://api.notion.com/v1/users/me");
      return Response.json({ id: "u1", type: "bot" }, { status });
    }) as unknown as typeof fetch);
    if (status === 200)
      expect((await source.resolve("jarvis:notion"))?.value).toMatchObject({
        access_token: "a1",
      });
    else await expect(source.resolve("jarvis:notion")).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
test("a mismatched bot or disconnect during identity check cannot dispatch", async () => {
  grant.expires_at = null;
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  const wrong = new JarvisNotionConnectionSource(config, (async () =>
    Response.json({
      id: "someone-else",
      type: "bot",
    })) as unknown as typeof fetch);
  await expect(wrong.resolve("jarvis:notion")).rejects.toThrow(
    "account changed",
  );
  const gone = new JarvisNotionConnectionSource(config, (async () => {
    writeFileSync(
      join(dir, "connections/notion.json"),
      JSON.stringify({ ...grant, status: "disconnected" }),
    );
    return Response.json({ id: "u1", type: "bot" });
  }) as unknown as typeof fetch);
  await expect(gone.resolve("jarvis:notion")).rejects.toThrow("changed");
});
test("page options expose bounded shared-page choices and reject stale generations", async () => {
  grant.expires_at = null;
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  const request = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).endsWith("/users/me"))
      return Response.json({ id: "u1", type: "bot" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "Notes",
      filter: { property: "object", value: "page" },
      page_size: 100,
    });
    return Response.json({
      object: "list",
      results: [
        {
          object: "page",
          id: "11111111-1111-4111-8111-111111111111",
          properties: {
            title: { type: "title", title: [{ plain_text: "Notes" }] },
          },
        },
      ],
      has_more: true,
      next_cursor: "more",
    });
  }) as unknown as typeof fetch;
  const result = await notionOptions(
    config,
    new URLSearchParams({ query: "Notes", generation: grant.generation }),
    request,
  );
  expect(result).toMatchObject({
    options: [{ name: "Notes" }],
    has_more: true,
  });
  expect(JSON.stringify(result)).not.toContain('"a1"');
  await expect(
    notionOptions(
      config,
      new URLSearchParams({ generation: "stale" }),
      request,
    ),
  ).rejects.toMatchObject({ status: 409 });
});
test("provider refusals on page options never pass Notion's own status through", async () => {
  grant.expires_at = null;
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  for (const [upstream, expected] of [[401, 409], [403, 409], [404, 409], [429, 429], [400, 502], [500, 502]] as const) {
    const request = (async (url: Parameters<typeof fetch>[0]) =>
      String(url).endsWith("/users/me")
        ? Response.json({ id: "u1", type: "bot" })
        : new Response("{}", { status: upstream })) as unknown as typeof fetch;
    await expect(
      notionOptions(config, new URLSearchParams({ query: "Notes" }), request),
    ).rejects.toMatchObject({ status: expected });
  }
});
test("a missing or invalid account page URL reads as renewal not configured, with no request", async () => {
  for (const page_url of [undefined, "", "not a url"]) {
    let calls = 0;
    await expect(
      fresh().fresh({ ...config, usejarvis_integrations: { page_url } }, (async () => {
        calls++;
        return rotated();
      }) as unknown as typeof fetch),
    ).rejects.toThrow("Notion renewal is not configured");
    expect(calls).toBe(0);
  }
});
test("unknown expiry and access checks are opt-in: without them a null expiry is never treated as live", async () => {
  grant.expires_at = null;
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  let renewals = 0;
  const request = transport((body) => {
    if (body.ack) return Response.json({ acknowledged: true });
    renewals++;
    return rotated();
  });
  // The shared default (Calendly, Airtable, Typeform): renew, as before.
  expect((await fresh().fresh(config, request)).access_token).toBe("a2");
  expect(renewals).toBe(1);
});
test("during an acknowledgement outage a token of unknown expiry is served only after the provider accepts it", async () => {
  grant.expires_at = null;
  writeFileSync(join(dir, "connections/notion.json"), JSON.stringify(grant));
  let hostingUp = true,
    renewals = 0,
    acks = 0,
    a2Valid = true;
  const request = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/users/me")) {
      const token = new Headers(init?.headers).get("Authorization");
      return token === "Bearer a2" && a2Valid
        ? Response.json({ id: "u1", type: "bot" })
        : Response.json({}, { status: 401 });
    }
    if (!hostingUp) throw new Error("hosting unreachable");
    const body = JSON.parse(String(init?.body));
    if (body.ack) {
      acks++;
      throw new Error("lost ack");
    }
    renewals++;
    return Response.json({ access_token: "a2", refresh_token: "r2", expires_at: null, receipt });
  }) as unknown as typeof fetch;
  const source = new JarvisNotionConnectionSource(config, request);
  // a1 is refused, so it renews once to a2; the acknowledgement is lost.
  expect((await source.resolve("jarvis:notion"))?.value).toMatchObject({ access_token: "a2" });
  expect([renewals, acks]).toEqual([1, 1]);
  // Hosting down: the pending ack cannot finish, but a2 is confirmed live.
  hostingUp = false;
  expect((await source.resolve("jarvis:notion"))?.value).toMatchObject({ access_token: "a2" });
  // Once Notion refuses a2, nothing is served and nothing rotates.
  a2Valid = false;
  await expect(source.resolve("jarvis:notion")).rejects.toThrow("Could not confirm");
  expect(renewals).toBe(1);
  // Unknown expiry with no way to check the token: never served.
  a2Valid = true;
  const unchecked = createManagedRotatingRefresher("notion", "Notion", readNotionConnection, { allowUnknownExpiry: true });
  await expect(unchecked.fresh(config, request)).rejects.toThrow("Could not confirm");
  expect(renewals).toBe(1);
});
