import { describe, expect, test } from "bun:test";
import { normalizeFlowsResponse } from "./flow-picker-data";

describe("normalizeFlowsResponse", () => {
  test("happy path: returns id + displayName for each row", () => {
    expect(
      normalizeFlowsResponse([
        { id: "flow_1", displayName: "Morning briefing" },
        { id: "flow_2", displayName: "Weekly report" },
      ]),
    ).toEqual([
      { id: "flow_1", displayName: "Morning briefing" },
      { id: "flow_2", displayName: "Weekly report" },
    ]);
  });

  test("missing displayName falls back to (unnamed) so the row stays readable", () => {
    expect(normalizeFlowsResponse([{ id: "flow_1" }])).toEqual([
      { id: "flow_1", displayName: "(unnamed)" },
    ]);
  });

  test("empty-string displayName falls back to (unnamed)", () => {
    expect(normalizeFlowsResponse([{ id: "flow_1", displayName: "" }])).toEqual([
      { id: "flow_1", displayName: "(unnamed)" },
    ]);
  });

  test("rows without an id are dropped (cannot wire to a picker value)", () => {
    expect(
      normalizeFlowsResponse([{ displayName: "no id" }, { id: "flow_1", displayName: "ok" }]),
    ).toEqual([{ id: "flow_1", displayName: "ok" }]);
  });

  test("non-array bodies resolve to [] -- picker renders the empty-state hint, not an error", () => {
    expect(normalizeFlowsResponse(null)).toEqual([]);
    expect(normalizeFlowsResponse({})).toEqual([]);
    expect(normalizeFlowsResponse("nope")).toEqual([]);
    expect(normalizeFlowsResponse(42)).toEqual([]);
  });

  test("rows that aren't objects are skipped silently", () => {
    expect(
      normalizeFlowsResponse([null, "string", 42, { id: "flow_1", displayName: "ok" }]),
    ).toEqual([{ id: "flow_1", displayName: "ok" }]);
  });

  test("non-string id is skipped", () => {
    expect(
      normalizeFlowsResponse([{ id: 1, displayName: "a" }, { id: "flow_1", displayName: "b" }]),
    ).toEqual([{ id: "flow_1", displayName: "b" }]);
  });

  test("non-string displayName falls back to (unnamed)", () => {
    expect(normalizeFlowsResponse([{ id: "flow_1", displayName: 42 }])).toEqual([
      { id: "flow_1", displayName: "(unnamed)" },
    ]);
  });
});
