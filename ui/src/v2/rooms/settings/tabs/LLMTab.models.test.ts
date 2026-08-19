import { describe, expect, test } from "bun:test";
import { providerModels, seedModelForProvider, unsetSlotPlaceholder, USEJARVIS_TIER_ALIASES } from "./LLMTab";

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

/** Switching a tier's provider auto-commits immediately, so WHICH model gets
 * seeded is a persisted decision, not a display detail. */
describe("seedModelForProvider: per-tier seeding", () => {
  const hostedChatModels = ["uj-chat", "uj-high", "uj-low", "uj-medium"];

  test("each tier seeds its OWN alias, not the alphabetically-first one", () => {
    // The bug this pins: models[0] is always "uj-chat", so switching the
    // High-intelligence picker to the hosted provider silently persisted the
    // thin conversation model as the deep-reasoning tier.
    expect(seedModelForProvider(hostedChatModels, USEJARVIS_TIER_ALIASES.high)).toBe("uj-high");
    expect(seedModelForProvider(hostedChatModels, USEJARVIS_TIER_ALIASES.medium)).toBe("uj-medium");
    expect(seedModelForProvider(hostedChatModels, USEJARVIS_TIER_ALIASES.low)).toBe("uj-low");
    expect(seedModelForProvider(hostedChatModels, USEJARVIS_TIER_ALIASES.conversation)).toBe("uj-chat");
  });

  test("falls back to the first entry when the provider lacks the preferred model", () => {
    // A BYO provider has no uj-* aliases — seeding must not invent one.
    expect(seedModelForProvider(["claude-opus-5", "claude-haiku-4-5"], "uj-high")).toBe("claude-opus-5");
  });

  test("an empty catalog yields the custom sentinel, never a bogus commit", () => {
    expect(seedModelForProvider([], "uj-high")).toBe("__custom__");
  });

  test("every tier alias is one the picker actually offers (no drift)", () => {
    const offered = providerModels(
      { usejarvis_ai: { kind: "usejarvis_ai" as const, has_api_key: true } },
      "usejarvis_ai",
      null,
      { usejarvis_ai: ["uj-chat", "uj-high", "uj-low", "uj-medium", "uj-stt"] },
    );
    for (const alias of Object.values(USEJARVIS_TIER_ALIASES)) expect(offered).toContain(alias);
  });
});

/** An unset tier slot renders routing truth from llm.effective — never a
 * never-persisted models[0] presented as if it were saved (review pr3#7). */
describe("unsetSlotPlaceholder: unset slots show routing truth", () => {
  test("plan-sourced fill names the plan default", () => {
    expect(unsetSlotPlaceholder({ ref: "usejarvis_ai:uj-high", source: "plan" }))
      .toBe("Plan default: uj-high");
  });

  test("default-sourced fill names the fallback default", () => {
    expect(unsetSlotPlaceholder({ ref: "anthropic:claude-x", source: "default" }))
      .toBe("Default: claude-x");
  });

  test("nothing bound (self-hosted, no default) prompts a choice", () => {
    expect(unsetSlotPlaceholder({ ref: null, source: null })).toBe("Select a model…");
    expect(unsetSlotPlaceholder(undefined)).toBe("Select a model…");
  });

  test("a choice-sourced ref is not a placeholder case", () => {
    // The slot has an explicit ref; the select shows it as the value instead.
    expect(unsetSlotPlaceholder({ ref: "usejarvis_ai:uj-pro", source: "choice" }))
      .toBe("Select a model…");
  });
});
