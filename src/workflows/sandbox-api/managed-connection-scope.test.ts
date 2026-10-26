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
import type { GoogleAuth } from "../../integrations/google-auth";
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from "../db";
import { setEncryptionKey } from "../db/encryption";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun } from "../db/repos/flow-run";
import { configureWorkflowReadiness, graphReadiness } from "../db/repos/flow-readiness";
import { triggerHookRunId } from "../runner/triggers/hook-run-id";
import { PieceCatalog } from "../runtime/piece-catalog";
import { SandboxApi } from "./server";

const ACCESS_TOKEN = "synthetic-managed-google-access-token";
const GMAIL = "@activepieces/piece-gmail";
const HTTP = "@activepieces/piece-http";
const SLACK = "@activepieces/piece-slack";

const pieces = new PieceCatalog([
  { name: GMAIL, displayName: "Gmail", description: "", auth: { type: "OAUTH2" }, actions: {
    send_email: { name: "send_email", displayName: "", description: "", inputSchema: { fields: [
      { name: "subject", label: "", type: "string", required: false },
    ] } },
  }, triggers: {
    new_email: { name: "new_email", displayName: "", description: "" },
  } },
  { name: HTTP, displayName: "HTTP", description: "", actions: {
    send_request: { name: "send_request", displayName: "", description: "", requireAuth: false, inputSchema: { fields: [
      { name: "headers", label: "", type: "json", required: false },
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

  test("a run whose graph never names it, or no run at all, is refused", async () => {
    await expectRefused(await fetchFor(runOf(empty(code({})))));
    await expectRefused(await fetchFor(crypto.randomUUID()));
  });

  test("a trigger hook of a flow with a Gmail trigger gets the token; one without is refused", async () => {
    const good = createFlow({});
    createDraftVersion({ flowId: good.id, displayName: "Hook", trigger: { name: "trigger", type: "PIECE_TRIGGER",
      settings: { pieceName: GMAIL, triggerName: "new_email", input: { auth: "{{connections.jarvis:google}}" } } } as any });
    expect((await fetchFor(triggerHookRunId("poll", good.id))).status).toBe(200);
    const bad = createFlow({});
    createDraftVersion({ flowId: bad.id, displayName: "Hook", trigger: empty(gmail()) });
    await expectRefused(await fetchFor(triggerHookRunId("poll", bad.id)));
  });
});
