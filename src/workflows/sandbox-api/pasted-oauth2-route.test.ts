/**
 * #954 through the engine's connection endpoint: a pasted OAuth2 row is
 * refreshed when its token is about to expire, an expired one that cannot be
 * refreshed is never handed out, and the run records why in a typed form that
 * its failure reading (Q-19) uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CredentialResolver } from "../credentials/adapter";
import type { TokenTransport } from "../credentials/pasted-oauth2";
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from "../db";
import { setEncryptionKey } from "../db/encryption";
import { getConnection, upsertConnection } from "../db/repos/app-connection";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { saveWorkflowEffect } from "../db/repos/workflow-effect";
import { runFailure } from "../runtime/run-failure";
import { SandboxApi } from "./server";
import { createWorkflowRoutes } from "../api/routes";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const NOW_S = NOW / 1000;
const SECRETS = { access_token: "ya29.pasted-access", refresh_token: "1//pasted-refresh", client_secret: "pasted-client-secret" };

let api: SandboxApi;
let tokenCalls: number;
let tokenAnswer: () => { status: number; body: unknown };
let managedCalls: number;
let clock: number;

beforeEach(async () => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 21));
  tokenCalls = 0;
  managedCalls = 0;
  clock = NOW;
  tokenAnswer = () => ({ status: 200, body: { access_token: "ya29.refreshed", expires_in: 3599 } });
  const tokenTransport: TokenTransport = async () => { tokenCalls++; return tokenAnswer(); };
  const resolver = new CredentialResolver({ tokenTransport, now: () => clock });
  // A managed source whose value looks long expired: its own source refreshes it, never this path.
  resolver.register({ id: "fixture", canResolve: id => id === "jarvis:fixture", resolve: async () => {
    managedCalls++;
    return { type: "OAUTH2", value: { access_token: "managed", refresh_token: "", client_id: "c", client_secret: "s",
      token_url: "https://oauth2.example.test/token", claimed_at: 1, expires_in: 1 } };
  } });
  api = new SandboxApi({ services: { credentialResolver: resolver } });
  await api.start({ port: 0 });
});

afterEach(async () => {
  await api?.stop();
  closeWorkflowDb();
  setEncryptionKey(null);
});

function paste(expiresInS: number, extra: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = { ...SECRETS, client_id: "client-id", token_url: "https://oauth2.example.test/token",
    claimed_at: NOW_S - 3599 + expiresInS, expires_in: 3599, ...extra };
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return upsertConnection({ externalId: "work-gmail", displayName: "Work Gmail", type: "OAUTH2",
    pieceName: "@activepieces/piece-gmail", pieceVersion: "0.0.0", value });
}

/** A run of a flow whose Gmail step names the connection, and a fetch as that run's engine. */
async function runOf(externalId = "work-gmail") {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: "Inbox digest", trigger: {
    name: "trigger", type: "EMPTY", nextAction: { name: "read_mail", type: "PIECE", displayName: "Read mail",
      settings: { pieceName: "@activepieces/piece-gmail", pieceVersion: "0.0.0", actionName: "read",
        input: { auth: `{{connections['${externalId}']}}` } } } } as never });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "RUNNING", startTime: NOW });
  const identity = { projectId: DEFAULT_IDS.project, sandboxId: crypto.randomUUID(), runId: run.id };
  const { token, expiresAt } = await api.signer.mint(identity, 60);
  api.registry.register({ ...identity, engineToken: token, expiresAt, terminatedAt: null });
  const fetchConnection = () => fetch(`${api.baseUrl}/v1/worker/app-connections/${encodeURIComponent(externalId)}?projectId=${DEFAULT_IDS.project}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return { run, fetchConnection };
}

describe("#954 pasted OAuth2 connections through the engine endpoint", () => {
  test("a token about to expire is refreshed before it is handed out, and the run keeps the same connection (Q-05)", async () => {
    const row = paste(5 * 60);
    const { run, fetchConnection } = await runOf();
    const first = await fetchConnection();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "ACTIVE", value: { type: "OAUTH2", access_token: "ya29.refreshed" } });
    expect(tokenCalls).toBe(1);
    expect(getConnection(row.id)!.credentialGeneration).toBe(row.credentialGeneration);
    // The next step's fetch finds the refreshed token good for an hour, and the run's binding unchanged.
    const second = await fetchConnection();
    expect(second.status).toBe(200);
    expect(tokenCalls).toBe(1);
    expect(getFlowRun(run.id)!.connectionBindings).toEqual([{ externalId: "work-gmail", boundAt: expect.any(Number), handedOut: true,
      identity: { kind: "native", connectionId: row.id, generation: row.credentialGeneration } }]);
  });

  test("an expired token that cannot be refreshed is not sent; the engine is told it expired; the run says why", async () => {
    paste(-60, { refresh_token: undefined });
    const { run, fetchConnection } = await runOf();
    const response = await fetchConnection();
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    // Status ERROR is what the engine answers with its own "connection (id) expired, reconnect again".
    expect(JSON.parse(text)).toMatchObject({ status: "ERROR", value: { type: "OAUTH2" } });
    expect(Object.keys(JSON.parse(text).value)).toEqual(["type"]);
    expect(tokenCalls).toBe(0);
    expect(getFlowRun(run.id)!.connectionBindings![0]!.credentialFailure).toMatchObject({ code: "CONNECTION_EXPIRED",
      message: expect.stringContaining("work-gmail") });

    const failed = updateRun(run.id, { status: "FAILED", failedStep: { name: "read_mail", displayName: "Read mail",
      errorMessage: "connection (work-gmail) expired, reconnect again" } })!;
    expect(runFailure(getFlowRun(failed.id)!)).toMatchObject({ category: "missing_binding", effect: "none", code: "CONNECTION_EXPIRED",
      headline: 'The step "Read mail" did not run: a connection it uses has expired and Jarvis could not refresh it.',
      next: [{ step: "connect" }, { step: "open_details" }] });
  });

  test("a refresh the provider refuses is the same typed expiry", async () => {
    paste(-60);
    tokenAnswer = () => ({ status: 400, body: { error: "invalid_grant" } });
    const { run, fetchConnection } = await runOf();
    expect((await (await fetchConnection()).json()).status).toBe("ERROR");
    expect(getFlowRun(run.id)!.connectionBindings![0]!.credentialFailure!.code).toBe("CONNECTION_EXPIRED");
  });

  test("an unreachable token endpoint fails the fetch; a later fetch that refreshes clears the record", async () => {
    paste(-60);
    tokenAnswer = () => ({ status: 503, body: null });
    const { run, fetchConnection } = await runOf();
    const refused = await fetchConnection();
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain(SECRETS.refresh_token);
    expect(getFlowRun(run.id)!.connectionBindings![0]!.credentialFailure!.code).toBe("CONNECTION_REFRESH_UNREACHABLE");
    const failed = updateRun(run.id, { status: "FAILED", failedStep: { name: "read_mail", displayName: "Read mail", errorMessage: "Failed to load connection" } })!;
    expect(runFailure(getFlowRun(failed.id)!)).toMatchObject({ category: "target_offline", effect: "none", code: "CONNECTION_REFRESH_UNREACHABLE" });

    tokenAnswer = () => ({ status: 200, body: { access_token: "ya29.back", expires_in: 3599 } });
    expect((await fetchConnection()).status).toBe(200);
    expect(getFlowRun(run.id)!.connectionBindings![0]!.credentialFailure).toBeUndefined();
  });

  test("a run the connection's binding refuses (Q-05) never triggers a refresh", async () => {
    paste(-60);
    const { run, fetchConnection } = await runOf();
    tokenAnswer = () => ({ status: 200, body: { access_token: "ya29.first", expires_in: 3599 } });
    expect((await fetchConnection()).status).toBe(200);
    // A person replaces the credential: the run that bound the old one is refused before any refresh.
    paste(-60, { access_token: "ya29.another-account" });
    const before = tokenCalls;
    expect((await fetchConnection()).status).toBe(409);
    expect(tokenCalls).toBe(before);
    expect(getFlowRun(run.id)!.connectionBindings![0]!.refusal).toBeDefined();
  });

  test("a Jarvis-managed connection is never refreshed here, whatever its value says", async () => {
    const { fetchConnection } = await runOf("jarvis:fixture");
    const response = await fetchConnection();
    expect(response.status).toBe(200);
    expect((await response.json()).value.access_token).toBe("managed");
    expect(managedCalls).toBe(1);
    expect(tokenCalls).toBe(0);
  });

  test("a step whose credential was handed out earlier in the run does not claim nothing happened (retry, loop round)", async () => {
    paste(30 * 60, { refresh_token: undefined });
    const { run, fetchConnection } = await runOf();
    expect((await fetchConnection()).status).toBe(200);
    clock = NOW + 60 * 60_000;
    expect((await (await fetchConnection()).json()).status).toBe("ERROR");
    updateRun(run.id, { status: "FAILED", failedStep: { name: "read_mail", displayName: "Read mail", errorMessage: "expired" } });
    const failure = runFailure(getFlowRun(run.id)!)!;
    expect(failure).toMatchObject({ code: "CONNECTION_EXPIRED", effect: "unknown",
      outcome: "This run had already used this connection, so this step may already have taken effect." });
    expect(failure.next.map(n => n.step)).toEqual(["connect", "check_before_running_again", "open_details"]);
  });

  test("a step with a dispatched effect of its own does not claim nothing happened", async () => {
    paste(-60, { refresh_token: undefined });
    const { run, fetchConnection } = await runOf();
    await fetchConnection();
    saveWorkflowEffect({ id: "wfe_read_mail", runId: run.id, projectId: run.projectId, flowId: run.flowId, versionId: run.flowVersionId,
      versionDigest: "v", stepName: "read_mail", executionPath: [], route: "tool", toolName: "t", actionCategory: "send_email",
      requestDigest: "r", arguments: {}, target: {}, provenance: {}, decision: "allowed", reason: "", status: "succeeded",
      approvalId: null, waitpointId: null, createdAt: NOW } as never);
    updateRun(run.id, { status: "FAILED", failedStep: { name: "read_mail", displayName: "Read mail", errorMessage: "expired" } });
    expect(runFailure(getFlowRun(run.id)!)!.effect).not.toBe("none");
  });

  test("a later refusal of the run's binding (Q-05) is not read as the earlier expiry", async () => {
    paste(-60, { refresh_token: undefined });
    const { run, fetchConnection } = await runOf();
    await fetchConnection();
    paste(30 * 60, { refresh_token: undefined, access_token: "ya29.another-account" });
    expect((await fetchConnection()).status).toBe(409);
    updateRun(run.id, { status: "FAILED", failedStep: { name: "read_mail", displayName: "Read mail", errorMessage: "Failed to load connection" } });
    expect(runFailure(getFlowRun(run.id)!)!.code).not.toBe("CONNECTION_EXPIRED");
  });
});

describe("#954 saving and listing a pasted OAuth2 connection", () => {
  const routes = () => createWorkflowRoutes()["/api/workflows/connections"]!;
  const post = (value: Record<string, unknown>) => routes().POST!(new Request("http://localhost/api/workflows/connections", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalId: "work-gmail", displayName: "Work Gmail", type: "OAUTH2", pieceName: "@activepieces/piece-gmail", value }),
  }));
  const list = async () => (await (await routes().GET!(new Request("http://localhost/api/workflows/connections"))).json()) as {
    connections: Array<Record<string, unknown>> };

  test("a token with expires_in is dated when saved; saving the same token again is not a replacement (Q-05)", async () => {
    const pasted = { access_token: "ya29.same", expires_in: 3599, refresh_token: "1//r", client_id: "c", client_secret: "s",
      token_url: "https://oauth2.example.test/token" };
    const before = Math.round(Date.now() / 1000);
    expect((await post(pasted)).status).toBe(201);
    const id = (await list()).connections[0]!.id as string;
    const claimed = getConnection(id)!.value.claimed_at as number;
    expect(claimed).toBeGreaterThanOrEqual(before);
    expect((await post(pasted)).status).toBe(201);
    expect(getConnection(id)!.value.claimed_at).toBe(claimed);
    expect(getConnection(id)!.credentialGeneration).toBe(0);
  });

  test("re-saving an undated row saved before #954 is not a replacement, and the row is refreshable", async () => {
    const legacy = { access_token: "ya29.legacy", expires_in: 3599, refresh_token: "1//r", client_id: "c", client_secret: "s",
      token_url: "https://oauth2.example.test/token" };
    upsertConnection({ externalId: "work-gmail", displayName: "Work Gmail", type: "OAUTH2", pieceName: "@activepieces/piece-gmail",
      pieceVersion: "0.0.0", value: legacy });
    expect((await list()).connections[0]!.oauth2).toEqual({ expiresAt: null, refreshable: true });
    expect((await post(legacy)).status).toBe(201);
    const id = (await list()).connections[0]!.id as string;
    expect(getConnection(id)!.credentialGeneration).toBe(0);
  });

  test("the list says whether Jarvis refreshes each OAuth2 row and when it expires, and carries no secret", async () => {
    expect((await post({ access_token: "ya29.only", expires_in: 3599 })).status).toBe(201);
    const body = await list();
    const row = body.connections[0]!;
    expect(row.oauth2).toEqual({ expiresAt: expect.any(Number), refreshable: false });
    expect(JSON.stringify(body)).not.toContain("ya29.only");
    expect((await post({ access_token: "ya29.full", expires_in: 3599, refresh_token: "1//r", client_id: "c", client_secret: "s",
      token_url: "https://oauth2.example.test/token" })).status).toBe(201);
    const refreshed = await list();
    expect(refreshed.connections[0]!.oauth2).toEqual({ expiresAt: expect.any(Number), refreshable: true });
    for (const secret of ["ya29.full", "1//r", "\"s\""]) expect(JSON.stringify(refreshed)).not.toContain(secret);
  });
});
