import { describe, expect, test } from "bun:test";
import { uuid, uuidV4FromRandomValues } from "./uuid";

const V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuid", () => {
  test("returns a v4 UUID", () => {
    expect(uuid()).toMatch(V4_SHAPE);
  });

  test("fallback builds well-formed v4 UUIDs (version and variant bits)", () => {
    for (let i = 0; i < 200; i++) {
      expect(uuidV4FromRandomValues()).toMatch(V4_SHAPE);
    }
  });

  test("fallback does not collide across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(uuidV4FromRandomValues());
    expect(seen.size).toBe(10_000);
  });
});
