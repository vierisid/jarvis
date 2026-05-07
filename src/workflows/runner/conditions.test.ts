import { describe, expect, test } from "bun:test";
import { evaluateCondition, evaluateConditionGroups, type BranchCondition } from "./conditions";

const outputs = {
  trigger: {
    text: "Hello World",
    n: 7,
    flag: true,
    list: ["a", "b", "c"],
    empty: [],
    nullish: null,
  },
};

const c = (operator: string, firstValue: string, secondValue?: string, caseSensitive?: boolean): BranchCondition => {
  const cond: BranchCondition = { operator, firstValue };
  if (secondValue !== undefined) cond.secondValue = secondValue;
  if (caseSensitive !== undefined) cond.caseSensitive = caseSensitive;
  return cond;
};

describe("conditions: text operators", () => {
  test("TEXT_CONTAINS / DOES_NOT_CONTAIN; case-insensitive by default", () => {
    expect(evaluateCondition(c("TEXT_CONTAINS", "{{trigger.text}}", "world"), outputs)).toBe(true);
    expect(evaluateCondition(c("TEXT_CONTAINS", "{{trigger.text}}", "World"), outputs)).toBe(true);
    expect(evaluateCondition(c("TEXT_CONTAINS", "{{trigger.text}}", "World", true), outputs)).toBe(true);
    expect(evaluateCondition(c("TEXT_CONTAINS", "{{trigger.text}}", "world", true), outputs)).toBe(false);
    expect(evaluateCondition(c("TEXT_DOES_NOT_CONTAIN", "{{trigger.text}}", "xyz"), outputs)).toBe(true);
  });

  test("TEXT_EXACTLY_MATCHES / TEXT_DOES_NOT_EXACTLY_MATCH", () => {
    expect(evaluateCondition(c("TEXT_EXACTLY_MATCHES", "{{trigger.text}}", "hello world"), outputs)).toBe(true);
    expect(evaluateCondition(c("TEXT_EXACTLY_MATCHES", "{{trigger.text}}", "hello", true), outputs)).toBe(false);
    // Case-insensitive: "Hello World" !== "Hello" -> DOES_NOT_EXACTLY_MATCH true.
    expect(evaluateCondition(c("TEXT_DOES_NOT_EXACTLY_MATCH", "{{trigger.text}}", "Hello"), outputs)).toBe(true);
    // But "Hello World" === "Hello World" case-insensitive -> DOES_NOT_EXACTLY_MATCH false.
    expect(evaluateCondition(c("TEXT_DOES_NOT_EXACTLY_MATCH", "{{trigger.text}}", "Hello World"), outputs)).toBe(false);
  });

  test("TEXT_START_WITH / TEXT_ENDS_WITH variants", () => {
    expect(evaluateCondition(c("TEXT_START_WITH", "{{trigger.text}}", "hello"), outputs)).toBe(true);
    expect(evaluateCondition(c("TEXT_DOES_NOT_START_WITH", "{{trigger.text}}", "world"), outputs)).toBe(true);
    expect(evaluateCondition(c("TEXT_ENDS_WITH", "{{trigger.text}}", "world"), outputs)).toBe(true);
    expect(evaluateCondition(c("TEXT_DOES_NOT_END_WITH", "{{trigger.text}}", "hello"), outputs)).toBe(true);
  });
});

describe("conditions: number operators", () => {
  test("NUMBER_IS_GREATER_THAN / LESS_THAN / EQUAL_TO with numeric coercion", () => {
    expect(evaluateCondition(c("NUMBER_IS_GREATER_THAN", "{{trigger.n}}", "3"), outputs)).toBe(true);
    expect(evaluateCondition(c("NUMBER_IS_LESS_THAN", "{{trigger.n}}", "10"), outputs)).toBe(true);
    expect(evaluateCondition(c("NUMBER_IS_EQUAL_TO", "{{trigger.n}}", "7"), outputs)).toBe(true);
  });

  test("non-numeric values yield NaN, comparisons fail", () => {
    expect(evaluateCondition(c("NUMBER_IS_GREATER_THAN", "{{trigger.text}}", "1"), outputs)).toBe(false);
  });
});

describe("conditions: boolean / existence / list operators", () => {
  test("BOOLEAN_IS_TRUE / BOOLEAN_IS_FALSE", () => {
    expect(evaluateCondition(c("BOOLEAN_IS_TRUE", "{{trigger.flag}}"), outputs)).toBe(true);
    expect(evaluateCondition(c("BOOLEAN_IS_FALSE", "{{trigger.flag}}"), outputs)).toBe(false);
  });

  test("EXISTS / DOES_NOT_EXIST treat null + empty string as absent", () => {
    expect(evaluateCondition(c("EXISTS", "{{trigger.text}}"), outputs)).toBe(true);
    expect(evaluateCondition(c("EXISTS", "{{trigger.nullish}}"), outputs)).toBe(false);
    expect(evaluateCondition(c("DOES_NOT_EXIST", "{{trigger.nullish}}"), outputs)).toBe(true);
  });

  test("LIST_IS_EMPTY / LIST_IS_NOT_EMPTY", () => {
    expect(evaluateCondition(c("LIST_IS_EMPTY", "{{trigger.empty}}"), outputs)).toBe(true);
    expect(evaluateCondition(c("LIST_IS_NOT_EMPTY", "{{trigger.list}}"), outputs)).toBe(true);
  });

  test("LIST_CONTAINS / LIST_DOES_NOT_CONTAIN", () => {
    expect(evaluateCondition(c("LIST_CONTAINS", "{{trigger.list}}", "b"), outputs)).toBe(true);
    expect(evaluateCondition(c("LIST_DOES_NOT_CONTAIN", "{{trigger.list}}", "z"), outputs)).toBe(true);
  });
});

describe("conditions: groups (OR of ANDs)", () => {
  test("empty groups => false; empty AND-row is skipped", () => {
    expect(evaluateConditionGroups([], outputs)).toBe(false);
    expect(evaluateConditionGroups([[]], outputs)).toBe(false);
  });

  test("single AND group: all conditions must hold", () => {
    expect(
      evaluateConditionGroups(
        [[c("TEXT_CONTAINS", "{{trigger.text}}", "Hello"), c("NUMBER_IS_GREATER_THAN", "{{trigger.n}}", "5")]],
        outputs,
      ),
    ).toBe(true);
    expect(
      evaluateConditionGroups(
        [[c("TEXT_CONTAINS", "{{trigger.text}}", "Hello"), c("NUMBER_IS_GREATER_THAN", "{{trigger.n}}", "100")]],
        outputs,
      ),
    ).toBe(false);
  });

  test("OR across groups: any matching AND-group wins", () => {
    expect(
      evaluateConditionGroups(
        [
          [c("TEXT_CONTAINS", "{{trigger.text}}", "ZZZZ")],
          [c("NUMBER_IS_EQUAL_TO", "{{trigger.n}}", "7")],
        ],
        outputs,
      ),
    ).toBe(true);
  });
});

describe("conditions: malformed inputs", () => {
  test("template error in firstValue => condition is false (does not throw)", () => {
    expect(evaluateCondition(c("TEXT_CONTAINS", "{{ghost.field}}", "x"), outputs)).toBe(false);
  });

  test("unknown operator => false (silent skip, never throws)", () => {
    expect(evaluateCondition(c("WAT_OPERATOR", "{{trigger.text}}", "x"), outputs)).toBe(false);
  });
});
