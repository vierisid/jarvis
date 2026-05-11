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
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
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
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
  });

  afterAll(async () => {
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)(
    "OAuth2 connection round-trips through credential resolver; store r/w lands; run SUCCEEDS",
    async () => {
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
            // The `auth` key uses upstream's `{{connections['<externalId>']}}`
            // template syntax. The engine's props-resolver dereferences it
            // by calling /v1/worker/app-connections/<externalId>, which
            // dispatches to our CredentialResolver -> validateSource.
            input: {
              auth: `{{connections['${CONNECTION_EXTERNAL_ID}']}}`,
              storeValue: "round-trip-payload",
            },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "L plumbing",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });

      // Drive through the production EngineFlowExecutor (not the raw handle)
      // so the K-review's race-tolerant terminal-status wait is exercised.
      const executor = new EngineFlowExecutor(runtime!);
      const result = await executor.execute({
        run: getFlowRun(run.id)!,
        version: getFlowVersion(v.id)!,
        job: {
          id: "job_l",
          payload: { runId: run.id, payload: {}, executeTrigger: false },
        } as unknown as Job<RunFlowJobPayload>,
        payload: {},
      });

      // Successful return means: engine processed flow; uploadRunLog landed
      // in time; run row is non-error; the executor's wait-for-terminal
      // logic settled.
      expect(result.stepsCount).toBeGreaterThanOrEqual(1);

      const persisted = getFlowRun(run.id);
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
});
