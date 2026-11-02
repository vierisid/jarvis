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
import { readLinearConnection, linearStatus } from "./linear-connection";
import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { JarvisLinearConnectionSource } from "../workflows/credentials/linear-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
import {
  MANAGED_PIECE_ADAPTERS,
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "../workflows/runtime/piece-effects";
let dir: string, config: any, grant: any;
const receipt = randomUUID();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "linear-connection-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  };
  grant = {
    version: 1,
    provider: "linear",
    status: "connected",
    generation: randomUUID(),
    access_token: "a1",
    refresh_token: "r1",
    expires_at: new Date(Date.now() - 1000).toISOString(),
    account: { id: "11111111-1111-4111-8111-111111111111", label: "Owner" },
    workspaces: [],
    connected_at: new Date().toISOString(),
    refresh: {
      url: "https://app.usejarvis.dev/api/integrations/linear/refresh",
      instance_id: randomUUID(),
      secret: "a".repeat(64),
    },
  };
  writeFileSync(join(dir, "connections/linear.json"), JSON.stringify(grant));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () =>
  createManagedRotatingRefresher("linear", "Linear", readLinearConnection);
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
  expect(readLinearConnection(dir)).not.toBeNull();
  expect(linearStatus(config).connected).toBe(true);
  expect(JSON.stringify(linearStatus(config))).not.toContain("r1");
});
test("persist rotated pair before ack, survive restart, leave delivered grant untouched", async () => {
  const original = readFileSync(join(dir, "connections/linear.json"), "utf8");
  let calls = 0;
  const request = transport((body) => {
    calls++;
    if (!body.ack) {
      expect(body.refreshToken).toBe("r1");
      return rotated();
    }
    const db = new Database(join(dir, "connections/linear-renewal.sqlite"), {
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
  expect(readFileSync(join(dir, "connections/linear.json"), "utf8")).toBe(
    original,
  );
  expect(
    statSync(join(dir, "connections/linear-renewal.sqlite")).mode & 0o777,
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
  const impatient = createManagedRotatingRefresher("linear", "Linear", readLinearConnection, { lockWaitMs: 150 });
  await expect(impatient.fresh(config, request)).rejects.toThrow("in progress");
  expect(refreshes).toBe(1);
  release();
  expect((await first).access_token).toBe("a2");
});
test("disconnect or reconnect during renewal never resurrects old credentials", async () => {
  const request = transport(() => {
    writeFileSync(
      join(dir, "connections/linear.json"),
      JSON.stringify({ ...grant, status: "disconnected" }),
    );
    return rotated();
  });
  await expect(fresh().fresh(config, request)).rejects.toThrow("changed");
  expect(readLinearConnection(dir)).toBeNull();
});
test("permanent reconnect and temporary outage remain distinct", async () => {
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ error: "outage" }, { status: 503 })),
    ),
  ).rejects.toThrow("Try again");
  expect(linearStatus(config).connected).toBe(true);
  await expect(
    fresh().fresh(
      config,
      transport(() => Response.json({ reconnect: true }, { status: 409 })),
    ),
  ).rejects.toThrow("Reconnect");
  expect(linearStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});
test("renewal URL cannot redirect the grant outside the configured origin", async () => {
  grant.refresh.url = "https://evil.test/api/integrations/linear/refresh";
  writeFileSync(join(dir, "connections/linear.json"), JSON.stringify(grant));
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
  writeFileSync(join(dir, "connections/linear.json"), JSON.stringify(grant));
  const source = new JarvisLinearConnectionSource(config);
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-linear",
      "settings.input.auth",
      { actionName: "linear_get_issue" },
    ),
  ).toBeNull();
  for (const settings of [
    { actionName: "linear_delete_issue" },
    { triggerName: "linear_issue_created" },
    { actionName: "linear_get_issue", triggerName: "linear_issue_created" },
    { actionName: "custom_api_call" },
  ])
    expect(
      managedConnectionMisuse(
        source,
        "@activepieces/piece-linear",
        "settings.input.auth",
        settings,
      ),
    ).not.toBeNull();
  const result = await source.resolve("jarvis:linear");
  expect(result?.value).toMatchObject({
    secret_text: "a1",
    jarvis_managed: "linear",
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
  expect(linearStatus(config)).toMatchObject({
    connected: false,
    reconnect: true,
  });
});

test("team choices use the current grant and preserve page cursors without exposing tokens", async () => {
  const { linearTeamOptions, LinearOptionsInputError } = await import("./linear-options");
  grant.expires_at = new Date(Date.now() + 3600000).toISOString();
  writeFileSync(join(dir, "connections/linear.json"), JSON.stringify(grant));
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.linear.app/graphql");
    expect(JSON.parse(String(init?.body)).variables).toEqual({
      after: "opaque+/=",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer a1");
    return Response.json({
      data: {
        teams: {
          nodes: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Engineering",
              key: "ENG",
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
      },
    });
  }) as unknown as typeof fetch;
  expect(await linearTeamOptions(config, "opaque+/=", request)).toEqual({
    options: [
      {
        value: "22222222-2222-4222-8222-222222222222",
        label: "Engineering (ENG)",
      },
    ],
    next_cursor: "next",
  });
  await expect(
    linearTeamOptions(config, "x".repeat(2049), request),
  ).rejects.toBeInstanceOf(LinearOptionsInputError);
  writeFileSync(
    join(dir, "connections/linear.json"),
    JSON.stringify({ ...grant, status: "disconnected" }),
  );
  const missing = linearTeamOptions(config, null, request);
  await expect(missing).rejects.toThrow("Connect Linear");
  await expect(missing).rejects.not.toBeInstanceOf(LinearOptionsInputError);
});

const LINEAR = "@activepieces/piece-linear";
/** Every action of the pinned @activepieces/piece-linear 0.9.1 bundle, keyed by
 * the `classification` upstream gives it. The engine test checks the installed
 * package against the adapter too. */
const LINEAR_091_BY_UPSTREAM: Record<string, string[]> = {
  READ: [
    "linear_get_issue", "linear_issue_get", "linear_team_get", "linear_viewer_get", "linear_comment_get",
    "linear_attachment_get", "linear_upload_download", "linear_project_get", "linear_project_status_update_get",
  ],
  SEARCH: [
    "linear_search_issues", "linear_issues_list", "linear_issues_search", "linear_issue_labels_list",
    "linear_workflow_states_list", "linear_teams_list", "linear_users_list", "linear_cycles_list",
    "linear_comments_list", "linear_projects_list", "linear_project_status_updates_list",
  ],
  WRITE: [
    "linear_create_issue", "linear_update_issue", "linear_create_project", "linear_update_project",
    "linear_create_comment", "linear_add_label_to_issue", "linear_remove_label_from_issue", "linear_attach_link",
    "linear_create_project_status_update", "linear_issue_create", "linear_issue_update", "linear_issue_unarchive",
    "linear_issue_relation_create", "linear_issue_add_label", "linear_issue_remove_label", "linear_issue_label_create",
    "linear_team_create", "linear_team_update", "linear_comment_create", "linear_comment_update",
    "linear_comment_resolve", "linear_comment_unresolve", "linear_comment_reaction_create", "linear_attachment_create",
    "linear_project_create", "linear_project_update", "linear_project_unarchive", "linear_project_milestone_create",
    "linear_project_status_update_create", "linear_project_status_update_edit", "linear_project_status_update_unarchive",
  ],
  DESTRUCTIVE: [
    "linear_delete_issue", "linear_issue_archive", "linear_issue_delete", "linear_reaction_delete",
    "linear_project_delete", "linear_project_status_update_archive",
  ],
};
/** Where Jarvis departs from upstream's label: messages to people, and team settings. */
const SENDS = ["linear_create_comment", "linear_comment_create", "linear_comment_update",
  "linear_create_project_status_update", "linear_project_status_update_create", "linear_project_status_update_edit"];
const SETTINGS = ["linear_team_create", "linear_team_update", "linear_project_update"];
const expectedCategory = (upstream: string, name: string) =>
  SENDS.includes(name) ? "send_message" : SETTINGS.includes(name) ? "modify_settings"
    : upstream === "READ" || upstream === "SEARCH" ? "read_data" : upstream === "DESTRUCTIVE" ? "delete_data" : "write_data";
test("the Linear adapter names every action of the pinned bundle, each in the category it should have", () => {
  const all = Object.values(LINEAR_091_BY_UPSTREAM).flat();
  expect(all).toHaveLength(57);
  const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === LINEAR)!;
  expect((Object.values(adapter.categories).flat() as string[]).sort()).toEqual([...all].sort());
  const table = Object.fromEntries(Object.entries(LINEAR_091_BY_UPSTREAM).flatMap(([upstream, names]) =>
    names.map((name) => [name, expectedCategory(upstream, name)])));
  expect(Object.fromEntries(all.map((name) => [name, resolveGovernedPieceAction(LINEAR, name)!.category as string]))).toEqual(table);
  // Any query or mutation, and anything added upstream later, is the worst case.
  for (const name of ["rawGraphqlQuery", "custom_api_call", "added_upstream_later"])
    expect(resolveGovernedPieceAction(LINEAR, name)).toMatchObject({ category: "modify_settings", known: false });
  // A completion receipt for every change, never for a read.
  for (const name of all)
    expect(`${name}: ${tracksPieceCompletion(LINEAR, name)}`).toBe(`${name}: ${table[name] !== "read_data"}`);
});
test("a project update that names teams is a settings change; a plain edit is a write", () => {
  const category = (input?: Record<string, unknown>) => resolveGovernedPieceAction(LINEAR, "linear_project_update", input)!.category;
  expect(category()).toBe("modify_settings");
  expect(category({ project_id: "p", name: "Renamed" })).toBe("write_data");
  expect(category({ project_id: "p", team_ids: ["t"] })).toBe("modify_settings");
  expect(category({ project_id: "p", team_ids: "{{trigger.teams}}" })).toBe("modify_settings");
});
