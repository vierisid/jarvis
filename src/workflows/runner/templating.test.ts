import { describe, expect, test } from "bun:test";
import { resolveTemplate, TemplateError, type StepOutputs } from "./templating";

const outputs: StepOutputs = {
  trigger: { foo: "bar", n: 42 },
  step1: { result: "hello", items: [{ title: "first" }, { title: "second" }] },
  step2: { nested: { deep: { value: true } } },
  step3: 7,
};

describe("resolveTemplate: strings", () => {
  test("plain string passes through", () => {
    expect(resolveTemplate("plain", outputs)).toBe("plain");
  });

  test("inline replacement stringifies primitives", () => {
    expect(resolveTemplate("n is {{trigger.n}}", outputs)).toBe("n is 42");
    expect(resolveTemplate("got: {{trigger.foo}}!", outputs)).toBe("got: bar!");
  });

  test("inline replacement JSON-stringifies objects", () => {
    expect(resolveTemplate("data: {{step2.nested}}", outputs)).toBe(
      'data: {"deep":{"value":true}}',
    );
  });

  test("whole-template returns the value preserving type", () => {
    expect(resolveTemplate("{{trigger.n}}", outputs)).toBe(42);
    expect(resolveTemplate("{{step2.nested.deep.value}}", outputs)).toBe(true);
    expect(resolveTemplate("{{step1.items}}", outputs)).toEqual([
      { title: "first" },
      { title: "second" },
    ]);
    expect(resolveTemplate("{{step3}}", outputs)).toBe(7);
  });

  test("array index access", () => {
    expect(resolveTemplate("{{step1.items.0.title}}", outputs)).toBe("first");
    expect(resolveTemplate("Top: {{step1.items.1.title}}", outputs)).toBe("Top: second");
  });

  test("null/undefined inline => empty string", () => {
    const o = { ...outputs, step4: { val: null } } as StepOutputs;
    expect(resolveTemplate("a={{step4.val}}b", o)).toBe("a=b");
  });
});

describe("resolveTemplate: structures", () => {
  test("walks objects recursively", () => {
    const got = resolveTemplate(
      { greeting: "hi {{trigger.foo}}", count: "{{trigger.n}}" },
      outputs,
    );
    expect(got).toEqual({ greeting: "hi bar", count: 42 });
  });

  test("walks arrays recursively", () => {
    const got = resolveTemplate(["{{trigger.foo}}", "literal", "{{trigger.n}}"], outputs);
    expect(got).toEqual(["bar", "literal", 42]);
  });

  test("primitives pass through", () => {
    expect(resolveTemplate(5, outputs)).toBe(5);
    expect(resolveTemplate(true, outputs)).toBe(true);
    expect(resolveTemplate(null, outputs)).toBeNull();
  });
});

describe("resolveTemplate: errors", () => {
  test("unknown step throws TemplateError", () => {
    expect(() => resolveTemplate("{{ghost.field}}", outputs)).toThrow(TemplateError);
  });

  test("missing field throws", () => {
    expect(() => resolveTemplate("{{trigger.missing}}", outputs)).toThrow(/missing field/);
  });

  test("array index out of range throws", () => {
    expect(() => resolveTemplate("{{step1.items.99.title}}", outputs)).toThrow(/out of range/);
  });

  test("descending into a primitive throws", () => {
    expect(() => resolveTemplate("{{step3.foo}}", outputs)).toThrow(/cannot descend/);
  });
});
