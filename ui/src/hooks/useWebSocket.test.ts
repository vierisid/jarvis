import { describe, expect, test } from "bun:test";
import { extractNestedMessage, formatProviderErrorMessage } from "./useWebSocket.ts";

describe("extractNestedMessage", () => {
  test("returns null for non-objects and empty values", () => {
    expect(extractNestedMessage(null)).toBeNull();
    expect(extractNestedMessage("string")).toBeNull();
    expect(extractNestedMessage(42)).toBeNull();
  });

  test("pulls .message from a flat object", () => {
    expect(extractNestedMessage({ message: "boom" })).toBe("boom");
  });

  test("pulls string .error", () => {
    expect(extractNestedMessage({ error: "nope" })).toBe("nope");
  });

  test("recurses into nested .error.message (Anthropic shape)", () => {
    const payload = { error: { type: "invalid_request_error", message: "bad input" } };
    expect(extractNestedMessage(payload)).toBe("bad input");
  });

  test("trims whitespace", () => {
    expect(extractNestedMessage({ message: "  hi  " })).toBe("hi");
  });
});

describe("formatProviderErrorMessage — buckets", () => {
  test("auth: 401 status code", () => {
    const r = formatProviderErrorMessage("OpenAI API error (401): invalid_api_key");
    expect(r.summary).toContain("API key");
  });

  test("auth: invalid x-api-key", () => {
    const r = formatProviderErrorMessage("authentication_error: invalid x-api-key");
    expect(r.summary).toContain("API key");
  });

  test("rate limit: 429 status code — split from network bucket", () => {
    const r = formatProviderErrorMessage("OpenAI API error (429): rate_limit_exceeded");
    expect(r.summary).toContain("rate-limit");
    expect(r.summary).not.toContain("connection");
  });

  test("rate limit: insufficient_quota", () => {
    const r = formatProviderErrorMessage("You exceeded your current quota: insufficient_quota");
    expect(r.summary).toContain("rate-limit");
  });

  test("network: 503", () => {
    const r = formatProviderErrorMessage("Service temporarily unavailable (503)");
    expect(r.summary).toContain("connection");
    expect(r.summary).not.toContain("rate-limit");
  });

  test("network: econnrefused", () => {
    const r = formatProviderErrorMessage("fetch failed: ECONNREFUSED 127.0.0.1:11434");
    expect(r.summary).toContain("connection");
  });

  test("fallback: unknown errors still preserve detail", () => {
    const r = formatProviderErrorMessage("weird: model_not_found");
    expect(r.summary).toContain("Couldn't reach");
    expect(r.detail).toBe("weird: model_not_found");
  });
});

describe("formatProviderErrorMessage — detail extraction", () => {
  test("parses full-JSON payload and extracts nested message as detail", () => {
    const raw = JSON.stringify({ error: { type: "invalid_request_error", message: "context_length_exceeded" } });
    const r = formatProviderErrorMessage(raw);
    expect(r.detail).toBe("context_length_exceeded");
  });

  test("parses embedded-JSON payload", () => {
    const raw = 'Anthropic API error (400): {"error":{"type":"overloaded_error","message":"try again later"}}';
    const r = formatProviderErrorMessage(raw);
    expect(r.detail).toBe("try again later");
  });

  test("returns empty detail when raw is missing", () => {
    const r = formatProviderErrorMessage(undefined);
    expect(r.detail).toBe("");
  });

  test("gracefully handles malformed embedded JSON", () => {
    const raw = "Broken: {not valid json}";
    const r = formatProviderErrorMessage(raw);
    expect(r.detail).toBe(raw);
  });
});

describe("formatProviderErrorMessage — structured code branching (Phase B)", () => {
  test("auth code routes to auth summary regardless of raw text", () => {
    const r = formatProviderErrorMessage("anything at all", "auth");
    expect(r.summary).toContain("Check your API key and model settings");
  });

  test("rate_limit code overrides keyword heuristic (e.g. raw mentions 'timeout')", () => {
    // raw string contains "timeout" which would otherwise trip the network bucket,
    // but the structured code wins.
    const r = formatProviderErrorMessage("request timeout after 30s (but really rate-limited)", "rate_limit");
    expect(r.summary).toContain("rate-limit");
    expect(r.summary).not.toContain("connection");
  });

  test("not_found has its own copy", () => {
    const r = formatProviderErrorMessage("model xyz does not exist", "not_found");
    expect(r.summary).toContain("couldn't find");
  });

  test("bad_request has its own copy", () => {
    const r = formatProviderErrorMessage("missing required field", "bad_request");
    expect(r.summary).toContain("rejected the request");
  });

  test("server has its own copy", () => {
    const r = formatProviderErrorMessage("500 internal server error", "server");
    expect(r.summary).toContain("server error");
  });

  test("unknown code falls back to keyword heuristic", () => {
    const r = formatProviderErrorMessage("OpenAI API error (401): invalid_api_key", "unknown");
    expect(r.summary).toContain("API key");
  });

  test("code present but no raw still returns a summary", () => {
    const r = formatProviderErrorMessage(undefined, "rate_limit");
    expect(r.summary).toContain("rate-limit");
  });
});

describe("formatProviderErrorMessage — status-code brittleness fix", () => {
  test("does NOT match '401' embedded in unrelated digits", () => {
    const r = formatProviderErrorMessage("context window exceeded at token 14018");
    // falls through to the generic fallback, not the auth-specific copy
    expect(r.summary).not.toContain("Check your API key and model settings");
  });

  test("does NOT match '429' embedded in unrelated digits", () => {
    const r = formatProviderErrorMessage("prompt length was 4295 tokens");
    expect(r.summary).not.toContain("rate-limit");
  });

  test("DOES match '\\b401\\b' when it is a real status code", () => {
    const r = formatProviderErrorMessage("HTTP 401 Unauthorized");
    expect(r.summary).toContain("Check your API key and model settings");
  });
});
