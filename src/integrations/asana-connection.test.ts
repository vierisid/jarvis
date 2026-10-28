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
} from "./asana-refresh";
import { JarvisAsanaConnectionSource } from "../workflows/credentials/asana-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
import {
  MANAGED_PIECE_ADAPTERS,
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "../workflows/runtime/piece-effects";
import { AUTHORITY_REQUIREMENTS } from "../roles/authority";
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

const ASANA = "@activepieces/piece-asana";
/** Every action of the pinned @activepieces/piece-asana 0.7.2 bundle, keyed by
 * the `classification` upstream gives it (custom_api_call is added by the
 * framework and stays unmapped). The engine test checks the installed package
 * against the adapter too. */
const ASANA_072_BY_UPSTREAM: Record<string, string[]> = {
 READ: [
   'get_allocation', 'get_attachment', 'get_current_user', 'get_custom_field', 'get_goal', 'get_job',
   'get_membership', 'get_portfolio', 'get_project', 'get_project_brief', 'get_project_task_counts', 'get_section',
   'get_status_update', 'get_story', 'get_tag', 'get_task', 'get_team', 'get_team_membership', 'get_time_period',
   'get_user', 'get_workspace', 'get_workspace_membership',
 ],
 SEARCH: [
   'list_access_requests', 'list_allocations', 'list_assigned_tasks', 'list_attachments', 'list_custom_fields',
   'list_custom_types', 'list_favorites', 'list_goal_relationships', 'list_goals', 'list_memberships',
   'list_portfolio_items', 'list_portfolios', 'list_project_tasks', 'list_project_templates', 'list_projects',
   'list_reactions', 'list_section_tasks', 'list_sections', 'list_status_updates', 'list_subtasks', 'list_tag_tasks',
   'list_tags', 'list_task_dependencies', 'list_task_projects', 'list_task_stories', 'list_task_tags',
   'list_task_templates', 'list_team_memberships', 'list_teams', 'list_time_periods', 'list_time_tracking_entries',
   'list_user_teams', 'list_users', 'list_workspace_memberships', 'list_workspaces', 'search_tasks',
   'search_workspace_objects',
 ],
 WRITE: [
   'add_goal_supporting_relationship', 'add_portfolio_item', 'add_project_followers', 'add_project_members',
   'add_tag_to_task', 'add_task_comment', 'add_task_dependencies', 'add_task_followers', 'add_task_to_project',
   'add_user_to_team', 'add_user_to_workspace', 'approve_access_request', 'create_access_request',
   'create_allocation', 'create_custom_field', 'create_custom_field_enum_option', 'create_membership',
   'create_project', 'create_project_brief', 'create_project_task', 'create_section', 'create_status_update',
   'create_subtask', 'create_tag', 'create_task', 'create_team', 'duplicate_project', 'duplicate_task',
   'instantiate_project_template', 'move_section', 'move_task_to_section', 'reject_access_request',
   'remove_portfolio_item', 'remove_project_followers', 'remove_tag_from_task', 'remove_task_dependencies',
   'remove_task_followers', 'remove_task_from_project', 'reorder_custom_field_enum_option', 'set_task_parent',
   'update_allocation', 'update_comment', 'update_custom_field', 'update_custom_field_enum_option', 'update_project',
   'update_project_brief', 'update_section', 'update_tag', 'update_task', 'update_team', 'update_user',
   'upload_attachment',
 ],
 DESTRUCTIVE: [
   'delete_allocation', 'delete_attachment', 'delete_comment', 'delete_custom_field', 'delete_membership',
   'delete_project', 'delete_project_brief', 'delete_section', 'delete_status_update', 'delete_tag', 'delete_task',
   'remove_project_members', 'remove_user_from_team', 'remove_user_from_workspace',
 ],
};
/** Where Jarvis departs from upstream's label: messages to people, and access grants. */
const SENDS = ["add_task_comment", "update_comment", "create_status_update", "create_access_request"];
const ACCESS = ["add_project_members", "add_user_to_team", "add_user_to_workspace", "approve_access_request",
  "create_membership", "update_project", "update_team"];
const expectedCategory = (upstream: string, name: string) =>
  SENDS.includes(name) ? "send_message" : ACCESS.includes(name) ? "modify_settings"
    : upstream === "READ" || upstream === "SEARCH" ? "read_data" : upstream === "DESTRUCTIVE" ? "delete_data" : "write_data";
test("the Asana adapter names every action of the pinned bundle, each in the category it should have", () => {
  const all = Object.values(ASANA_072_BY_UPSTREAM).flat();
  expect(all).toHaveLength(125);
  const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === ASANA)!;
  expect((Object.values(adapter.categories).flat() as string[]).sort()).toEqual([...all].sort());
  const table = Object.fromEntries(Object.entries(ASANA_072_BY_UPSTREAM).flatMap(([upstream, names]) =>
    names.map((name) => [name, expectedCategory(upstream, name)])));
  expect(Object.fromEntries(all.map((name) => [name, resolveGovernedPieceAction(ASANA, name)!.category as string]))).toEqual(table);
  expect(all.filter((name) => !resolveGovernedPieceAction(ASANA, name)!.known)).toEqual([]);
  for (const name of ["custom_api_call", "added_upstream_later"])
    expect(resolveGovernedPieceAction(ASANA, name)).toMatchObject({ category: "modify_settings", known: false });
  // A completion receipt for every change, never for a read.
  for (const name of all)
    expect(`${name}: ${tracksPieceCompletion(ASANA, name)}`).toBe(`${name}: ${table[name] !== "read_data"}`);
});
test("a project or team update narrows from its worst case only when its input says it is a plain edit", () => {
  const category = (action: string, input?: Record<string, unknown>) => resolveGovernedPieceAction(ASANA, action, input)!.category;
  expect(category("update_project")).toBe("modify_settings");
  expect(category("update_project", { project: "1", name: "Renamed", notes: "x" })).toBe("write_data");
  expect(category("update_project", { project: "1", archived: false })).toBe("write_data");
  expect(category("update_project", { project: "1", archived: true })).toBe("delete_data");
  expect(category("update_project", { project: "1", archived: "{{x}}" })).toBe("delete_data");
  expect(category("update_project", { project: "1", archived: false, privacy_setting: "public_to_workspace" })).toBe("modify_settings");
  expect(category("update_project", { project: "1", owner: "2" })).toBe("modify_settings");
  expect(category("update_team")).toBe("modify_settings");
  expect(category("update_team", { team: "1", name: "Renamed" })).toBe("write_data");
  expect(category("update_team", { team: "1", visibility: "secret" })).toBe("modify_settings");
  expect(category("update_team", { team: "1", endorsed: true })).toBe("modify_settings");
  for (const action of ["update_project", "update_team"])
    expect(AUTHORITY_REQUIREMENTS[category(action)]).toBe(AUTHORITY_REQUIREMENTS.modify_settings);
});
test("prepared qualification, which passes no settings, is judged on the piece alone; a trigger never gets the grant", () => {
  const source = new JarvisAsanaConnectionSource(config);
  expect(managedConnectionMisuse(source, ASANA, "settings.input.auth")).toBeNull();
  expect(managedConnectionMisuse(source, "@activepieces/piece-http", "settings.input.auth")).not.toBeNull();
  for (const settings of [{ triggerName: "new_task" }, { triggerName: "new_task", actionName: "get_task" }, null, "get_task"])
    expect(managedConnectionMisuse(source, ASANA, "settings.input.auth", settings)).not.toBeNull();
});
