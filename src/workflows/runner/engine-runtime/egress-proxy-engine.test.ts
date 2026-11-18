/**
 * The egress proxy against a real engine (#1153): a CODE step's own fetch,
 * which no per-step guard sees, is held to the install's egress rule.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow, setFlowCodeStepsEnabled } from "../../db/repos/flow";
import { createDraftVersion, getFlowVersion, updateDraftVersion, type FlowTriggerNode } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { buildEngineBundle, findCachedBundle, ENGINE_BUILD_PATHS } from "./build";
import { buildAllJarvisPieces } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const piecesBuilt = existsSync(resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis/test/dist/src/index.js"));
const skip = (findCachedBundle() === null || !piecesBuilt) && !buildOptIn;

describe("the engine's egress proxy", () => {
  let api: SandboxApi;
  let bundle: { bundlePath: string; digest: string | null };

  beforeAll(async () => {
    if (skip) return;
    initWorkflowDb(":memory:");
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ port: 0 });
    bundle = findCachedBundle() ?? (await buildEngineBundle());
    if (buildOptIn) await buildAllJarvisPieces();
  }, 600_000);

  afterAll(async () => {
    if (skip) return;
    await api.stop();
    closeWorkflowDb();
  });

  async function probe(runtime: EngineRuntime): Promise<{ status: number | string; refused: string | null; proxied: boolean }> {
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const trigger: FlowTriggerNode = {
      name: "trigger",
      type: "PIECE_TRIGGER",
      displayName: "Manual",
      settings: { pieceName: "@jarvispieces/piece-jarvis-test", pieceVersion: "0.0.1", triggerName: "manual", input: { payload: {} } },
      nextAction: {
        name: "probe",
        type: "CODE",
        displayName: "Probe",
        settings: {
          input: {},
          sourceCode: {
            packageJson: "{}",
            code:
              "exports.code = async () => {" +
              "  let status, refused = null;" +
              "  try {" +
              "    const r = await fetch('http://169.254.169.254/latest/meta-data/', { signal: AbortSignal.timeout(5000) });" +
              "    status = r.status; refused = r.headers.get('x-jarvis-egress');" +
              "  } catch (e) { status = e.code || e.name; }" +
              "  return { egressProbe: { status, refused, proxied: Boolean(process.env.HTTPS_PROXY) } };" +
              "};",
          },
        },
      },
    };
    const v = createDraftVersion({ flowId: flow.id, displayName: "egress-probe", trigger });
    updateDraftVersion(v.id, { trigger, valid: true });
    setFlowCodeStepsEnabled(flow.id, true);
    const run = createFlowRun({ flowId: flow.id, flowVersionId: v.id, environment: "TESTING" });
    const handle = await runtime.acquire({ runId: run.id, projectId: DEFAULT_IDS.project, flowId: flow.id });
    try {
      const done = await handle.executeFlow({ flowVersion: getFlowVersion(v.id)!, streamStepProgress: "WEBSOCKET", runEnvironment: "TESTING" });
      expect(done.status).toBe("SUCCEEDED");
      return findKey(getFlowRun(run.id)?.steps, "egressProbe") as never;
    } finally {
      await handle.release();
    }
  }

  test.skipIf(skip)("a CODE step's fetch to the metadata address is refused by the proxy, not sent", async () => {
    for (const egressPolicy of ["public-only", "private-allowed"] as const) {
      const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest, egressPolicy });
      try {
        expect(await probe(runtime)).toEqual({ status: 403, refused: "refused", proxied: true });
      } finally {
        await runtime.shutdown();
      }
    }
  }, 120_000);

  test.skipIf(skip)("egressProxy: false starts the engine with no proxy", async () => {
    const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest, egressProxy: false });
    try {
      const result = await probe(runtime);
      expect(result.proxied).toBe(false);
      expect(result.refused).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);
});

function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && key in value) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
