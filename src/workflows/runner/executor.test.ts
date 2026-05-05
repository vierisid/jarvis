import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion, updateDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";
import { enqueue } from "../db/repos/job-queue";
import { Worker } from "../queue/worker";
import { jarvisAskPiece } from "../jarvis-pieces/jarvis-ask";
import { jarvisNotifyPiece } from "../jarvis-pieces/jarvis-notify";
import { jarvisToolPiece } from "../jarvis-pieces/jarvis-tool";
import {
  JarvisPieceRegistry,
  type PieceLlmClient,
  type PieceLlmInput,
  type PieceLlmResponse,
  type PieceNotifier,
  type PieceNotifyInput,
  type PieceNotifyResult,
  type PieceToolDescription,
  type PieceToolRegistry,
} from "../jarvis-pieces/types";
import { createRunFlowHandler, RUN_FLOW } from "./handler";
import { JarvisPiecesFlowExecutor } from "./executor";

const silent = () => undefined;

class FakeLlm implements PieceLlmClient {
  public calls: PieceLlmInput[] = [];
  constructor(private readonly reply: PieceLlmResponse) {}
  async chat(input: PieceLlmInput): Promise<PieceLlmResponse> {
    this.calls.push(input);
    return this.reply;
  }
}

class FakeNotifier implements PieceNotifier {
  public calls: PieceNotifyInput[] = [];
  constructor(private readonly result: PieceNotifyResult = { delivered: ["telegram"], failed: [] }) {}
  async notify(input: PieceNotifyInput): Promise<PieceNotifyResult> {
    this.calls.push(input);
    return this.result;
  }
}

class FakeToolRegistry implements PieceToolRegistry {
  public calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  constructor(
    private readonly tools: Record<string, PieceToolDescription>,
    private readonly impl: (name: string, params: Record<string, unknown>) => Promise<unknown> = async () => "ok",
  ) {}
  has(name: string): boolean { return name in this.tools; }
  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, params });
    return this.impl(name, params);
  }
  describe(name: string): PieceToolDescription | null { return this.tools[name] ?? null; }
  listNames(): string[] { return Object.keys(this.tools); }
}

function makeRegistry(): JarvisPieceRegistry {
  const r = new JarvisPieceRegistry();
  r.register(jarvisAskPiece);
  r.register(jarvisNotifyPiece);
  r.register(jarvisToolPiece);
  return r;
}

beforeEach(() => {
  initWorkflowDb(":memory:");
});

afterEach(() => {
  closeWorkflowDb();
});

/** Build the inbox-summary example: trigger -> jarvis-ask -> jarvis-notify */
function buildInboxSummaryFlow(): {
  flowId: string;
  versionId: string;
  triggerJson: Record<string, unknown>;
} {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "Morning briefing" });
  const trigger = {
    name: "trigger",
    type: "PIECE_TRIGGER",
    displayName: "Every morning at 8",
    settings: { pieceName: "schedule", triggerName: "every_day", input: { hour: 8 } },
    nextAction: {
      name: "summarize",
      type: "PIECE",
      displayName: "Summarize inbox",
      settings: {
        pieceName: "jarvis-ask",
        actionName: "ask",
        input: { prompt: "Summarize my inbox: {{trigger.subject}}" },
      },
      nextAction: {
        name: "send",
        type: "PIECE",
        displayName: "Send to me",
        settings: {
          pieceName: "jarvis-notify",
          actionName: "notify",
          input: { message: "{{summarize.text}}", channels: ["telegram"], priority: "normal" },
        },
      },
    },
  };
  updateDraftVersion(version.id, { trigger });
  return { flowId: flow.id, versionId: version.id, triggerJson: trigger };
}

describe("JarvisPiecesFlowExecutor: end-to-end via handler + worker", () => {
  test("runs trigger -> jarvis-ask -> jarvis-notify and persists step outputs", async () => {
    const { flowId, versionId } = buildInboxSummaryFlow();
    const llm = new FakeLlm({ text: "You have 3 emails from boss." });
    const notifier = new FakeNotifier();
    const executor = new JarvisPiecesFlowExecutor({
      registry: makeRegistry(),
      services: { llm, notifier },
    });

    const run = createFlowRun({ flowId, flowVersionId: versionId });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: { subject: "Re: launch plan" } },
      flowRunId: run.id,
    });
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    });
    await worker.drain();

    const after = getFlowRun(run.id);
    expect(after?.status).toBe("SUCCEEDED");
    expect(after?.stepsCount).toBe(2);
    const steps = after?.steps as Record<string, { input: unknown; output: unknown }>;
    expect(steps.summarize?.input).toEqual({
      prompt: "Summarize my inbox: Re: launch plan",
    });
    expect((steps.summarize?.output as { text: string }).text).toBe(
      "You have 3 emails from boss.",
    );
    expect((steps.send?.input as { message: string }).message).toBe(
      "You have 3 emails from boss.",
    );
    // Notifier was called with the resolved message.
    expect(notifier.calls).toEqual([
      { message: "You have 3 emails from boss.", channels: ["telegram"], priority: "normal" },
    ]);
  });

  test("piece -> tool -> piece chains pass outputs across steps via templating", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "tool chain" });
    const trigger = {
      name: "trigger",
      type: "EMPTY",
      displayName: "Manual",
      settings: {},
      nextAction: {
        name: "do_thing",
        type: "PIECE",
        settings: {
          pieceName: "jarvis-tool",
          actionName: "invoke",
          input: { toolName: "echo", params: { msg: "{{trigger.greet}}" } },
        },
        nextAction: {
          name: "tell_user",
          type: "PIECE",
          settings: {
            pieceName: "jarvis-notify",
            actionName: "notify",
            input: { message: "tool said: {{do_thing.result}}" },
          },
        },
      },
    };
    updateDraftVersion(version.id, { trigger });

    const tools = new FakeToolRegistry(
      { echo: { name: "echo", description: "", category: "demo", parameters: {} } },
      async (_name, params) => `echoed-${(params as { msg: string }).msg}`,
    );
    const notifier = new FakeNotifier();
    const executor = new JarvisPiecesFlowExecutor({
      registry: makeRegistry(),
      services: { toolRegistry: tools, notifier },
    });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: { greet: "hi" } },
      flowRunId: run.id,
    });
    await new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    }).drain();

    const after = getFlowRun(run.id);
    expect(after?.status).toBe("SUCCEEDED");
    expect(notifier.calls[0]?.message).toBe("tool said: echoed-hi");
  });

  test("unsupported action types fail the run with a named step", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "unsupported" });
    updateDraftVersion(version.id, {
      trigger: {
        name: "trigger",
        type: "EMPTY",
        settings: {},
        nextAction: {
          name: "loopy",
          type: "LOOP_ON_ITEMS",
          settings: { items: "{{trigger.list}}" },
        },
      } as unknown as Record<string, unknown>,
    });
    const executor = new JarvisPiecesFlowExecutor({ registry: makeRegistry(), services: {} });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: { list: [] } },
      flowRunId: run.id,
      maxAttempts: 1,
    });
    await new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    }).drain();

    const after = getFlowRun(run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep?.name).toBe("loopy");
  });

  test("references to unregistered pieces fail with a clear error", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "ghost piece" });
    updateDraftVersion(version.id, {
      trigger: {
        name: "trigger",
        type: "EMPTY",
        settings: {},
        nextAction: {
          name: "nope",
          type: "PIECE",
          settings: { pieceName: "ghost", actionName: "do" },
        },
      } as unknown as Record<string, unknown>,
    });
    const executor = new JarvisPiecesFlowExecutor({ registry: makeRegistry(), services: {} });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: {} },
      flowRunId: run.id,
      maxAttempts: 1,
    });
    await new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    }).drain();
    const after = getFlowRun(run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep?.name).toBe("nope");
  });

  test("piece input validation errors surface as step failures", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "bad input" });
    updateDraftVersion(version.id, {
      trigger: {
        name: "trigger",
        type: "EMPTY",
        settings: {},
        nextAction: {
          name: "ask_with_bad_input",
          type: "PIECE",
          settings: {
            pieceName: "jarvis-ask",
            actionName: "ask",
            input: { prompt: "" }, // jarvis-ask requires non-empty prompt
          },
        },
      } as unknown as Record<string, unknown>,
    });
    const executor = new JarvisPiecesFlowExecutor({
      registry: makeRegistry(),
      services: { llm: new FakeLlm({ text: "ok" }) },
    });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: {} },
      flowRunId: run.id,
      maxAttempts: 1,
    });
    await new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    }).drain();
    const after = getFlowRun(run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep?.name).toBe("ask_with_bad_input");
  });

  test("trigger-only flow (no actions) succeeds with empty steps", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "noop" });
    updateDraftVersion(version.id, {
      trigger: { name: "trigger", type: "EMPTY", settings: {} } as unknown as Record<string, unknown>,
    });
    const executor = new JarvisPiecesFlowExecutor({ registry: makeRegistry(), services: {} });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: {} },
      flowRunId: run.id,
    });
    await new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    }).drain();
    const after = getFlowRun(run.id);
    expect(after?.status).toBe("SUCCEEDED");
    expect(after?.stepsCount).toBe(0);
  });

  test("template error in a step's input fails the run with that step name", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "tpl-fail" });
    updateDraftVersion(version.id, {
      trigger: {
        name: "trigger",
        type: "EMPTY",
        settings: {},
        nextAction: {
          name: "ask_unknown_step",
          type: "PIECE",
          settings: {
            pieceName: "jarvis-ask",
            actionName: "ask",
            input: { prompt: "go {{ghost.field}}" },
          },
        },
      } as unknown as Record<string, unknown>,
    });
    const executor = new JarvisPiecesFlowExecutor({
      registry: makeRegistry(),
      services: { llm: new FakeLlm({ text: "ok" }) },
    });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: {} },
      flowRunId: run.id,
      maxAttempts: 1,
    });
    await new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    }).drain();
    const after = getFlowRun(run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep?.name).toBe("ask_unknown_step");
  });

  test("maxSteps cap stops a runaway chain", async () => {
    // Build a 6-step linear chain of jarvis-ask, then run with maxSteps=3.
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "long" });
    let chain: Record<string, unknown> | null = null;
    for (let i = 5; i >= 1; i--) {
      const node: Record<string, unknown> = {
        name: `step${i}`,
        type: "PIECE",
        settings: {
          pieceName: "jarvis-ask",
          actionName: "ask",
          input: { prompt: "x" },
        },
      };
      if (chain) (node as { nextAction?: unknown }).nextAction = chain;
      chain = node;
    }
    updateDraftVersion(version.id, {
      trigger: { name: "trigger", type: "EMPTY", settings: {}, nextAction: chain } as unknown as Record<string, unknown>,
    });
    const executor = new JarvisPiecesFlowExecutor({
      registry: makeRegistry(),
      services: { llm: new FakeLlm({ text: "ok" }) },
      maxSteps: 3,
    });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: {} },
      flowRunId: run.id,
      maxAttempts: 1,
    });
    await new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    }).drain();
    const after = getFlowRun(run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep?.name).toBe("step4");
    // First three steps captured before cap fired.
    expect(after?.stepsCount).toBe(3);
  });
});
