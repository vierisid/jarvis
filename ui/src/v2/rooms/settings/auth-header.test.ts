import { describe, expect, it } from "bun:test";
import { sendsAuthHeader } from "./useSettingsData";

/**
 * The settings form may only send an `auth_header` override when the user had
 * a dropdown to choose one with. Sending it unconditionally silently replaces
 * the header a provider authenticates with — the concrete failure being
 * `Authorization: Bearer` on official Anthropic, which needs `x-api-key` and
 * 401s otherwise, so `Test connection` reports a bad key on a good one.
 */
describe("sendsAuthHeader", () => {
  it("is false for official Anthropic (no custom endpoint)", () => {
    expect(sendsAuthHeader("anthropic", false)).toBe(false);
  });

  it("is true for Anthropic once a custom endpoint is on", () => {
    expect(sendsAuthHeader("anthropic", true)).toBe(true);
  });

  it("is true for the keyed gateway kinds this feature targets", () => {
    expect(sendsAuthHeader("openai_compatible", true)).toBe(true);
    expect(sendsAuthHeader("litellm", true)).toBe(true);
    expect(sendsAuthHeader("omniroute", true)).toBe(true);
  });

  it("is false for cloud providers that own their header", () => {
    for (const kind of ["openai", "groq", "gemini", "openrouter", "nvidia"] as const) {
      expect(sendsAuthHeader(kind, false)).toBe(false);
    }
  });

  it("is false for a keyless provider even on a custom endpoint", () => {
    // Ollama takes no key, so there is no credential to place in a header.
    expect(sendsAuthHeader("ollama", true)).toBe(false);
  });
});
