import { describe, expect, test } from "bun:test";
import { CONV_TOOLS, CONV_TOOL_NAMES } from "./conv-tools.ts";

const delegate = CONV_TOOLS.find((t) => t.name === "delegate")!;
const properties = delegate.parameters.properties as Record<string, { enum?: string[]; description?: string }>;
const tierParam = properties.tier!;

describe("the delegate tool's tier guidance", () => {
  test("routes workflow authoring to the high tier", () => {
    // The conversation model reads "automate my mornings" as ordinary tool
    // work and picks medium, which is the weaker model deciding how to phrase
    // the request and what to do with compose errors.
    const guidance = `${delegate.description} ${tierParam.description ?? ""}`.toLowerCase();
    expect(guidance).toContain("workflow");
    const afterHigh = guidance.slice(guidance.indexOf("high"));
    expect(afterHigh).toContain("workflow");
  });

  test("still offers all three task tiers", () => {
    // The hint must not narrow the choice: plenty of delegated work is
    // genuinely low or medium.
    expect(tierParam.enum).toEqual(["low", "medium", "high"]);
    expect(delegate.description).toContain("low for trivial");
    expect(delegate.description).toContain("medium for general tool work");
  });

  test("keeps medium as the stated default", () => {
    expect(tierParam.description).toContain('Default to "medium"');
  });
});

describe("CONV_TOOLS surface", () => {
  test("names match the intercept list the orchestrator filters on", () => {
    // The orchestrator intercepts by name; a tool present in one list and not
    // the other either never runs or leaks into the agent's real tool set.
    const intercepted: string[] = Object.values(CONV_TOOL_NAMES);
    const declared: string[] = CONV_TOOLS.map((t) => t.name);
    expect(intercepted.sort()).toEqual(declared.sort());
  });

  test("delegate requires the fields the dispatcher reads", () => {
    expect(delegate.parameters.required).toEqual(["tier", "template", "intent"]);
  });
});
