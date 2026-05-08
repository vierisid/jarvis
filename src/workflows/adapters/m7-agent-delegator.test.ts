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
import type { SubAgentResult } from "../../agents/sub-agent-runner";
import {
  M7AgentDelegator,
  extractToolCallsTrace,
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
    const trace = extractToolCallsTrace(messages, 1000);
    expect(trace).toHaveLength(2);
    expect(trace[0]).toEqual({
      name: "vault_search",
      args: JSON.stringify({ q: "X" }),
      result: "found 3 entities",
    });
    expect(trace[1]?.name).toBe("browser_open");
    expect(trace[1]?.result).toBe("page title: X");
  });

  test("surfaces authority denials + execution errors as `error`", () => {
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
    const trace = extractToolCallsTrace(messages, 1000);
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
    const trace = extractToolCallsTrace(messages, 100);
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
    const trace = extractToolCallsTrace(messages, 1000);
    expect(trace).toHaveLength(1);
    expect(trace[0]?.result).toBeUndefined();
    expect(trace[0]?.error).toBeUndefined();
  });
});
