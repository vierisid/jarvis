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
