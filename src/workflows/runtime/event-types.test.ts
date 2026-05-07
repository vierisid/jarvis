import { describe, expect, test } from "bun:test";
import {
  AWARENESS_EVENT_TYPE_MAP,
  OBSERVER_EVENT_TYPE_MAP,
  WORKFLOW_EVENT_TYPES,
  getWorkflowEventTypeMeta,
  isWorkflowEventType,
} from "./event-types";

describe("workflow event types", () => {
  test("every observer mapping points at a registered workflow type", () => {
    // The publisher's fallback for unmapped observers prefixes with
    // 'observer.' so every value in the map should be a canonical type.
    for (const [rawType, canonical] of Object.entries(OBSERVER_EVENT_TYPE_MAP)) {
      expect(isWorkflowEventType(canonical)).toBe(true);
      // Sanity: the rawType key is what observers actually emit; we don't
      // hard-fail here if a type vanishes upstream, but the catalog
      // documenting the canonical name must agree.
      const meta = getWorkflowEventTypeMeta(canonical);
      expect(meta).not.toBeNull();
      expect(meta?.type).toBe(canonical);
      void rawType;
    }
  });

  test("every awareness mapping points at a registered workflow type", () => {
    for (const [rawType, canonical] of Object.entries(AWARENESS_EVENT_TYPE_MAP)) {
      expect(isWorkflowEventType(canonical)).toBe(true);
      const meta = getWorkflowEventTypeMeta(canonical);
      expect(meta).not.toBeNull();
      expect(meta?.type).toBe(canonical);
      void rawType;
    }
  });

  test("awareness + observer maps cover disjoint canonical names", () => {
    const obs = new Set(Object.values(OBSERVER_EVENT_TYPE_MAP));
    for (const v of Object.values(AWARENESS_EVENT_TYPE_MAP)) {
      expect(obs.has(v)).toBe(false);
    }
  });

  test("isWorkflowEventType: true for catalog entries, false otherwise", () => {
    expect(isWorkflowEventType("observer.clipboard_changed")).toBe(true);
    expect(isWorkflowEventType("commitment.overdue")).toBe(true);
    expect(isWorkflowEventType("not.a.real.event")).toBe(false);
    expect(isWorkflowEventType("")).toBe(false);
  });

  test("catalog entries are uniquely typed", () => {
    const seen = new Set<string>();
    for (const meta of WORKFLOW_EVENT_TYPES) {
      expect(seen.has(meta.type)).toBe(false);
      seen.add(meta.type);
    }
  });

  test("getWorkflowEventTypeMeta returns null for unknown types", () => {
    expect(getWorkflowEventTypeMeta("ghost")).toBeNull();
  });
});
