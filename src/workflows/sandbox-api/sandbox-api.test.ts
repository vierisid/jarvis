/**
 * Tests for the SandboxApi skeleton: token mint+verify, registry lifecycle,
 * HTTP server boot, auth middleware, and the one stub route currently wired
 * (`GET /v1/worker/project`). Subsequent commits will add tests as more
 * endpoints land.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { EngineTokenSigner } from "./engine-token";
import { SandboxRegistry } from "./sandbox-registry";
import { SandboxApi } from "./server";
import { CredentialResolver } from "../credentials/adapter";
import { DEFAULT_IDS } from "../db/schema";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { _clearStoreForTests } from "../db/repos/store-entry";
import { createFlow, setPublishedVersion, updateFlowStatus } from "../db/repos/flow";
import { createDraftVersion, lockVersion } from "../db/repos/flow-version";

const sampleIdentity = () => ({
  sandboxId: SandboxRegistry.newSandboxId(),
  runId: "run_test_" + Math.random().toString(36).slice(2, 10),
  projectId: DEFAULT_IDS.project,
});

describe("EngineTokenSigner", () => {
  test("mint+verify round-trip preserves claims", async () => {
    const signer = new EngineTokenSigner();
    const id = sampleIdentity();
    const { token, expiresAt } = await signer.mint(id);
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(3); // header.payload.sig
    expect(expiresAt).toBeGreaterThan(Date.now());

    const claims = await signer.verify(token);
    expect(claims.sandboxId).toBe(id.sandboxId);
    expect(claims.runId).toBe(id.runId);
    expect(claims.projectId).toBe(id.projectId);
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  test("token signed with one signer fails verify on another (fresh secret per signer)", async () => {
    const signerA = new EngineTokenSigner();
    const signerB = new EngineTokenSigner();
    const { token } = await signerA.mint(sampleIdentity());
    await expect(signerB.verify(token)).rejects.toThrow();
  });

  test("tampered payload fails verification", async () => {
    const signer = new EngineTokenSigner();
    const { token } = await signer.mint(sampleIdentity());
    const [h, p, s] = token.split(".");
    // Flip a byte in the payload to invalidate the signature.
    const tampered = `${h}.${p!.replace(/[A-Za-z]/, (c) => (c === "a" ? "b" : "a"))}.${s}`;
    await expect(signer.verify(tampered)).rejects.toThrow();
  });

  test("expired token is rejected", async () => {
    const signer = new EngineTokenSigner();
    const { token } = await signer.mint(sampleIdentity(), -10);
    await expect(signer.verify(token)).rejects.toThrow();
  });
});

describe("SandboxRegistry", () => {
  test("register / get / byRunId", () => {
    const reg = new SandboxRegistry();
    const id = sampleIdentity();
    reg.register({
      ...id,
      engineToken: "token_xxx",
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    expect(reg.size()).toBe(1);
    expect(reg.liveCount()).toBe(1);
    expect(reg.get(id.sandboxId)?.runId).toBe(id.runId);
    expect(reg.byRunId(id.runId)?.sandboxId).toBe(id.sandboxId);
  });

  test("terminate hides record from get/byRunId but keeps it in size", () => {
    const reg = new SandboxRegistry();
    const id = sampleIdentity();
    reg.register({
      ...id,
      engineToken: "t",
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    reg.terminate(id.sandboxId);
    expect(reg.get(id.sandboxId)).toBeNull();
    expect(reg.byRunId(id.runId)).toBeNull();
    expect(reg.liveCount()).toBe(0);
    expect(reg.size()).toBe(1);
  });

  test("prune drops terminated entries older than retainMs", () => {
    const reg = new SandboxRegistry();
    const id = sampleIdentity();
    reg.register({
      ...id,
      engineToken: "t",
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    const tenMinAgo = Date.now() - 10 * 60_000;
    reg.terminate(id.sandboxId, tenMinAgo);
    expect(reg.size()).toBe(1);
    const dropped = reg.prune(5 * 60_000);
    expect(dropped).toBe(1);
    expect(reg.size()).toBe(0);
  });

  test("double register on the same sandboxId throws", () => {
    const reg = new SandboxRegistry();
    const id = sampleIdentity();
    const record = {
      ...id,
      engineToken: "t",
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    };
    reg.register(record);
    expect(() => reg.register(record)).toThrow();
  });

  test("newSandboxId returns 24-char hex", () => {
    const id = SandboxRegistry.newSandboxId();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  test("rebind: updates runId/projectId/engineToken without changing sandboxId", () => {
    const reg = new SandboxRegistry();
    const id = sampleIdentity();
    reg.register({
      ...id,
      engineToken: "tok-v1",
      expiresAt: 100,
      terminatedAt: null,
    });
    reg.rebind(id.sandboxId, {
      runId: "run_v2",
      projectId: id.projectId,
      engineToken: "tok-v2",
      expiresAt: 200,
    });
    const record = reg.get(id.sandboxId);
    expect(record?.runId).toBe("run_v2");
    expect(record?.engineToken).toBe("tok-v2");
    expect(record?.expiresAt).toBe(200);
    expect(reg.byRunId("run_v2")?.sandboxId).toBe(id.sandboxId);
    // Old run no longer maps.
    expect(reg.byRunId(id.runId)).toBeNull();
  });

  test("rebind: throws on unknown or terminated sandboxId", () => {
    const reg = new SandboxRegistry();
    expect(() =>
      reg.rebind("missing", { runId: "x", projectId: "y", engineToken: "t", expiresAt: 0 }),
    ).toThrow();
    const id = sampleIdentity();
    reg.register({
      ...id,
      engineToken: "t",
      expiresAt: 0,
      terminatedAt: null,
    });
    reg.terminate(id.sandboxId);
    expect(() =>
      reg.rebind(id.sandboxId, { runId: "x", projectId: "y", engineToken: "t", expiresAt: 0 }),
    ).toThrow();
  });
});

describe("SandboxApi server", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;

  beforeAll(async () => {
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({
      signer,
      registry,
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
  });

  test("server binds to 127.0.0.1 with an OS-assigned port", () => {
    expect(api.hostname).toBe("127.0.0.1");
    expect(api.port).toBeGreaterThan(0);
    expect(api.baseUrl).toContain("http://127.0.0.1:");
  });

  test("GET /health is unauthenticated and reports liveCount", async () => {
    const r = await fetch(`${api.baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; sandboxes: number };
    expect(body.ok).toBe(true);
    expect(body.sandboxes).toBe(0);
  });

  test("authenticated routes 401 without a bearer token", async () => {
    const r = await fetch(`${api.baseUrl}/v1/worker/project`);
    expect(r.status).toBe(401);
  });

  test("authenticated routes 401 with a tampered token", async () => {
    const id = sampleIdentity();
    registry.register({
      ...id,
      engineToken: "n/a",
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    const r = await fetch(`${api.baseUrl}/v1/worker/project`, {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(r.status).toBe(401);
  });

  test("authenticated routes 401 when sandbox has been terminated", async () => {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    registry.terminate(id.sandboxId);
    const r = await fetch(`${api.baseUrl}/v1/worker/project`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(401);
  });

  test("GET /v1/worker/project returns project metadata for a live sandbox", async () => {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    const r = await fetch(`${api.baseUrl}/v1/worker/project`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string; externalId: string };
    expect(body.id).toBe(DEFAULT_IDS.project);
    expect(body.externalId).toBe(id.projectId);
  });

  test("unknown path returns 404", async () => {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    const r = await fetch(`${api.baseUrl}/v1/does-not-exist`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(404);
  });

  test("?token= query param is rejected on routes other than the logs upload", async () => {
    // URL-borne tokens leak into proxy / access logs more readily than
    // headers, so the fallback is restricted to exactly PUT /v1/logs/:runId.
    // This test guards against re-broadening the fallback by accident.
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    // Valid token, wrong delivery channel -> 401.
    const r = await fetch(`${api.baseUrl}/v1/worker/project?token=${encodeURIComponent(token)}`);
    expect(r.status).toBe(401);
  });

  test("?token= query param is accepted on PUT /v1/logs/:runId (presigned-style upload)", async () => {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    // The handler will reject the payload (no real run row), but auth must
    // pass first -- we only assert we're not getting the auth 401.
    const r = await fetch(
      `${api.baseUrl}/v1/logs/${encodeURIComponent(id.runId)}?token=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        body: "log-bytes",
        headers: { "content-type": "application/octet-stream" },
      },
    );
    expect(r.status).not.toBe(401);
  });
});

describe("SandboxApi routes (B2: connections, store, flows)", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;
  let resolver: CredentialResolver;

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    return fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    resolver = new CredentialResolver();
    // Stub Jarvis source so jarvis:test resolves to a fake OAuth2 connection.
    resolver.register({
      id: "test",
      canResolve: (e) => e === "jarvis:test",
      resolve: async () => ({
        type: "OAUTH2",
        value: { access_token: "tok", refresh_token: "" },
      }),
    });
    api = new SandboxApi({ signer, registry, services: { credentialResolver: resolver } });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
    closeWorkflowDb();
  });

  beforeEach(() => {
    _clearStoreForTests();
  });

  test("GET /v1/worker/app-connections/:externalId resolves a Jarvis source", async () => {
    const r = await authedFetch("/v1/worker/app-connections/jarvis%3Atest");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { externalId: string; status: string; value: { type?: string; access_token?: string } };
    expect(body.externalId).toBe("jarvis:test");
    expect(body.status).toBe("ACTIVE");
    expect(body.value.type).toBe("OAUTH2");
    expect(body.value.access_token).toBe("tok");
  });

  test("GET /v1/worker/app-connections returns 404 for unknown id", async () => {
    const r = await authedFetch("/v1/worker/app-connections/unknown-id");
    expect(r.status).toBe(404);
  });

  test("POST /v1/store-entries upserts and GET reads", async () => {
    const put = await authedFetch("/v1/store-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "k1", value: { hello: "world" } }),
    });
    expect(put.status).toBe(201);
    const get = await authedFetch("/v1/store-entries?key=k1");
    expect(get.status).toBe(200);
    const body = (await get.json()) as { key: string; value: { hello: string } };
    expect(body.key).toBe("k1");
    expect(body.value.hello).toBe("world");
  });

  test("GET /v1/store-entries returns 404 when missing", async () => {
    const r = await authedFetch("/v1/store-entries?key=missing");
    expect(r.status).toBe(404);
  });

  test("DELETE /v1/store-entries removes the entry", async () => {
    await authedFetch("/v1/store-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "to-del", value: 1 }),
    });
    const del = await authedFetch("/v1/store-entries?key=to-del", { method: "DELETE" });
    expect(del.status).toBe(200);
    const get = await authedFetch("/v1/store-entries?key=to-del");
    expect(get.status).toBe(404);
  });

  test("POST /v1/store-entries 400 on missing key", async () => {
    const r = await authedFetch("/v1/store-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/store-entries 413 on oversized value", async () => {
    const big = "x".repeat(600 * 1024);
    const r = await authedFetch("/v1/store-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "big", value: big }),
    });
    expect(r.status).toBe(413);
  });

  test("GET /v1/engine/populated-flows returns published flows in SeekPage shape", async () => {
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const v = createDraftVersion({
      flowId: flow.id,
      displayName: "Hello",
      trigger: { type: "EMPTY", name: "trigger", displayName: "Manual" } as unknown as Record<string, unknown>,
    });
    lockVersion(v.id);
    setPublishedVersion(flow.id, v.id);
    updateFlowStatus(flow.id, "ENABLED");

    const r = await authedFetch(`/v1/engine/populated-flows?externalIds=${flow.external_id}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: Array<{ id: string; externalId: string; version?: { id: string } }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.id).toBe(flow.id);
    expect(body.data[0]?.externalId).toBe(flow.external_id);
    expect(body.data[0]?.version?.id).toBe(v.id);
  });

  test("GET /v1/engine/populated-flows skips flows without a published version", async () => {
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const r = await authedFetch(`/v1/engine/populated-flows?externalIds=${flow.external_id}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: unknown[] };
    expect(body.data.length).toBe(0);
  });
});

describe("SandboxApi routes (B3: files, waitpoints, logs)", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;
  let testRunId: string;

  async function authedFetchForRun(path: string, init: RequestInit = {}): Promise<Response> {
    const id = { ...sampleIdentity(), runId: testRunId };
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    return fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    process.env.JARVIS_WORKFLOW_DATA_DIR = `/tmp/jarvis-sandbox-test-${Math.random().toString(36).slice(2, 10)}`;
    initWorkflowDb(":memory:");
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({
      signer,
      registry,
      services: {
        credentialResolver: new CredentialResolver(),
        resumeUrlPrefix: "https://daemon.local/api/webhooks/waitpoints",
      },
    });
    await api.start({ port: 0 });

    // A real flow_run row is needed for the waitpoint FK.
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const v = createDraftVersion({ flowId: flow.id, displayName: "f" });
    lockVersion(v.id);
    const { createFlowRun } = await import("../db/repos/flow-run");
    testRunId = createFlowRun({
      flowId: flow.id,
      flowVersionId: v.id,
      environment: "TESTING",
    }).id;
  });

  afterAll(async () => {
    await api.stop();
    closeWorkflowDb();
    delete process.env.JARVIS_WORKFLOW_DATA_DIR;
  });

  test("POST /v1/step-files stores blob and returns a /v1/step-files/<id> URL", async () => {
    const form = new FormData();
    form.set("stepName", "step_1");
    form.set("flowId", "flow_xx");
    form.set("fileName", "hello.txt");
    form.set("file", new Blob(["hello world"], { type: "text/plain" }), "hello.txt");
    const r = await authedFetchForRun("/v1/step-files", { method: "POST", body: form });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { url: string };
    expect(body.url).toMatch(/^\/v1\/step-files\//);

    // GET round-trip
    const get = await authedFetchForRun(body.url);
    expect(get.status).toBe(200);
    const text = await get.text();
    expect(text).toBe("hello world");
  });

  test("POST /v1/step-files round-trips binary bytes exactly (no text encoding drift)", async () => {
    // 2KB of full-range bytes -- catches accidental utf8/base64 detours
    // that work for ASCII payloads but corrupt arbitrary bytes.
    const original = new Uint8Array(2048);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;

    const form = new FormData();
    form.set("stepName", "step_bin");
    form.set("flowId", "flow_bin");
    form.set("fileName", "fixture.bin");
    form.set("file", new Blob([original], { type: "application/octet-stream" }), "fixture.bin");
    const upload = await authedFetchForRun("/v1/step-files", { method: "POST", body: form });
    expect(upload.status).toBe(200);
    const uploadBody = (await upload.json()) as { url: string };

    const download = await authedFetchForRun(uploadBody.url);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-length")).toBe(String(original.length));
    const got = new Uint8Array(await download.arrayBuffer());
    expect(got.length).toBe(original.length);
    // Comparing one byte at a time pinpoints the failure offset on regression.
    let firstDiff = -1;
    for (let i = 0; i < original.length; i++) {
      if (got[i] !== original[i]) {
        firstDiff = i;
        break;
      }
    }
    expect(firstDiff).toBe(-1);
  });

  test("POST /v1/step-files rejects a missing file blob with 400", async () => {
    const form = new FormData();
    form.set("stepName", "step_a");
    form.set("flowId", "flow_x");
    // No `file` field.
    const r = await authedFetchForRun("/v1/step-files", { method: "POST", body: form });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toMatch(/missing file blob/);
  });

  test("GET /v1/step-files from a different project is denied with 403", async () => {
    // Upload as the test's default identity (project default).
    const upForm = new FormData();
    upForm.set("stepName", "step_x");
    upForm.set("flowId", "flow_x");
    upForm.set("file", new Blob([new Uint8Array([1, 2, 3])]), "x.bin");
    const upload = await authedFetchForRun("/v1/step-files", { method: "POST", body: upForm });
    expect(upload.status).toBe(200);
    const { url } = (await upload.json()) as { url: string };

    // Mint a token with a different projectId and try to download. The
    // route's `req.claims.projectId !== row.projectId` check forbids it.
    const otherId = { ...sampleIdentity(), projectId: "proj_outsider" };
    const { token: otherToken } = await signer.mint(otherId);
    registry.register({
      ...otherId,
      engineToken: otherToken,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    const r = await fetch(`${api.baseUrl}${url}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(r.status).toBe(403);
  });

  test("GET /v1/step-files/:unknown-id returns 404", async () => {
    const r = await authedFetchForRun("/v1/step-files/nonexistent-file-id");
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toMatch(/file not found/);
  });

  test("POST /v1/step-files rejects non-multipart bodies", async () => {
    const r = await authedFetchForRun("/v1/step-files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/waitpoints persists row and returns resumeUrl", async () => {
    const r = await authedFetchForRun("/v1/waitpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowRunId: testRunId,
        projectId: DEFAULT_IDS.project,
        stepName: "step_pause",
        type: "WEBHOOK",
        version: "V1",
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { waitpointId: string; resumeUrl: string };
    expect(body.waitpointId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(body.resumeUrl).toBe(
      `https://daemon.local/api/webhooks/waitpoints/${body.waitpointId}`,
    );
  });

  test("POST /v1/waitpoints rejects flowRunId mismatch", async () => {
    const r = await authedFetchForRun("/v1/waitpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowRunId: "some-other-run",
        stepName: "x",
        type: "TIMER",
      }),
    });
    expect(r.status).toBe(403);
  });

  test("POST /v1/waitpoints rejects unsupported type", async () => {
    const r = await authedFetchForRun("/v1/waitpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowRunId: testRunId, stepName: "x", type: "QUANTUM" }),
    });
    expect(r.status).toBe(400);
  });

  test("PUT /v1/logs/:runId persists body to disk", async () => {
    const r = await authedFetchForRun(`/v1/logs/${testRunId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; bytes: number };
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(5);
  });

  test("PUT /v1/logs/:runId rejects mismatched runId", async () => {
    const r = await authedFetchForRun("/v1/logs/some-other-run", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([0]),
    });
    expect(r.status).toBe(403);
  });
});

describe("SandboxApi routes (G: jarvis-tool/notify/context)", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;
  let toolsCalls: Array<{ toolName: string; params: Record<string, unknown> }>;
  let notifyCalls: Array<{ message: string; channels: string[]; priority: string }>;
  let contextCalls: Array<{ method: string; input: unknown }>;

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    return fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    toolsCalls = [];
    notifyCalls = [];
    contextCalls = [];
    api = new SandboxApi({
      signer,
      registry,
      services: {
        credentialResolver: new CredentialResolver(),
        toolsInvoke: async (req) => {
          toolsCalls.push(req);
          return { result: { ok: true, params: req.params }, toolName: req.toolName };
        },
        notify: async (req) => {
          notifyCalls.push(req);
          return { delivered: req.channels, failed: [] };
        },
        contextProvider: {
          vaultSearch: async (input) => {
            contextCalls.push({ method: "vaultSearch", input });
            return [];
          },
          vaultGetEntity: async (id) => {
            contextCalls.push({ method: "vaultGetEntity", input: id });
            return null;
          },
          awarenessRecent: async (input) => {
            contextCalls.push({ method: "awarenessRecent", input });
            return [];
          },
          commitmentsList: async (input) => {
            contextCalls.push({ method: "commitmentsList", input });
            return [];
          },
        },
      },
    });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(() => {
    toolsCalls = [];
    notifyCalls = [];
    contextCalls = [];
  });

  test("POST /v1/jarvis/tools/invoke calls injected fn and returns its reply", async () => {
    const r = await authedFetch("/v1/jarvis/tools/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "vault_search", params: { query: "x" } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: unknown; toolName: string };
    expect(body.toolName).toBe("vault_search");
    expect(toolsCalls.length).toBe(1);
    expect(toolsCalls[0]?.toolName).toBe("vault_search");
    expect(toolsCalls[0]?.params).toEqual({ query: "x" });
  });

  test("POST /v1/jarvis/tools/invoke 400 on missing toolName", async () => {
    const r = await authedFetch("/v1/jarvis/tools/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: {} }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/tools/invoke 400 on non-object params", async () => {
    const r = await authedFetch("/v1/jarvis/tools/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "x", params: [1, 2] }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/notify dispatches and surfaces delivery report", async () => {
    const r = await authedFetch("/v1/jarvis/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        channels: ["telegram", "discord"],
        priority: "high",
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { delivered: string[]; failed: unknown[] };
    expect(body.delivered).toEqual(["telegram", "discord"]);
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]?.priority).toBe("high");
  });

  test("POST /v1/jarvis/notify defaults channels to ['auto'] and priority to 'normal'", async () => {
    const r = await authedFetch("/v1/jarvis/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(r.status).toBe(200);
    expect(notifyCalls[0]?.channels).toEqual(["auto"]);
    expect(notifyCalls[0]?.priority).toBe("normal");
  });

  test("POST /v1/jarvis/notify 400 on unknown channel", async () => {
    const r = await authedFetch("/v1/jarvis/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x", channels: ["pagers"] }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/context/vault-search forwards filter to provider", async () => {
    const r = await authedFetch("/v1/jarvis/context/vault-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "alice", type: "person", limit: 10 }),
    });
    expect(r.status).toBe(200);
    expect(contextCalls.length).toBe(1);
    expect(contextCalls[0]?.method).toBe("vaultSearch");
    expect(contextCalls[0]?.input).toEqual({
      query: "alice",
      type: "person",
      limit: 10,
    });
  });

  test("POST /v1/jarvis/context/vault-search 400 on invalid type", async () => {
    const r = await authedFetch("/v1/jarvis/context/vault-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "robot" }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/context/vault-get-entity forwards id", async () => {
    const r = await authedFetch("/v1/jarvis/context/vault-get-entity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ent_123" }),
    });
    expect(r.status).toBe(200);
    expect(contextCalls[0]?.method).toBe("vaultGetEntity");
    expect(contextCalls[0]?.input).toBe("ent_123");
  });

  test("POST /v1/jarvis/context/awareness-recent forwards limit/since", async () => {
    const r = await authedFetch("/v1/jarvis/context/awareness-recent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 5, since: 1000 }),
    });
    expect(r.status).toBe(200);
    expect(contextCalls[0]?.method).toBe("awarenessRecent");
    expect(contextCalls[0]?.input).toEqual({ limit: 5, since: 1000 });
  });

  test("POST /v1/jarvis/context/commitments-list forwards status filter", async () => {
    const r = await authedFetch("/v1/jarvis/context/commitments-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(r.status).toBe(200);
    expect(contextCalls[0]?.method).toBe("commitmentsList");
    expect(contextCalls[0]?.input).toEqual({ status: "in_progress" });
  });

  test("POST /v1/jarvis/context/commitments-list 400 on invalid status", async () => {
    const r = await authedFetch("/v1/jarvis/context/commitments-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("SandboxApi routes (G unconfigured -> 503)", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    return fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({
      signer,
      registry,
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
  });

  test("tools.invoke without toolsInvoke fn returns 503", async () => {
    const r = await authedFetch("/v1/jarvis/tools/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "x", params: {} }),
    });
    expect(r.status).toBe(503);
  });

  test("notify without notify fn returns 503", async () => {
    const r = await authedFetch("/v1/jarvis/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(r.status).toBe(503);
  });

  test("context routes without provider return 503", async () => {
    for (const path of [
      "/v1/jarvis/context/vault-search",
      "/v1/jarvis/context/vault-get-entity",
      "/v1/jarvis/context/awareness-recent",
      "/v1/jarvis/context/commitments-list",
    ]) {
      const r = await authedFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(503);
    }
  });
});

describe("SandboxApi routes (H: jarvis-agent/trigger)", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;
  let agentCalls: Array<{ goal: string; role?: string; maxIterations?: number }>;
  let pollCalls: Array<{
    eventType: string;
    since?: number;
    filter?: Record<string, unknown>;
    headOnly?: boolean;
  }>;
  let startCalls: Array<{ flowId: string; payload?: Record<string, unknown> }>;
  let pollReply: {
    events: Array<{
      id: string;
      eventType: string;
      payload: Record<string, unknown>;
      timestamp: number;
    }>;
    cursor: number;
  };

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    return fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    agentCalls = [];
    pollCalls = [];
    startCalls = [];
    pollReply = { events: [], cursor: 0 };
    api = new SandboxApi({
      signer,
      registry,
      services: {
        credentialResolver: new CredentialResolver(),
        agentDelegate: async (req) => {
          agentCalls.push(req);
          return { finalMessage: `done: ${req.goal}`, toolCalls: [], status: "completed" };
        },
        eventsPoll: async (req) => {
          pollCalls.push(req);
          return pollReply;
        },
        workflowsStart: async (req) => {
          startCalls.push(req);
          return { runId: "run_xyz" };
        },
      },
    });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(() => {
    agentCalls = [];
    pollCalls = [];
    startCalls = [];
    pollReply = { events: [], cursor: 0 };
  });

  test("POST /v1/jarvis/agent/delegate forwards goal/role/maxIterations", async () => {
    const r = await authedFetch("/v1/jarvis/agent/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "summarize inbox", role: "researcher", maxIterations: 5 }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { finalMessage: string; status: string };
    expect(body.status).toBe("completed");
    expect(body.finalMessage).toContain("summarize inbox");
    expect(agentCalls.length).toBe(1);
    expect(agentCalls[0]).toEqual({ goal: "summarize inbox", role: "researcher", maxIterations: 5 });
  });

  test("POST /v1/jarvis/agent/delegate 400 on missing goal", async () => {
    const r = await authedFetch("/v1/jarvis/agent/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "x" }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/agent/delegate 400 on non-integer maxIterations", async () => {
    const r = await authedFetch("/v1/jarvis/agent/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "x", maxIterations: 1.5 }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/events/poll forwards eventType+filter+since", async () => {
    pollReply = {
      events: [
        { id: "e1", eventType: "awareness.context_changed", payload: { app: "vscode" }, timestamp: 100 },
      ],
      cursor: 100,
    };
    const r = await authedFetch("/v1/jarvis/events/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "awareness.context_changed",
        filter: { app: "vscode" },
        since: 0,
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: unknown[]; cursor: number };
    expect(body.cursor).toBe(100);
    expect(body.events.length).toBe(1);
    expect(pollCalls.length).toBe(1);
    expect(pollCalls[0]?.eventType).toBe("awareness.context_changed");
    expect(pollCalls[0]?.since).toBe(0);
    expect(pollCalls[0]?.filter).toEqual({ app: "vscode" });
  });

  test("POST /v1/jarvis/events/poll 400 on missing eventType", async () => {
    const r = await authedFetch("/v1/jarvis/events/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ since: 0 }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/events/poll 400 on negative since", async () => {
    const r = await authedFetch("/v1/jarvis/events/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "x", since: -1 }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/workflows/start dispatches with flowId and payload", async () => {
    const r = await authedFetch("/v1/jarvis/workflows/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: "flow_abc", payload: { x: 1 } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { runId: string };
    expect(body.runId).toBe("run_xyz");
    expect(startCalls.length).toBe(1);
    expect(startCalls[0]?.flowId).toBe("flow_abc");
    expect(startCalls[0]?.payload).toEqual({ x: 1 });
  });

  test("POST /v1/jarvis/workflows/start 400 when flowId is missing", async () => {
    // `flowName` resolution was removed when the piece switched to a
    // single id-only flow_ref. `flowId` is now the only valid input.
    const r = await authedFetch("/v1/jarvis/workflows/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: {} }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /v1/jarvis/workflows/start 400 when flowId is empty", async () => {
    const r = await authedFetch("/v1/jarvis/workflows/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: "" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("SandboxApi routes (workflows/start error mapping)", () => {
  // The route maps typed errors (carrying `.code`) into specific HTTP
  // statuses so the piece's error message derives cleanly from status
  // instead of grepping the body. Each test below installs a fresh
  // stub that throws one of the typed errors and asserts the mapping.
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;
  let throwError: { code: string; message: string } | null = null;

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    return fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({
      signer,
      registry,
      services: {
        credentialResolver: new CredentialResolver(),
        workflowsStart: async () => {
          if (throwError) {
            const e = new Error(throwError.message);
            (e as { code?: string }).code = throwError.code;
            throw e;
          }
          return { runId: "run_xyz" };
        },
      },
    });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
  });

  async function start(): Promise<Response> {
    return authedFetch("/v1/jarvis/workflows/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: "flow_target" }),
    });
  }

  test("FLOW_NOT_FOUND -> 404", async () => {
    throwError = { code: "FLOW_NOT_FOUND", message: "flow not found: flow_target" };
    const r = await start();
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain("flow not found");
  });

  test("SELF_RECURSION -> 409", async () => {
    throwError = { code: "SELF_RECURSION", message: "refusing to start flow X from itself" };
    const r = await start();
    expect(r.status).toBe(409);
  });

  test("VERSION_MISSING -> 422", async () => {
    throwError = { code: "VERSION_MISSING", message: "flow X has no version" };
    const r = await start();
    expect(r.status).toBe(422);
  });

  test("unknown / untyped error falls through to 500", async () => {
    throwError = { code: "OTHER", message: "boom" };
    const r = await start();
    expect(r.status).toBe(500);
  });
});

describe("SandboxApi routes (H unconfigured -> 503)", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    return fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({
      signer,
      registry,
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
  });

  test("agent.delegate without fn returns 503", async () => {
    const r = await authedFetch("/v1/jarvis/agent/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "x" }),
    });
    expect(r.status).toBe(503);
  });

  test("events.poll without fn returns 503", async () => {
    const r = await authedFetch("/v1/jarvis/events/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "x", since: 0 }),
    });
    expect(r.status).toBe(503);
  });

  test("workflows.start without fn returns 503", async () => {
    const r = await authedFetch("/v1/jarvis/workflows/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: "x" }),
    });
    expect(r.status).toBe(503);
  });
});

describe("SandboxApi /v1/jarvis/* envelope hardening (G+H review #7)", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const id = sampleIdentity();
    const { token } = await signer.mint(id);
    registry.register({
      ...id,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
    return fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({
      signer,
      registry,
      services: {
        credentialResolver: new CredentialResolver(),
        // Wire every backend so we exercise the validation layer, not the 503 gate.
        llmChat: async () => ({ text: "" }),
        toolsInvoke: async () => ({ result: {}, toolName: "" }),
        notify: async () => ({ delivered: [], failed: [] }),
        contextProvider: {
          vaultSearch: async () => [],
          vaultGetEntity: async () => null,
          awarenessRecent: async () => [],
          commitmentsList: async () => [],
        },
        agentDelegate: async () => ({ finalMessage: "", toolCalls: [], status: "completed" }),
        eventsPoll: async () => ({ events: [], cursor: 7 }),
        workflowsStart: async () => ({ runId: "" }),
      },
    });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
  });

  const JSON_POST_PATHS = [
    "/v1/jarvis/llm/chat",
    "/v1/jarvis/tools/invoke",
    "/v1/jarvis/notify",
    "/v1/jarvis/context/vault-search",
    "/v1/jarvis/context/vault-get-entity",
    "/v1/jarvis/context/awareness-recent",
    "/v1/jarvis/context/commitments-list",
    "/v1/jarvis/agent/delegate",
    "/v1/jarvis/events/poll",
    "/v1/jarvis/workflows/start",
  ] as const;

  test("each /v1/jarvis/* POST returns 400 on malformed JSON", async () => {
    for (const path of JSON_POST_PATHS) {
      const r = await authedFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      });
      expect(r.status).toBe(400);
    }
  });

  test("each /v1/jarvis/* POST returns 400 on a non-object body", async () => {
    for (const path of JSON_POST_PATHS) {
      const r = await authedFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("hello"),
      });
      // Parsing succeeds (it's valid JSON), but field validation rejects.
      expect(r.status).toBe(400);
    }
  });

  test("/v1/jarvis/events/poll headOnly mode skips 'since' and returns the head cursor", async () => {
    const r = await authedFetch("/v1/jarvis/events/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "x", headOnly: true }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: unknown[]; cursor: number };
    expect(body.cursor).toBe(7);
    expect(body.events.length).toBe(0);
  });

  test("/v1/jarvis/events/poll without 'since' and without headOnly returns 400", async () => {
    const r = await authedFetch("/v1/jarvis/events/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "x" }),
    });
    expect(r.status).toBe(400);
  });

  test("each /v1/jarvis/* POST handles a 256KB+ payload without crashing", async () => {
    // The store route caps at 500KB; the jarvis routes have no explicit cap
    // but should still parse and reject on field-validation rather than
    // crashing the server. We send a fat valid JSON body and assert the
    // server replies (any 4xx/2xx is fine -- we're not asserting outcome,
    // just liveness under a realistic body size).
    const big = "x".repeat(256 * 1024);
    for (const path of JSON_POST_PATHS) {
      const r = await authedFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pad: big, message: "x", goal: "x", id: "x", toolName: "x", eventType: "x", since: 0, flowId: "x", prompt: "x" }),
      });
      expect(r.status).toBeLessThan(500);
    }
  });
});
