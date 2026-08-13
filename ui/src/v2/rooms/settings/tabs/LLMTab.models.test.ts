import { describe, expect, test } from "bun:test";
import { providerModels } from "./LLMTab";

/** The hosted catalog is key-scoped across EVERY modality, so these pickers —
 * which choose chat tiers and the single-model default — must never offer a
 * voice alias. Pure-function test (the tree.test.ts precedent). */
describe("providerModels: hosted catalog filtering", () => {
  const providers = { usejarvis_ai: { kind: "usejarvis_ai" as const, has_api_key: true } };
  const catalogs = {
    usejarvis_ai: ["uj-chat", "uj-high", "uj-low", "uj-medium", "uj-realtime", "uj-stt", "uj-tts"],
  };

  test("keeps the chat tiers and drops every voice alias", () => {
    expect(providerModels(providers, "usejarvis_ai", null, catalogs)).toEqual([
      "uj-chat",
      "uj-high",
      "uj-low",
      "uj-medium",
    ]);
  });

  test("an UNKNOWN future alias is excluded (allowlist fails closed)", () => {
    // The platform can ship a new slot with no jarvis release. A denylist
    // would let it through — and since the first entry is auto-committed on a
    // provider switch, a voice alias sorting first would silently become the
    // user's conversation model.
    const withFuture = { usejarvis_ai: ["uj-audio", "uj-chat", "uj-vision"] };
    expect(providerModels(providers, "usejarvis_ai", null, withFuture)).toEqual(["uj-chat"]);
  });

  test("non-hosted catalogs pass through untouched", () => {
    const omni = {
      kinds: { omni: { kind: "omniroute" as const, has_api_key: true } },
      catalog: { omni: ["a/b", "c/d"] },
    };
    expect(providerModels(omni.kinds, "omni", null, omni.catalog)).toEqual(["a/b", "c/d"]);
  });
});
