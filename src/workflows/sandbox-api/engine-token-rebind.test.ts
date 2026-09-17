/**
 * The token a rebound sandbox is NOT running under any more.
 *
 * The engine pool reuses one warm subprocess across runs, so
 * `SandboxRegistry.rebind()` re-points a single `sandboxId` at a new
 * `(runId, projectId)` and overwrites `record.engineToken`. Every token that
 * sandbox was ever handed keeps its valid signature for the rest of its TTL
 * (1 hour by default) and keeps carrying the OLD `projectId` claim, so an
 * auth middleware that only checks "is this sandbox still live" serves the
 * retired run -- under the retired run's project -- on every route that scopes
 * its work by `ctx.claims.projectId`.
 *
 * These tests pin the refusal, on both channels a token arrives on (the
 * `Authorization` header and the logs-upload `?token=`), and they pin the two
 * things the refusal must NOT break: the current token still works on every
 * route, and the logs-upload URL the engine bakes at EXECUTE_FLOW time is
 * regenerated per acquire so it still authenticates after a rebind.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EngineTokenSigner } from "./engine-token";
import { SandboxRegistry } from "./sandbox-registry";
import { SandboxApi } from "./server";
import { CredentialResolver } from "../credentials/adapter";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { DEFAULT_IDS } from "../db/schema";

const SANDBOX_ID = "sandbox-warm-across-runs";
const RETIRED_RUN = "run-retired";
const CURRENT_RUN = "run-current";
const RETIRED_PROJECT = "project-retired";
const CURRENT_PROJECT = "project-current";

let api: SandboxApi;
let signer: EngineTokenSigner;
let registry: SandboxRegistry;
/** Token minted for the run that has since been handed the engine back. */
let retiredToken: string;
/** Token minted for the run the sandbox is actually running under now. */
let currentToken: string;
let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
  initWorkflowDb(":memory:");
  // The logs route writes its upload under this root; keep these tests out of
  // the developer's real ~/.jarvis tree.
  dataDir = mkdtempSync(resolve(tmpdir(), "engine-token-rebind-"));
  previousDataDir = process.env.JARVIS_WORKFLOW_DATA_DIR;
  process.env.JARVIS_WORKFLOW_DATA_DIR = dataDir;
  signer = new EngineTokenSigner();
  registry = new SandboxRegistry();
  api = new SandboxApi({
    signer,
    registry,
    services: { credentialResolver: new CredentialResolver() },
  });
  await api.start({ port: 0 });

  // Cold acquire: mint + register, exactly as `EngineRuntime.spawnFresh()` does.
  const retired = await signer.mint(
    { sandboxId: SANDBOX_ID, runId: RETIRED_RUN, projectId: RETIRED_PROJECT },
    600,
  );
  retiredToken = retired.token;
  registry.register({
    sandboxId: SANDBOX_ID,
    runId: RETIRED_RUN,
    projectId: RETIRED_PROJECT,
    engineToken: retired.token,
    expiresAt: retired.expiresAt,
    terminatedAt: null,
  });

  // Warm acquire: mint + rebind, exactly as `EngineRuntime.acquire()` does on
  // the pooled path. Same sandboxId, same process, new run and project.
  const current = await signer.mint(
    { sandboxId: SANDBOX_ID, runId: CURRENT_RUN, projectId: CURRENT_PROJECT },
    600,
  );
  currentToken = current.token;
  registry.rebind(SANDBOX_ID, {
    runId: CURRENT_RUN,
    projectId: CURRENT_PROJECT,
    engineToken: current.token,
    expiresAt: current.expiresAt,
  });
});

afterEach(async () => {
  await api?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR;
  else process.env.JARVIS_WORKFLOW_DATA_DIR = previousDataDir;
  closeWorkflowDb();
});

const bearer = (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${api.baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });

describe("engine token acceptance after a warm-engine rebind", () => {
  test("the retired run's token is refused, and cannot report itself as the live run", async () => {
    const stale = await bearer(retiredToken, "/v1/worker/project");
    expect(stale.status).toBe(401);
    const body = (await stale.json()) as { error?: string };
    expect(body.error).toBe("engine token superseded");
    // The leak this closes: the retired token's OWN project id came back in
    // the response, so every claims-scoped route served the retired project.
    expect(JSON.stringify(body)).not.toContain(RETIRED_PROJECT);
  });

  test("the token the sandbox is currently running under still works", async () => {
    const live = await bearer(currentToken, "/v1/worker/project");
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      id: DEFAULT_IDS.project,
      externalId: CURRENT_PROJECT,
    });
  });

  test("a superseded token with a MATCHING runId is refused too, so a runId claim check would not do", async () => {
    // A paused run is resumed by re-acquiring the SAME runId: the pooled
    // acquire mints a fresh token and rebinds, and the pre-pause token keeps
    // a runId claim that agrees with the record. Comparing claims.runId to
    // record.runId would wave it straight through, which is why acceptance is
    // tied to the token the sandbox is running under instead.
    const prePause = await signer.mint(
      { sandboxId: SANDBOX_ID, runId: CURRENT_RUN, projectId: CURRENT_PROJECT },
      600,
    );
    // Distinct TTLs stand in for the distinct `iat` a real resume gets: the
    // claims are otherwise identical, and `iat` has one-second resolution, so
    // minting twice in the same tick would hand back the same bytes and the
    // test would be asserting nothing. No sleep needed to make them differ.
    const resumed = await signer.mint(
      { sandboxId: SANDBOX_ID, runId: CURRENT_RUN, projectId: CURRENT_PROJECT },
      900,
    );
    registry.rebind(SANDBOX_ID, {
      runId: CURRENT_RUN,
      projectId: CURRENT_PROJECT,
      engineToken: resumed.token,
      expiresAt: resumed.expiresAt,
    });
    expect(prePause.token).not.toBe(resumed.token);
    expect(registry.get(SANDBOX_ID)?.runId).toBe(CURRENT_RUN);

    expect((await bearer(prePause.token, "/v1/worker/project")).status).toBe(401);
    expect((await bearer(resumed.token, "/v1/worker/project")).status).toBe(200);
  });

  test("refusal covers the logs-upload ?token= channel as well as the header", async () => {
    // The engine PUTs its zstd run-log backup to a URL with the token baked
    // into the query string (upstream shapes it after a presigned URL), so the
    // check has to bite on that channel too or a retired token keeps a second
    // way in.
    const stale = await fetch(
      `${api.baseUrl}/v1/logs/${encodeURIComponent(RETIRED_RUN)}` +
        `?token=${encodeURIComponent(retiredToken)}`,
      { method: "PUT", body: "log-bytes" },
    );
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ error: "engine token superseded" });
  });

  test("the logs-upload URL the CURRENT run bakes still authenticates after the rebind", async () => {
    // The regression this guards: `EngineHandle.executeFlow()` builds
    // `logsUploadUrl` from the handle's own token, and the pooled acquire
    // builds a fresh handle carrying the freshly minted token before it sends
    // EXECUTE_FLOW. So the baked URL is regenerated per acquire and matches
    // the rebound record -- run-log uploads keep working. If that ever stops
    // being true, this test fails rather than production silently 401ing its
    // run logs.
    const record = registry.get(SANDBOX_ID);
    expect(record?.engineToken).toBe(currentToken);
    const baked =
      `${api.baseUrl}/v1/logs/${encodeURIComponent(CURRENT_RUN)}` +
      `?token=${encodeURIComponent(currentToken)}`;
    const upload = await fetch(baked, { method: "PUT", body: "log-bytes" });
    expect(upload.status).toBe(200);
    expect(await upload.json()).toMatchObject({ ok: true });
  });

  test("every authenticated route refuses the retired token and still accepts the current one", async () => {
    // Swept from the server's own route table rather than a list retyped
    // here, so a route added later is covered without an edit. The named
    // spot-checks below only assert the table still HOLDS the routes whose
    // blast radius motivated the care -- the sweep itself is what proves the
    // behaviour, on whatever the table currently contains.
    const routes = api.routeTable;
    const surface = routes.map((r) => `${r.method} ${r.path}`);
    for (const expected of [
      "GET /v1/worker/app-connections/:externalId",
      "POST /v1/jarvis/pieces/authorize",
      "POST /v1/jarvis/context/vault-search",
      "GET /v1/engine/populated-flows",
      "PUT /v1/logs/:runId",
    ]) {
      expect(surface).toContain(expected);
    }
    for (const route of routes) {
      // `:runId` has to agree with the token claims or the logs route answers
      // 403 on its own terms; every other param is an arbitrary sentinel.
      const path = route.path
        .replace(":runId", encodeURIComponent(CURRENT_RUN))
        .replace(/:[A-Za-z]+/g, "sentinel-param");
      const init: RequestInit =
        route.method === "GET" || route.method === "DELETE"
          ? { method: route.method }
          : {
              method: route.method,
              body: "{}",
              headers: { "content-type": "application/json" },
            };

      const stale = await bearer(retiredToken, path, init);
      expect(stale.status).toBe(401);
      expect(await stale.json()).toMatchObject({ error: "engine token superseded" });

      // The current token must still get past auth. What the handler then
      // answers (400 for a sentinel body, 404 for a sentinel id, 503 for an
      // unwired backend) is that route's own business -- the only forbidden
      // outcome is the auth 401.
      const live = await bearer(currentToken, path, init);
      expect(live.status).not.toBe(401);
    }
  });

  test("/health stays unauthenticated, so a rebind cannot break readiness probes", async () => {
    const r = await fetch(`${api.baseUrl}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, sandboxes: 1 });
  });

  test("a terminated sandbox is still refused before the token is compared", async () => {
    registry.terminate(SANDBOX_ID);
    const r = await bearer(currentToken, "/v1/worker/project");
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: "sandbox terminated" });
  });
});
