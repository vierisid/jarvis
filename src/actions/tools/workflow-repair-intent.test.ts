import { describe, expect, test } from "bun:test";
import { composeFlow, type ComposerChatReply, type ComposerLlmClient } from "./workflow-composer";
import { sampleCatalog } from "../../workflows/runtime/test-fixtures";

const request = {
  name: "Private weekly report",
  description: "Every Monday at 09:00 UTC, produce a Markdown summary of open tasks.\n" +
    "Notify only the dashboard. Do not email anyone, delete tasks, or include customer names.",
};
const flow = {
  displayName: request.name,
  trigger: {
    name: "trigger", type: "PIECE_TRIGGER",
    settings: { pieceName: "schedule", input: { cron_expression: "0 9 * * 1", timezone: "UTC" } },
    nextAction: {
      name: "summarize", type: "PIECE",
      settings: { pieceName: "jarvis-ask", actionName: "ask", input: {
        prompt: "Produce a Markdown summary of open tasks. Do not include customer names, email anyone, or delete tasks.",
      } },
      nextAction: {
        name: "report", type: "PIECE",
        settings: { pieceName: "jarvis-notify", actionName: "notify", input: {
          message: "{{summarize.text}}", channels: ["dashboard"],
        } },
      },
    },
  },
};
const valid = JSON.stringify(flow);
const invalid = valid.replace('"actionName":"ask"', '"actionName":"unknown_action"');
const malformed = valid.slice(0, -1);
const marker = "Composition context (JSON):\n";
function context(prompt: string) {
  expect(prompt).toContain(marker);
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
}
function expectIntent(prompt: string) {
  expect(context(prompt).jobSpecification).toEqual({ schemaVersion: 1, ...request });
  expect(prompt).toContain("negative constraints");
}
function expectFlow(result: Awaited<ReturnType<typeof composeFlow>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.flow.trigger.settings?.input).toEqual(flow.trigger.settings.input);
  expect(result.flow.trigger.nextAction?.settings?.input).toEqual(flow.trigger.nextAction.settings.input);
  expect(result.flow.trigger.nextAction?.nextAction?.settings?.input).toEqual(flow.trigger.nextAction.nextAction.settings.input);
}

describe("workflow repairs retain the job specification", () => {
  for (const first of [malformed, invalid]) {
    test(`one-shot ${first === malformed ? "parse" : "validation"} repair carries the entire request and candidate`, async () => {
      const prompts: string[] = [];
      const llm: ComposerLlmClient = { async chat({ prompt }) {
        prompts.push(prompt);
        return { text: prompts.length === 1 ? first : valid };
      } };
      const result = await composeFlow({ llm, pieceRegistry: sampleCatalog() }, request);
      expectFlow(result);
      expect(prompts).toHaveLength(2);
      expectIntent(prompts[1]!);
      expect(context(prompts[1]!).previousResponse).toBe(first);
      expect(context(prompts[1]!).previousGraph).toEqual(first === invalid ? JSON.parse(invalid) : null);
    });
  }

  test("successive repairs use the latest errors and retain the last graph after malformed text", async () => {
    const prompts: string[] = [];
    const replies = [invalid, malformed, valid];
    const llm: ComposerLlmClient = { async chat({ prompt }) {
      prompts.push(prompt);
      return { text: replies[prompts.length - 1]! };
    } };
    const result = await composeFlow({ llm, pieceRegistry: sampleCatalog() }, request);
    expectFlow(result);
    expect(prompts).toHaveLength(3);
    expectIntent(prompts[2]!);
    expect(context(prompts[2]!).previousResponse).toBe(malformed);
    expect(context(prompts[2]!).previousGraph).toEqual(JSON.parse(invalid));
    expect(context(prompts[2]!).errors).toHaveLength(1);
    expect(context(prompts[2]!).errors[0]).toContain("not valid JSON");
  });

  for (const first of [invalid, malformed]) {
    test(`tool-to-one-shot fallback retains ${first === invalid ? "invalid graph" : "malformed reply"}`, async () => {
      const prompts: string[] = [];
      const llm: ComposerLlmClient = {
        async chatTools() { return { content: first, tool_calls: [] }; },
        async chat({ prompt }) { prompts.push(prompt); return { text: valid }; },
      };
      expectFlow(await composeFlow({ llm, pieceRegistry: sampleCatalog() }, request));
      expectIntent(prompts[0]!);
      expect(context(prompts[0]!).previousResponse).toBe(first);
      expect(context(prompts[0]!).errors.length).toBeGreaterThan(0);
    });
  }

  for (const repair of ["submit", "inline", "malformed"] as const) {
    test(`tool-loop ${repair} repair gets explicit intent and candidate context`, async () => {
      const turns: string[][] = [];
      const llm: ComposerLlmClient = {
        async chat() { throw new Error("unexpected fallback"); },
        async chatTools(messages): Promise<ComposerChatReply> {
          turns.push(messages.map(m => m.content));
          if (turns.length === 1) return { content: "", tool_calls: [{ id: "discover", name: "list_pieces", arguments: {} }] };
          if (turns.length === 2) return repair === "submit"
            ? { content: "", tool_calls: [{ id: "draft", name: "submit_flow", arguments: JSON.parse(invalid) }] }
            : { content: repair === "inline" ? invalid : malformed, tool_calls: [] };
          return { content: "", tool_calls: [{ id: "fixed", name: "submit_flow", arguments: flow }] };
        },
      };
      expectFlow(await composeFlow({ llm, pieceRegistry: sampleCatalog() }, request));
      const repairPrompt = turns[2]!.at(-1)!;
      expectIntent(repairPrompt);
      expect(context(repairPrompt).previousResponse).toBe(repair === "malformed" ? malformed : invalid);
      expect(context(repairPrompt).errors.length).toBeGreaterThan(0);
    });
  }
});
