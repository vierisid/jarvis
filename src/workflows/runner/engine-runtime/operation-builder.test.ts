/**
 * Pure tests for the FlowVersion adapter, CODE materialization, and operation
 * builders. No engine spawn here -- those tests live in engine-runtime.test.ts.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  collectCodeActions,
  toUpstreamFlowVersion,
} from "./flow-version-adapter";
import { materializeCodeActions } from "./code-materialize";
import {
  buildExecuteFlowOperation,
  buildExtractPieceMetadataOperation,
} from "./operation-builder";
import type { FlowVersion } from "../../db/repos/flow-version";

function makeJarvisVersion(overrides: Partial<FlowVersion> = {}): FlowVersion {
  return {
    id: "v_1",
    flowId: "f_1",
    displayName: "Test flow",
    trigger: {
      name: "trigger",
      type: "EMPTY",
      displayName: "Manual",
    },
    state: "DRAFT",
    valid: true,
    schemaVersion: "20",
    updatedBy: null,
    agentIds: [],
    connectionIds: [],
    notes: [],
    backupFiles: null,
    engineListeners: null,
    engineSchedule: null,
    sampleData: null,
    sampleInput: null,
    created: 1000,
    updated: 2000,
    ...overrides,
  };
}

describe("toUpstreamFlowVersion", () => {
  test("converts epoch ms to ISO timestamps and fills lastUpdatedDate", () => {
    const out = toUpstreamFlowVersion(makeJarvisVersion());
    expect(out.created).toBe("1970-01-01T00:00:01.000Z");
    expect(out.updated).toBe("1970-01-01T00:00:02.000Z");
    expect(out.trigger.lastUpdatedDate).toBe(out.updated);
  });

  test("preserves EMPTY trigger settings as a plain object", () => {
    const out = toUpstreamFlowVersion(makeJarvisVersion());
    expect(out.trigger.type).toBe("EMPTY");
    expect(out.trigger.settings).toEqual({});
  });

  test("adapts PIECE_TRIGGER + nested CODE action chain", () => {
    const version = makeJarvisVersion({
      trigger: {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Webhook",
        settings: {
          pieceName: "@activepieces/piece-webhook",
          triggerName: "catch_webhook",
          input: { pathSuffix: "x" },
        },
        nextAction: {
          name: "step_1",
          type: "CODE",
          displayName: "Compute",
          settings: {
            sourceCode: { packageJson: "{}", code: "module.exports={};" },
            input: { x: 1 },
          },
        },
      },
    });
    const out = toUpstreamFlowVersion(version);
    expect(out.trigger.type).toBe("PIECE_TRIGGER");
    if (out.trigger.type !== "PIECE_TRIGGER") throw new Error("trigger type");
    expect(out.trigger.settings.pieceName).toBe("@activepieces/piece-webhook");
    expect(out.trigger.settings.triggerName).toBe("catch_webhook");
    expect(out.trigger.nextAction?.type).toBe("CODE");
    if (out.trigger.nextAction?.type !== "CODE") throw new Error("action type");
    expect(out.trigger.nextAction.settings.sourceCode.code).toBe("module.exports={};");
  });

  test("rejects unknown trigger types", () => {
    const v = makeJarvisVersion({
      trigger: { name: "t", type: "MYSTERY", settings: {} },
    });
    expect(() => toUpstreamFlowVersion(v)).toThrow();
  });

  test("recurses through LOOP_ON_ITEMS firstLoopAction", () => {
    const out = toUpstreamFlowVersion(
      makeJarvisVersion({
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "loop_1",
            type: "LOOP_ON_ITEMS",
            settings: { items: "{{x}}" },
            firstLoopAction: {
              name: "step_in_loop",
              type: "CODE",
              settings: {
                sourceCode: { packageJson: "{}", code: "module.exports={code:async()=>1};" },
                input: {},
              },
            },
          },
        },
      }),
    );
    if (out.trigger.nextAction?.type !== "LOOP_ON_ITEMS") throw new Error("loop");
    expect(out.trigger.nextAction.firstLoopAction?.name).toBe("step_in_loop");
  });
});

describe("collectCodeActions", () => {
  test("walks the whole tree including LOOP and ROUTER children", () => {
    const out = toUpstreamFlowVersion(
      makeJarvisVersion({
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "router_1",
            type: "ROUTER",
            settings: { branches: [], executionType: "EXECUTE_FIRST_MATCH" },
            children: [
              {
                name: "code_a",
                type: "CODE",
                settings: { sourceCode: { packageJson: "{}", code: "A" }, input: {} },
              },
              null,
              {
                name: "code_b",
                type: "CODE",
                settings: { sourceCode: { packageJson: "{}", code: "B" }, input: {} },
              },
            ],
            nextAction: {
              name: "code_c",
              type: "CODE",
              settings: { sourceCode: { packageJson: "{}", code: "C" }, input: {} },
            },
          },
        },
      }),
    );
    const codes = collectCodeActions(out).map((c) => c.code).sort();
    expect(codes).toEqual(["A", "B", "C"]);
  });
});

describe("materializeCodeActions", () => {
  test("writes one index.js per CODE action under <baseCodeDir>/<versionId>/<stepName>/", () => {
    const baseCodeDir = mkdtempSync(resolve(tmpdir(), "jarvis-mat-"));
    try {
      const version = toUpstreamFlowVersion(
        makeJarvisVersion({
          id: "v_1",
          trigger: {
            name: "trigger",
            type: "EMPTY",
            nextAction: {
              name: "compute",
              type: "CODE",
              settings: {
                sourceCode: {
                  packageJson: "{}",
                  code: "module.exports={code:async(i)=>({echo:i})};",
                },
                input: { hello: "world" },
              },
            },
          },
        }),
      );
      const result = materializeCodeActions(version, baseCodeDir);
      expect(result.written).toBe(1);
      expect(result.paths.length).toBe(1);
      const file = resolve(baseCodeDir, "v_1", "compute", "index.js");
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, "utf8");
      expect(content).toContain("module.exports");
    } finally {
      rmSync(baseCodeDir, { recursive: true, force: true });
    }
  });
});

describe("buildExecuteFlowOperation", () => {
  test("produces an EXECUTE_FLOW envelope with required fields", () => {
    const v = toUpstreamFlowVersion(makeJarvisVersion());
    const env = buildExecuteFlowOperation({
      flowVersion: v,
      flowRunId: "run_1",
      projectId: "proj_1",
      platformId: "plat_1",
      engineToken: "tok",
      internalApiUrl: "http://127.0.0.1:1234",
    });
    expect(env.operationType).toBe("EXECUTE_FLOW");
    expect(env.operation["flowRunId"]).toBe("run_1");
    expect(env.operation["projectId"]).toBe("proj_1");
    // ensureTrailingSlash applies
    expect(env.operation["internalApiUrl"]).toBe("http://127.0.0.1:1234/");
    expect(env.operation["executeTrigger"]).toBe(false);
    expect(env.operation["executionType"]).toBe("BEGIN");
  });
});

describe("buildExtractPieceMetadataOperation", () => {
  test("produces an EXTRACT_PIECE_METADATA envelope", () => {
    const env = buildExtractPieceMetadataOperation({
      pieceName: "@activepieces/piece-claude",
      pieceVersion: "0.1.0",
      platformId: "plat_1",
      engineToken: "tok",
      internalApiUrl: "http://127.0.0.1:1234/",
    });
    expect(env.operationType).toBe("EXTRACT_PIECE_METADATA");
    expect(env.operation["pieceName"]).toBe("@activepieces/piece-claude");
  });
});
