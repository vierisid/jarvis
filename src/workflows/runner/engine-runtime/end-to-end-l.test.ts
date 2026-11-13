/**
 * Phase L plumbing smoke (gated on JARVIS_TEST_ENGINE_BUILD=1).
 *
 * Validates the same surface the proposal called out for the gmail end-to-end
 * smoke -- connection resolver, store, run-progress, full plumbing -- without
 * dragging in `googleapis` and friends. Uses the `jarvis-validate` test
 * piece, which declares `PieceAuth.OAuth2` so the engine has to round-trip
 * the connection through `/v1/worker/app-connections/:externalId`.
 *
 * Real `gmail` smoke is a follow-up that needs a per-piece dep-install layer
 * for community pieces (vendoring `googleapis` + transitive deps so the
 * piece bundle compiles standalone).
 *
 * What this test asserts:
 *   - The engine resolves `{{connections['jarvis:validate']}}` against the
 *     `CredentialResolver`, forwarding our registered OAuth2 source's value.
 *   - The action's `context.auth.access_token` matches what the source minted.
 *   - `context.store.put` + `context.store.get` round-trip through
 *     `/v1/store-entries`.
 *   - The flow_run row reaches `SUCCEEDED` after `executeFlow` resolves
 *     (exercises the `EngineFlowExecutor`'s race-tolerant terminal-status
 *     wait, post K-review).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../../db";
import { graphDigest } from "../../runtime/continuation";
import { PieceCatalog, metadataToCatalogEntry } from "../../runtime/piece-catalog";
import { compileWorkflow } from "../../runtime/workflow-readiness";
import { createFlow } from "../../db/repos/flow";
import {
  createDraftVersion,
  getFlowVersion,
  lockVersion,
  updateDraftVersion,
} from "../../db/repos/flow-version";
import type { FlowTriggerNode } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import {
  CredentialResolver,
  type JarvisConnectionSource,
} from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import {
  buildEngineBundle,
  ENGINE_BUILD_PATHS,
  findCachedBundle,
} from "./build";
import { buildAllJarvisPieces } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";
import { EngineFlowExecutor } from "./engine-flow-executor";
import type { Job } from "../../db/repos/job-queue";
import type { RunFlowJobPayload } from "../handler";

const require = createRequire(import.meta.url);
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipBundleTests = initialCached === null && !buildOptIn;
const piecesAlreadyBuilt = existsSync(
  resolve(
    ENGINE_BUILD_PATHS.VENDOR_PACKAGES,
    "pieces/jarvis/validate/dist/src/index.js",
  ),
);
const skipE2eTests = skipBundleTests || (!piecesAlreadyBuilt && !buildOptIn);

const PIECE_TEST_NAME = "@jarvispieces/piece-jarvis-test";
const PIECE_VALIDATE_NAME = "@jarvispieces/piece-jarvis-validate";
const PIECE_VERSION = "0.0.1";
const FAKE_TOKEN = "test-access-token-zzz";
const CONNECTION_EXTERNAL_ID = "jarvis:validate";

describe("Phase L: plumbing smoke (connection resolver + store + run-progress)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;

  const validateSource: JarvisConnectionSource = {
    id: "validate",
    pieceNames: [PIECE_VALIDATE_NAME],
    canResolve: (externalId) => externalId === CONNECTION_EXTERNAL_ID,
    resolve: async () => ({
      type: "OAUTH2",
      value: {
        access_token: FAKE_TOKEN,
        refresh_token: "",
        scope: ["test.read", "test.write"].join(" "),
      },
    }),
  };

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    const credentialResolver = new CredentialResolver();
    credentialResolver.register(validateSource);
    api = new SandboxApi({ services: { credentialResolver } });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath, expectedDigest: cached.digest });
  });

  afterAll(async () => {
    // Engines first: reclaim anything this runtime spawned while the
    // SandboxApi it talks to is still up (#491).
    await runtime?.shutdown();
    await api.stop();
    closeWorkflowDb();
  });

  /** Runs one validate step with `input` through the production executor and returns its envelope. */
  async function runValidate(input: Record<string, unknown>) {
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const trigger: FlowTriggerNode = {
      name: "trigger",
      type: "PIECE_TRIGGER",
      displayName: "Manual",
      settings: {
        pieceName: PIECE_TEST_NAME,
        pieceVersion: PIECE_VERSION,
        triggerName: "manual",
        input: { payload: {} },
      },
      nextAction: {
        name: "step_validate",
        type: "PIECE",
        displayName: "Validate plumbing",
        settings: {
          pieceName: PIECE_VALIDATE_NAME,
          pieceVersion: PIECE_VERSION,
          actionName: "validate",
          input,
        },
      },
    };
    const v = createDraftVersion({ flowId: flow.id, displayName: "L plumbing", trigger });
    updateDraftVersion(v.id, { trigger, valid: true });
    lockVersion(v.id);
    const run = createFlowRun({ flowId: flow.id, flowVersionId: v.id, environment: "TESTING" });
    // The graph the RUN_FLOW handler records before the engine starts.
    getWorkflowDb().run("UPDATE flow_run SET graph_digest = ? WHERE id = ?", [graphDigest(trigger), run.id]);
    // Drive through the production EngineFlowExecutor (not the raw handle)
    // so the K-review's race-tolerant terminal-status wait is exercised.
    const executor = new EngineFlowExecutor(runtime!);
    const result = await executor.execute({
      run: getFlowRun(run.id)!,
      version: getFlowVersion(v.id)!,
      job: { id: "job_l", payload: { runId: run.id, payload: {}, executeTrigger: false } } as unknown as Job<RunFlowJobPayload>,
      payload: {},
    });
    return { trigger, result, persisted: getFlowRun(run.id) };
  }

  test.skipIf(skipE2eTests)(
    "OAuth2 connection round-trips through credential resolver; store r/w lands; run SUCCEEDS",
    async () => {
      // The `auth` key uses upstream's `{{connections['<externalId>']}}`
      // template syntax. The engine's props-resolver dereferences it
      // by calling /v1/worker/app-connections/<externalId>, which
      // dispatches to our CredentialResolver -> validateSource.
      const { result, persisted } = await runValidate({
        auth: `{{connections['${CONNECTION_EXTERNAL_ID}']}}`,
        storeValue: "round-trip-payload",
      });

      // Successful return means: engine processed flow; uploadRunLog landed
      // in time; run row is non-error; the executor's wait-for-terminal
      // logic settled.
      expect(result.stepsCount).toBeGreaterThanOrEqual(1);

      expect(persisted?.status).toBe("SUCCEEDED");

      // Engine wraps each action's return in a StepOutput envelope:
      //   steps.<stepName>.output = { type: "PIECE", status, input, output, duration }
      // The actual return-value-from-the-piece lives at the inner `.output`.
      const stepRecord = (persisted?.steps ?? {}) as Record<string, unknown>;
      const validateStep = stepRecord["step_validate"] as
        | {
            output?: {
              status?: string;
              input?: Record<string, unknown>;
              output?: Record<string, unknown>;
            };
          }
        | undefined;
      const envelope = validateStep?.output ?? {};
      expect(envelope.status).toBe("SUCCEEDED");
      // The action's `auth` input is censored to "**REDACTED**" in the
      // recorded envelope (the engine never echoes connection values back
      // through progress streams) but the resolved value DID reach
      // context.auth -- proven by the accessToken in the output below.
      expect((envelope.input ?? {})["auth"]).toBe("**REDACTED**");
      const output = (envelope.output ?? {}) as Record<string, unknown>;
      expect(output["accessToken"]).toBe(FAKE_TOKEN);
      expect(output["storeValue"]).toBe("round-trip-payload");
      expect(output["storeReadBack"]).toBe("round-trip-payload");
      expect(output["projectId"]).toBe(DEFAULT_IDS.project);
    },
    60_000,
  );

  // F-28: the piece declares OAuth2, but its action does not need a connection.
  // A step without one must pass readiness (as the catalog the daemon builds
  // from the piece's metadata describes it) and run.
  test.skipIf(skipE2eTests)(
    "a validate step without a saved connection is ready, runs, and reports no token",
    async () => {
      const mod = require(resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis/validate/dist/src/index.js")) as {
        jarvisValidatePiece: { metadata(): unknown };
      };
      const entry = metadataToCatalogEntry({ ...(mod.jarvisValidatePiece.metadata() as object), name: PIECE_VALIDATE_NAME });
      expect(entry.auth).toBeDefined();
      const input = { storeValue: "no-connection" };
      const graph = {
        name: "trigger", type: "EMPTY",
        nextAction: { name: "step_validate", type: "PIECE", settings: { pieceName: PIECE_VALIDATE_NAME, actionName: "validate", input } },
      };
      const readiness = compileWorkflow(graph, { pieces: new PieceCatalog([entry]) });
      expect(readiness.issues).toEqual([]);
      expect(readiness.ready).toBe(true);

      // Not requiring a connection must not exempt one that is bound: the
      // binding is still checked against the saved, governed inventory.
      const bound = { ...input, auth: "{{connections['not-saved']}}" };
      const refused = compileWorkflow(
        { ...graph, nextAction: { ...graph.nextAction, settings: { ...graph.nextAction.settings, input: bound } } },
        { pieces: new PieceCatalog([entry]), connection: () => "Connection not-saved is not saved" },
      );
      expect(refused.ready).toBe(false);
      expect(refused.issues.map(i => i.code)).toContain("CONNECTION_BINDING");

      const { persisted } = await runValidate(input);
      expect(persisted?.status).toBe("SUCCEEDED");
      const step = ((persisted?.steps ?? {}) as Record<string, { output?: { status?: string; output?: Record<string, unknown> } }>)["step_validate"];
      expect(step?.output?.status).toBe("SUCCEEDED");
      expect(step?.output?.output?.["accessToken"]).toBeNull();
      expect(step?.output?.output?.["storeReadBack"]).toBe("no-connection");
    },
    60_000,
  );
});
