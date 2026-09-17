import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWorkflowRoutes } from "../api/routes";
import { CredentialResolver } from "../credentials/adapter";
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from "../db";
import { setEncryptionKey } from "../db/encryption";
import { upsertConnection } from "../db/repos/app-connection";
import { SandboxApi } from "./server";

const TOKEN = "synthetic-native-lookup-token";
let api: SandboxApi;
let managedCalls: number;

beforeEach(async () => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 18));
  managedCalls = 0;
  const resolver = new CredentialResolver();
  resolver.register({
    id: "fixture", canResolve: id => id === "jarvis:fixture",
    resolve: async () => {
      managedCalls++;
      return { type: "OAUTH2", value: { access_token: "managed-fixture-token" } };
    },
  });
  api = new SandboxApi({ services: { credentialResolver: resolver } });
  await api.start({ port: 0 });
});

afterEach(async () => {
  await api?.stop();
  closeWorkflowDb();
  setEncryptionKey(null);
});

async function save(externalId: string, pieceName = "fixture-piece") {
  const post = createWorkflowRoutes()["/api/workflows/connections"]!.POST!;
  const response = await post(new Request("http://localhost/api/workflows/connections", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalId, pieceName, pieceVersion: "1.0.0", displayName: "Fixture",
      type: "OAUTH2", value: { access_token: TOKEN } }),
  }));
  expect(response.status).toBe(201);
  const result = await response.json() as { id: string };
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  return result.id;
}

async function mint(projectId: string = DEFAULT_IDS.project, ttl = 60) {
  const identity = { projectId, sandboxId: crypto.randomUUID(), runId: crypto.randomUUID() };
  const { token, expiresAt } = await api.signer.mint(identity, ttl);
  api.registry.register({ ...identity, engineToken: token, expiresAt, terminatedAt: null });
  return { token, identity };
}

async function lookup(externalId: string, query: Record<string, string> = {}, projectId: string = DEFAULT_IDS.project) {
  const { token } = await mint(projectId);
  const params = new URLSearchParams({ projectId, ...query });
  return fetch(`${api.baseUrl}/v1/worker/app-connections/${encodeURIComponent(externalId)}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("native connections through the authenticated engine endpoint", () => {
  test("API save resolves by external ID with no pieceName, including encoded IDs", async () => {
    const externalId = "native / plus+ percent%";
    await save(externalId);
    const response = await lookup(externalId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ externalId, pieceName: "fixture-piece", status: "ACTIVE",
      projectIds: [DEFAULT_IDS.project], value: { type: "OAUTH2", access_token: TOKEN } });
  });

  test("duplicate IDs fail closed, while an explicit piece keeps exact matching", async () => {
    await save("duplicate", "piece-a");
    await save("duplicate", "piece-b");
    const ambiguous = await lookup("duplicate");
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.text()).not.toContain(TOKEN);
    for (const pieceName of ["piece-a", "piece-b"]) {
      const response = await lookup("duplicate", { pieceName });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pieceName });
    }
    expect((await lookup("duplicate", { pieceName: "missing" })).status).toBe(404);
    expect((await lookup("duplicate", { pieceName: "*" })).status).toBe(404);
  });

  test("ambiguity is detected before decrypting either candidate", async () => {
    const id = await save("duplicate", "piece-a");
    await save("duplicate", "piece-b");
    getWorkflowDb().run("UPDATE app_connection SET value = ? WHERE id = ?", ["invalid-json", id]);
    expect((await lookup("duplicate")).status).toBe(409);
  });

  test("lookups stay in the token project and query overrides cannot reach native or managed sources", async () => {
    await save("shared-id");
    upsertConnection({ externalId: "shared-id", pieceName: "fixture-piece", pieceVersion: "1", displayName: "Other",
      projectId: "other-project", type: "OAUTH2", value: { access_token: "other-project-token" } });
    const own = await lookup("shared-id");
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ value: { access_token: TOKEN } });
    const other = await lookup("shared-id", {}, "other-project");
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ value: { access_token: "other-project-token" } });
    for (const externalId of ["shared-id", "jarvis:fixture"]) {
      const forbidden = await lookup(externalId, { projectId: "other-project", pieceName: "fixture-piece" });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.text()).not.toContain("other-project-token");
    }
    expect(managedCalls).toBe(0);
    expect((await lookup("shared-id", {}, "empty-project")).status).toBe(404);
  });

  test("managed IDs retain source priority and never fall back to native rows", async () => {
    await save("jarvis:fixture", "piece-a");
    await save("jarvis:fixture", "piece-b");
    await save("jarvis:unknown");
    const response = await lookup("jarvis:fixture");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ value: { access_token: "managed-fixture-token" } });
    expect(managedCalls).toBe(1);
    expect((await lookup("jarvis:unknown")).status).toBe(404);
  });

  test("requires a valid live engine token", async () => {
    await save("native");
    const url = `${api.baseUrl}/v1/worker/app-connections/native`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
    const expired = await mint(DEFAULT_IDS.project, -10);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${expired.token}` } })).status).toBe(401);
    const live = await mint();
    api.registry.terminate(live.identity.sandboxId);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${live.token}` } })).status).toBe(401);
  });

  test("uses the token project when omitted and rejects empty explicit filters", async () => {
    await save("native");
    const { token } = await mint();
    const response = await fetch(`${api.baseUrl}/v1/worker/app-connections/native`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect((await lookup("native", { projectId: "" })).status).toBe(403);
    expect((await lookup("native", { pieceName: "" })).status).toBe(400);
  });

  test("a query-less request resolves through the token claims, for any run in that project", async () => {
    upsertConnection({ externalId: "claims-only", pieceName: "fixture-piece", pieceVersion: "1", displayName: "Scoped",
      projectId: "claims-project", type: "OAUTH2", value: { access_token: "claims-project-token" } });
    // No projectId query param at all: the only thing that can name the
    // project is the verified token, so a default or a query fallback fails.
    const url = `${api.baseUrl}/v1/worker/app-connections/claims-only`;
    const first = await mint("claims-project");
    const scoped = await fetch(url, { headers: { Authorization: `Bearer ${first.token}` } });
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toMatchObject({ projectIds: ["claims-project"],
      value: { access_token: "claims-project-token" } });
    // The boundary is the project, not the run: a second run in the same
    // project reads the same row. Narrowing that is separate work, so this
    // asserts today's scope rather than leaving it undescribed.
    const second = await mint("claims-project");
    expect(second.identity.runId).not.toBe(first.identity.runId);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${second.token}` } })).status).toBe(200);
    // A run in another project never sees it, with no query param to fall
    // back on. The explicit cross-project override is the 403 case above.
    const outsider = await mint();
    expect((await fetch(url, { headers: { Authorization: `Bearer ${outsider.token}` } })).status).toBe(404);
  });

  test("a token retired by a warm-engine rebind cannot read its old project's credential", async () => {
    // The pooled engine keeps one sandboxId across runs, so `rebind()` hands
    // the same warm process to a new (runId, projectId). Piece code from the
    // finished run can retain its token in module-level state -- the process
    // survives -- and the token's own projectId claim is what this route
    // scopes by, so before the middleware compared tokens this returned 200
    // with the retired project's plaintext access_token.
    await save("warm-victim");
    const sandboxId = "sandbox-reused-across-runs";
    const retired = await api.signer.mint(
      { sandboxId, runId: "run-retired", projectId: DEFAULT_IDS.project },
      600,
    );
    api.registry.register({
      sandboxId, runId: "run-retired", projectId: DEFAULT_IDS.project,
      engineToken: retired.token, expiresAt: retired.expiresAt, terminatedAt: null,
    });
    const current = await api.signer.mint(
      { sandboxId, runId: "run-next", projectId: "project-next" },
      600,
    );
    api.registry.rebind(sandboxId, {
      runId: "run-next", projectId: "project-next",
      engineToken: current.token, expiresAt: current.expiresAt,
    });

    const url = `${api.baseUrl}/v1/worker/app-connections/warm-victim`;
    const stale = await fetch(url, { headers: { Authorization: `Bearer ${retired.token}` } });
    expect(stale.status).toBe(401);
    const body = await stale.text();
    expect(body).not.toContain(TOKEN);
    // The response `id` used to echo `engine_run-retired_warm-victim`, which
    // is the server plainly still acting as the run that was handed off.
    expect(body).not.toContain("run-retired");
    // The run that actually owns the sandbox is unaffected; it simply has no
    // connection of its own in its own project.
    expect((await fetch(url, { headers: { Authorization: `Bearer ${current.token}` } })).status)
      .toBe(404);
  });

  test("preserves native error status and does not expose missing credentials", async () => {
    const id = await save("native");
    getWorkflowDb().run("UPDATE app_connection SET status = 'ERROR' WHERE id = ?", [id]);
    const expired = await lookup("native");
    expect(expired.status).toBe(200);
    expect(await expired.json()).toMatchObject({ status: "ERROR" });
    getWorkflowDb().run("UPDATE app_connection SET status = 'MISSING' WHERE id = ?", [id]);
    const missing = await lookup("native");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(TOKEN);
  });
});
