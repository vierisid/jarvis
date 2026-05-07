/**
 * Tests for the SandboxApi skeleton: token mint+verify, registry lifecycle,
 * HTTP server boot, auth middleware, and the one stub route currently wired
 * (`GET /v1/worker/project`). Subsequent commits will add tests as more
 * endpoints land.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { EngineTokenSigner } from "./engine-token";
import { SandboxRegistry } from "./sandbox-registry";
import { SandboxApi } from "./server";
import { DEFAULT_IDS } from "../db/schema";

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

  beforeAll(() => {
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({ signer, registry });
    api.start({ port: 0 });
  });

  afterAll(() => {
    api.stop();
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
