/**
 * Coverage for `M7AgentDelegator`. The orchestrator + sub-agent runner are
 * stubbed via the `runSubAgentFn` injection seam -- we don't spin up a real
 * LLM. Fixtures verify:
 *
 *   - role lookup with the configured default
 *   - `error` when the role is unknown
 *   - `error` when no primary agent exists
 *   - `completed` and `max_iterations` mappings from `terminationReason`
 *   - tool-call trace extraction (zip assistant tool_calls with tool results)
 *   - sub-agent always terminated, even on a thrown spawn / runner failure
 */

import { describe, expect, test } from "bun:test";
import type { LLMMessage } from "../../llm/provider";
import type { RoleDefinition } from "../../roles/types";
import type { RunSubAgentOptions, SubAgentPause, SubAgentResult } from "../../agents/sub-agent-runner";
import type { DelegationCheckpoint } from "../db/repos/delegation";
import {
  M7AgentDelegator,
  extractToolCallsTrace,
  type DelegationContinuation,
  type RunSubAgentFn,
} from "./m7-agent-delegator";

function makeRole(id: string, overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    id,
    name: id,
    description: `${id} role`,
    responsibilities: [],
    autonomous_actions: [],
    approval_required: [],
    kpis: [],
    communication_style: { tone: "direct", verbosity: "concise", formality: "adaptive" },
    heartbeat_instructions: "",
    sub_roles: [],
    tools: ["general"],
    authority_level: 2,
    ...overrides,
  };
}

function makeOrchestratorStub(opts: {
  primary?: { id: string; canSpawn: boolean };
  spawnImpl?: (parentId: string, role: RoleDefinition) => unknown;
}) {
  const calls: { spawn: number; terminate: string[]; spawnedRole: RoleDefinition | null } = {
    spawn: 0,
    terminate: [],
    spawnedRole: null,
  };
  const orchestrator = {
    getPrimary: () =>
      opts.primary
        ? {
            id: opts.primary.id,
            agent: { authority: { can_spawn_children: opts.primary.canSpawn } },
          }
        : undefined,
    spawnSubAgent: (parentId: string, role: RoleDefinition) => {
      calls.spawn += 1;
      calls.spawnedRole = role;
      if (opts.spawnImpl) return opts.spawnImpl(parentId, role);
      return {
        id: `child-${calls.spawn}`,
        agent: {
          role,
          authority: { allowed_tools: role.tools },
        },
        getMessages: () => [],
      };
    },
    terminateAgent: (id: string) => {
      calls.terminate.push(id);
    },
  };
  return { orchestrator, calls };
}

function makeSuccessRunner(messages: LLMMessage[] = [], finalText = "all done"): RunSubAgentFn {
  return async () => ({
    success: true,
    response: finalText,
    toolsUsed: [],
    tokensUsed: { input: 1, output: 1 },
    terminationReason: "completed",
    messages,
  } satisfies SubAgentResult);
}

describe("M7AgentDelegator", () => {
  test("returns status='error' when no primary agent is registered", async () => {
    const { orchestrator } = makeOrchestratorStub({});
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([["workflow-default", makeRole("workflow-default")]]),
      runSubAgentFn: makeSuccessRunner(),
    });
    const out = await delegator.delegate({ goal: "do thing" });
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/no primary agent/);
    expect(out.toolCalls).toEqual([]);
    expect(out.finalMessage).toBe("");
  });

  test("returns status='error' when the requested role is unknown", async () => {
    const { orchestrator } = makeOrchestratorStub({
      primary: { id: "primary", canSpawn: true },
    });
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([["existing-role", makeRole("existing-role")]]),
      runSubAgentFn: makeSuccessRunner(),
    });
    const out = await delegator.delegate({ goal: "x", role: "missing" });
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/unknown role "missing"/);
    expect(out.error).toMatch(/existing-role/);
  });

  test("falls back to the configured defaultRoleId when no role is supplied", async () => {
    const { orchestrator, calls } = makeOrchestratorStub({
      primary: { id: "primary", canSpawn: true },
    });
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([
        ["workflow-default", makeRole("workflow-default")],
        ["other", makeRole("other")],
      ]),
      runSubAgentFn: makeSuccessRunner([], "ok"),
    });
    const out = await delegator.delegate({ goal: "x" });
    expect(out.status).toBe("completed");
    expect(out.finalMessage).toBe("ok");
    expect(calls.spawnedRole?.id).toBe("workflow-default");
    expect(calls.terminate).toContain("child-1");
  });

  test("uses an explicit role override when supplied", async () => {
    const { orchestrator, calls } = makeOrchestratorStub({
      primary: { id: "primary", canSpawn: true },
    });
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([
        ["workflow-default", makeRole("workflow-default")],
        ["researcher", makeRole("researcher")],
      ]),
      runSubAgentFn: makeSuccessRunner(),
    });
    await delegator.delegate({ goal: "x", role: "researcher" });
    expect(calls.spawnedRole?.id).toBe("researcher");
  });

  test("maps terminationReason='max_iterations' to status='max_iterations'", async () => {
    const { orchestrator } = makeOrchestratorStub({
      primary: { id: "primary", canSpawn: true },
    });
    const runner: RunSubAgentFn = async () => ({
      success: true,
      response: "",
      toolsUsed: ["browser_open"],
      tokensUsed: { input: 0, output: 0 },
      terminationReason: "max_iterations",
      messages: [],
    });
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([["workflow-default", makeRole("workflow-default")]]),
      runSubAgentFn: runner,
    });
    const out = await delegator.delegate({ goal: "do", maxIterations: 1 });
    expect(out.status).toBe("max_iterations");
  });

  test("clamps maxIterations to the primary loop's ceiling of 200", async () => {
    const { orchestrator } = makeOrchestratorStub({
      primary: { id: "primary", canSpawn: true },
    });
    const seen: Array<number | undefined> = [];
    const runner: RunSubAgentFn = async (opts) => {
      seen.push(opts.maxIterations);
      return {
        success: true,
        response: "ok",
        toolsUsed: [],
        tokensUsed: { input: 0, output: 0 },
        terminationReason: "max_iterations",
        messages: [],
      };
    };
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([["workflow-default", makeRole("workflow-default")]]),
      runSubAgentFn: runner,
    });
    await delegator.delegate({ goal: "do", maxIterations: 5000 });
    await delegator.delegate({ goal: "do", maxIterations: 7 });
    expect(seen).toEqual([200, 7]);
  });

  test("maps terminationReason='error' to status='error' with the runner's message", async () => {
    const { orchestrator, calls } = makeOrchestratorStub({
      primary: { id: "primary", canSpawn: true },
    });
    const runner: RunSubAgentFn = async () => ({
      success: false,
      response: "Sub-agent error: LLM provider down",
      toolsUsed: [],
      tokensUsed: { input: 0, output: 0 },
      terminationReason: "error",
      messages: [],
    });
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([["workflow-default", makeRole("workflow-default")]]),
      runSubAgentFn: runner,
    });
    const out = await delegator.delegate({ goal: "x" });
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/LLM provider down/);
    expect(calls.terminate).toContain("child-1");
  });

  test("terminates the spawned sub-agent even when the runner throws", async () => {
    const { orchestrator, calls } = makeOrchestratorStub({
      primary: { id: "primary", canSpawn: true },
    });
    const runner: RunSubAgentFn = async () => {
      throw new Error("LLM exploded");
    };
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([["workflow-default", makeRole("workflow-default")]]),
      runSubAgentFn: runner,
    });
    const out = await delegator.delegate({ goal: "x" });
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/LLM exploded/);
    expect(calls.terminate).toHaveLength(1);
  });

  test("extracts tool-call trace from the runner's message log", async () => {
    const { orchestrator } = makeOrchestratorStub({
      primary: { id: "primary", canSpawn: true },
    });
    const transcript: LLMMessage[] = [
      { role: "system", content: "you are a sub-agent" },
      { role: "user", content: "find X" },
      {
        role: "assistant",
        content: "calling search",
        tool_calls: [{ id: "c1", name: "vault_search", arguments: { q: "X" } }],
      },
      { role: "tool", content: "found 3 entities", tool_call_id: "c1" },
      { role: "assistant", content: "X is foo." },
    ];
    const delegator = new M7AgentDelegator({
      orchestrator: orchestrator as never,
      llmManager: {} as never,
      specialists: new Map([["workflow-default", makeRole("workflow-default")]]),
      runSubAgentFn: makeSuccessRunner(transcript, "X is foo."),
    });
    const out = await delegator.delegate({ goal: "find X" });
    expect(out.status).toBe("completed");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toEqual({
      name: "vault_search",
      args: JSON.stringify({ q: "X" }),
      result: "found 3 entities",
    });
  });
});

describe("M7AgentDelegator with a continuation", () => {
  const identity = { id: "wfd_test", runId: "run", stepName: "delegate", executionPath: [] as Array<[string, number]>, versionDigest: "v1" };
  const pending: SubAgentPause = { toolCall: { id: "c1", name: "write_file", arguments: {} }, sequence: 1, actionCategory: "write_data",
    toolCategory: "file-ops", principal: { agentId: "child", agentRoleId: "workflow-default", agentAuthorityLevel: 10, profile: null },
    reason: "governed", approval: { effectId: "e", approvalId: "a", waitpointId: "w" }, remaining: [], iteration: 0 };
  const checkpoint = (over: Partial<DelegationCheckpoint>): DelegationCheckpoint => ({ ...identity, roleId: "workflow-default",
    goal: "find X", status: "running", messages: [], toolsUsed: [], tokensUsed: { input: 0, output: 0 }, sequence: 0, iteration: 1,
    taint: [], failedToolCalls: [], updatedAt: 0, ...over });
  function continuation(initial: DelegationCheckpoint | null = null) {
    let stored = initial;
    const c: DelegationContinuation = { identity, load: () => stored, save: cp => { stored = cp; },
      dispatch: async () => ({ kind: "executed", result: "ok" }) };
    return { c, stored: () => stored };
  }
  const delegator = (runner: RunSubAgentFn) => new M7AgentDelegator({
    orchestrator: makeOrchestratorStub({ primary: { id: "primary", canSpawn: true } }).orchestrator as never,
    llmManager: {} as never, specialists: new Map([["workflow-default", makeRole("workflow-default")]]), runSubAgentFn: runner });
  const neverRuns: RunSubAgentFn = async () => { throw new Error("should not run"); };

  test("a finished record answers without a new conversation, with the declaration asked now", async () => {
    const done = { finalMessage: "X is foo.", toolCalls: [{ name: "vault_search", result: "found" }], status: "completed" as const,
      outcome: { status: "succeeded" as const } };
    const { c } = continuation(checkpoint({ status: "completed", result: done }));
    const out = await delegator(neverRuns).delegate({ goal: "find X", requiredTools: ["write_file"] }, c);
    expect(out).toMatchObject({ status: "completed", finalMessage: "X is foo.", outcome: { status: "error", code: "REQUIRED_TOOL_NOT_COMPLETED" } });
    expect((await delegator(neverRuns).delegate({ goal: "find X" }, c)).outcome).toEqual({ status: "succeeded" });
  });

  test("a checkpoint bound to another version, goal or role refuses to resume", async () => {
    for (const [over, goal] of [[{ versionDigest: "v2" }, "find X"], [{}, "find Y"], [{ roleId: "other" }, "find X"]] as const) {
      const { c } = continuation(checkpoint({ status: "paused", pending, ...over }));
      const out = await delegator(neverRuns).delegate({ goal }, c);
      expect(out.status).toBe("error");
      expect(out.error).toMatch(/changed/);
    }
  });

  test("a running checkpoint resumes after its last completed turn, and a crash inside a turn leaves the last one in place", async () => {
    const { c, stored } = continuation(checkpoint({ status: "running", iteration: 2, sequence: 3, messages: [{ role: "user", content: "find X" }] }));
    let seen: RunSubAgentOptions["resume"];
    const crashed = delegator(async opts => {
      seen = opts.resume;
      opts.onTurn?.({ ...opts.resume!, iteration: 3, sequence: 4 });
      throw new Error("process died");
    });
    const out = await crashed.delegate({ goal: "find X" }, c);
    expect(seen).toMatchObject({ iteration: 2, sequence: 3 });
    expect(seen?.pending).toBeUndefined();
    expect(out.status).toBe("error");
    expect(stored()).toMatchObject({ status: "running", iteration: 3, sequence: 4 });
  });

  test("a pause is checkpointed with its pending call and answered as approval_required", async () => {
    const { c, stored } = continuation();
    const paused = delegator(async () => ({ success: true, response: "", toolsUsed: ["write_file"], tokensUsed: { input: 1, output: 1 },
      terminationReason: "paused", messages: [{ role: "assistant", content: "", tool_calls: [pending.toolCall] }], sequence: 1,
      failedToolCalls: [], taint: ["web_search"], paused: pending }));
    const out = await paused.delegate({ goal: "find X" }, c);
    expect(out).toMatchObject({ status: "approval_required", approval: pending.approval });
    expect(stored()).toMatchObject({ status: "paused", sequence: 1, iteration: 0, taint: ["web_search"], pending, roleId: "workflow-default", goal: "find X" });
  });

  test("an error the dispatch raised is this run's answer and leaves the checkpoint untouched", async () => {
    const before = checkpoint({ status: "paused", pending });
    const { c, stored } = continuation(before);
    const refused = delegator(async () => ({ success: false, response: "Sub-agent error: Workflow effect blocked: system paused",
      toolsUsed: [], tokensUsed: { input: 0, output: 0 }, terminationReason: "error", messages: [], dispatchError: true }));
    const out = await refused.delegate({ goal: "find X" }, c);
    expect(out).toMatchObject({ status: "error", error: expect.stringContaining("system paused") });
    expect(stored()).toBe(before);
  });

  test("a cancellation the runner reports answers canceled and writes nothing back", async () => {
    const before = checkpoint({ status: "running", iteration: 1, sequence: 1 });
    const { c, stored } = continuation(before);
    const stopped = delegator(async () => ({ success: false, response: "Sub-agent error: run stopped", toolsUsed: [],
      tokensUsed: { input: 0, output: 0 }, terminationReason: "error", messages: [], canceled: true }));
    const out = await stopped.delegate({ goal: "find X" }, c);
    expect(out).toMatchObject({ status: "canceled", outcome: { status: "error", code: "AGENT_CANCELED" } });
    expect(stored()).toBe(before);
  });
});

describe("extractToolCallsTrace", () => {
  test("zips assistant tool_calls with their matching tool results", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "find X" },
      {
        role: "assistant",
        content: "calling search",
        tool_calls: [
          { id: "call_1", name: "vault_search", arguments: { q: "X" } },
          { id: "call_2", name: "browser_open", arguments: { url: "https://x" } },
        ],
      },
      { role: "tool", content: "found 3 entities", tool_call_id: "call_1" },
      { role: "tool", content: "page title: X", tool_call_id: "call_2" },
      { role: "assistant", content: "X is foo." },
    ];
    const trace = extractToolCallsTrace(messages, 1000, new Set());
    expect(trace).toHaveLength(2);
    expect(trace[0]).toEqual({
      name: "vault_search",
      args: JSON.stringify({ q: "X" }),
      result: "found 3 entities",
    });
    expect(trace[1]?.name).toBe("browser_open");
    expect(trace[1]?.result).toBe("page title: X");
  });

  test("surfaces the calls the runner marked as `error`", () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", name: "shell_exec", arguments: { cmd: "rm -rf /" } },
          { id: "c2", name: "send_email", arguments: { to: "a" } },
        ],
      },
      {
        role: "tool",
        content: "[AUTHORITY DENIED] shell_exec: requires user approval",
        tool_call_id: "c1",
      },
      {
        role: "tool",
        content: "Error executing send_email: SMTP refused",
        tool_call_id: "c2",
      },
    ];
    const trace = extractToolCallsTrace(messages, 1000, new Set(["c1", "c2"]));
    expect(trace[0]?.error).toMatch(/AUTHORITY DENIED/);
    expect(trace[1]?.error).toMatch(/Error executing send_email/);
  });

  test("truncates long tool results", () => {
    const long = "a".repeat(2500);
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "fetch", arguments: {} }],
      },
      { role: "tool", content: long, tool_call_id: "c1" },
    ];
    const trace = extractToolCallsTrace(messages, 100, new Set());
    expect(trace[0]?.result).toMatch(/^a{100}\.\.\. \(truncated, was 2500 chars\)$/);
  });

  test("leaves orphan tool_calls (no matching tool message) without a result", () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "fetch", arguments: {} }],
      },
      // no tool reply (mid-loop crash)
    ];
    const trace = extractToolCallsTrace(messages, 1000, new Set());
    expect(trace).toHaveLength(1);
    expect(trace[0]?.result).toBeUndefined();
    expect(trace[0]?.error).toBeUndefined();
  });
});
