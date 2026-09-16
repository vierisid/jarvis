/** API save -> unmodified engine lookup -> installed native piece -> local provider. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createWorkflowRoutes } from "../../api/routes";
import { CredentialResolver } from "../../credentials/adapter";
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from "../../db";
import { setEncryptionKey } from "../../db/encryption";
import { createFlow } from "../../db/repos/flow";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { createDraftVersion, getFlowVersion, lockVersion, updateDraftVersion, type FlowTriggerNode } from "../../db/repos/flow-version";
import { workflowLogsBase } from "../../sandbox-api/config";
import { SandboxApi } from "../../sandbox-api/server";
import { buildEngineBundle, ENGINE_BUILD_PATHS, findCachedBundle } from "./build";
import { buildPiece } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";

const PIECE = "@activepieces/piece-native-lookup-fixture";
const TOKEN = "synthetic-native-engine-token";
const cached = findCachedBundle();
const skip = process.env.JARVIS_TEST_ENGINE_BUILD !== "1" && (!cached
  || !existsSync(join(ENGINE_BUILD_PATHS.STAGING_DIR, "node_modules/esbuild")));

// Bundled with the real framework and loaded by the engine's installed-piece
// loader. Neither credential lookup nor the action executor is mocked.
const fixtureSource = `
import { createAction, createPiece, PieceAuth, Property } from "@activepieces/pieces-framework";
const auth = PieceAuth.OAuth2({
  description: "Local fixture only", required: true, scope: [],
  authUrl: "http://127.0.0.1/unused", tokenUrl: "http://127.0.0.1/unused",
});
const check = createAction({
  name: "check", displayName: "Check local provider", description: "Fixture", auth,
  props: { endpoint: Property.ShortText({ displayName: "Endpoint", required: true }) },
  async run(context) {
    const response = await fetch(context.propsValue.endpoint, {
      headers: { Authorization: "Bearer " + context.auth.access_token },
    });
    if (!response.ok) throw new Error("Local provider rejected credentials");
    return response.json();
  },
});
export const nativeLookupFixture = createPiece({
  displayName: "Native lookup fixture", description: "Local tests only", auth,
  minimumSupportedRelease: "0.82.0", logoUrl: "", authors: [], actions: [check], triggers: [],
});
`;

describe("native credential engine integration", () => {
  let dir: string;
  let api: SandboxApi | undefined;
  let runtime: EngineRuntime | undefined;
  let provider: ReturnType<typeof Bun.serve> | undefined;
  const requests: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    if (skip) return;
    dir = mkdtempSync(join(tmpdir(), "jarvis-native-engine-"));
    initWorkflowDb(join(dir, "jarvis.db"));
    setEncryptionKey(Buffer.alloc(32, 19));
    const pieceDir = join(dir, "fixture");
    mkdirSync(join(pieceDir, "src"), { recursive: true });
    writeFileSync(join(pieceDir, "package.json"), JSON.stringify({ name: PIECE, version: "0.0.1" }));
    writeFileSync(join(pieceDir, "src/index.ts"), fixtureSource);
    await buildPiece(pieceDir);
    const installed = join(dir, "node_modules", PIECE);
    mkdirSync(dirname(installed), { recursive: true });
    symlinkSync(join(pieceDir, "dist"), installed, "dir");
    const resolver = new CredentialResolver();
    resolver.register({ id: "fixture", canResolve: id => id === "jarvis:fixture",
      resolve: async () => ({ type: "OAUTH2", value: { access_token: TOKEN } }) });
    api = new SandboxApi({ services: { credentialResolver: resolver } });
    await api.start({ port: 0 });
    runtime = new EngineRuntime({ api, bundlePath: (cached ?? await buildEngineBundle()).bundlePath,
      cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, "code") });
    provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      requests.push(auth);
      return Response.json({ accepted: auth === "Bearer " + TOKEN }, { status: auth === "Bearer " + TOKEN ? 200 : 401 });
    } });
  }, 120_000);

  afterAll(async () => {
    await runtime?.shutdown();
    await api?.stop();
    provider?.stop(true);
    closeWorkflowDb();
    setEncryptionKey(null);
    for (const runId of runIds) rmSync(join(workflowLogsBase(), runId + ".bin"), { force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function save(externalId: string, pieceName = PIECE) {
    const response = await createWorkflowRoutes()["/api/workflows/connections"]!.POST!(new Request("http://localhost/api/workflows/connections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId, pieceName, pieceVersion: "0.0.1", displayName: "Fixture",
        type: "OAUTH2", value: { access_token: TOKEN, token_type: "Bearer" } }),
    }));
    expect(response.status).toBe(201);
  }

  async function execute(externalId: string) {
    const flow = createFlow();
    const trigger: FlowTriggerNode = { name: "trigger", type: "EMPTY", settings: {}, nextAction: {
      name: "check", type: "PIECE", settings: { pieceName: PIECE, pieceVersion: "0.0.1", actionName: "check",
        input: { auth: "{{connections['" + externalId + "']}}", endpoint: `http://127.0.0.1:${provider!.port}/check` } },
    } };
    const version = createDraftVersion({ flowId: flow.id, displayName: "Native connection", trigger });
    updateDraftVersion(version.id, { trigger, valid: true });
    lockVersion(version.id);
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: "TESTING" });
    runIds.push(run.id);
    const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
    try {
      const result = await handle.executeFlow({ flowVersion: getFlowVersion(version.id)!, timeoutInSeconds: 15 });
      expect(getFlowRun(run.id)?.status).toBe(result.status);
      return result;
    } finally { await handle.release(); }
  }

  test.skipIf(skip)("an API-saved native connection reaches the local provider through the real engine", async () => {
    await save("native-provider");
    const count = requests.length;
    expect((await execute("native-provider")).status).toBe("SUCCEEDED");
    expect(requests.slice(count)).toEqual(["Bearer " + TOKEN]);
  }, 45_000);

  test.skipIf(skip)("duplicate native IDs stop the engine before the provider is called", async () => {
    await save("ambiguous", PIECE);
    await save("ambiguous", "other-piece");
    const count = requests.length;
    expect((await execute("ambiguous")).status).toBe("FAILED");
    expect(requests.length).toBe(count);
  }, 45_000);

  test.skipIf(skip)("managed sources still reach the provider through the same engine request", async () => {
    const count = requests.length;
    expect((await execute("jarvis:fixture")).status).toBe("SUCCEEDED");
    expect(requests.slice(count)).toEqual(["Bearer " + TOKEN]);
  }, 45_000);
});
