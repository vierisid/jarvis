import { describe, expect, test } from "bun:test";
import { extractNestedMessage, finalizeStreamMessage, formatProviderErrorMessage, mergeRestoredHistory, nextStreamBuffer } from "./useWebSocket.ts";

describe("finalizeStreamMessage", () => {
  test("recovers text from the done frame when every stream chunk was missed", () => {
    const messages = finalizeStreamMessage([], {
      id: "assistant:req-1",
      fullText: "This was spoken aloud.",
      timestamp: 123,
      toolCalls: [],
      subAgentEvents: [],
    });
    expect(messages).toEqual([{
      id: "assistant:req-1",
      role: "assistant",
      content: "This was spoken aloud.",
      timestamp: 123,
      isStreaming: false,
    }]);
  });

  test("repairs partial streamed text with authoritative completed text", () => {
    const messages = finalizeStreamMessage([{
      id: "assistant:req-1", role: "assistant", content: "This was", timestamp: 100, isStreaming: true,
    }], {
      id: "assistant:req-1",
      fullText: "This was spoken aloud.",
      timestamp: 123,
      toolCalls: [],
      subAgentEvents: [],
    });
    expect(messages[0]?.content).toBe("This was spoken aloud.");
    expect(messages[0]?.isStreaming).toBe(false);
  });

  test("does not duplicate a response when completion is handled twice", () => {
    const existing = [{
      id: "assistant:req-1", role: "assistant" as const, content: "OK", timestamp: 100, isStreaming: false,
    }];
    expect(finalizeStreamMessage(existing, {
      id: "assistant:req-1", fullText: "OK", timestamp: 123, toolCalls: [], subAgentEvents: [],
    })).toHaveLength(1);
  });
});

describe("mergeRestoredHistory", () => {
  const restored = [
    { id: "vault-1", role: "user" as const, content: "hello", timestamp: 1 },
    { id: "vault-2", role: "assistant" as const, content: "hi there", timestamp: 2 },
  ];

  test("returns history untouched when nothing raced in", () => {
    expect(mergeRestoredHistory(restored, [])).toEqual(restored);
  });

  test("keeps a message that landed while the history fetch was in flight", () => {
    const live = [{
      id: "assistant:req-1", role: "assistant" as const, content: "recovered", timestamp: 3,
    }];
    expect(mergeRestoredHistory(restored, live)).toEqual([...restored, ...live]);
  });

  test("drops the live copy of a message the vault already has", () => {
    const live = [{
      id: "assistant:req-1", role: "assistant" as const, content: "hi there ", timestamp: 3,
    }];
    expect(mergeRestoredHistory(restored, live)).toEqual(restored);
  });

  test("does not collapse a genuinely repeated answer", () => {
    const twice = [
      ...restored,
      { id: "vault-3", role: "assistant" as const, content: "hi there", timestamp: 3 },
    ];
    const live = [
      { id: "a", role: "assistant" as const, content: "hi there", timestamp: 4 },
      { id: "b", role: "assistant" as const, content: "hi there", timestamp: 5 },
      { id: "c", role: "assistant" as const, content: "hi there", timestamp: 6 },
    ];
    // Two vault copies absorb two live copies; the third survives.
    expect(mergeRestoredHistory(twice, live)).toHaveLength(4);
  });

  test("does not match across roles", () => {
    const live = [{ id: "x", role: "user" as const, content: "hi there", timestamp: 3 }];
    expect(mergeRestoredHistory(restored, live)).toHaveLength(3);
  });
});

describe("nextStreamBuffer", () => {
  test("adopts the relay's running total so a late client is not left truncated", () => {
    // First chunk this client sees; everything before it was broadcast while
    // the socket was still connecting.
    expect(nextStreamBuffer("", { text: " world", accumulated: "hello world" }))
      .toBe("hello world");
  });

  test("stays in step with local accumulation on a healthy stream", () => {
    expect(nextStreamBuffer("hello", { text: " world", accumulated: "hello world" }))
      .toBe("hello world");
  });

  test("falls back to appending when the chunk carries no accumulated total", () => {
    expect(nextStreamBuffer("hello", { text: " world" })).toBe("hello world");
  });

  test("ignores a non-string accumulated value", () => {
    expect(nextStreamBuffer("hello", { text: " world", accumulated: 42 }))
      .toBe("hello world");
  });

  test("keeps the buffer intact when a chunk has no text at all", () => {
    expect(nextStreamBuffer("hello", {})).toBe("hello");
  });
});

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

  test("forbidden: 403 gets model-access copy, not the API-key copy", () => {
    const r = formatProviderErrorMessage("OpenAI API error (403): model access denied");
    expect(r.summary).toContain("won't allow this model");
    expect(r.summary).not.toContain("Check your API key and model settings");
  });

  test("auth wins when a 401 body also carries permission wording", () => {
    const r = formatProviderErrorMessage("401 Unauthorized: you do not have access");
    expect(r.summary).toContain("Check your API key and model settings");
  });

  test("forbidden: model-access wording with no status code", () => {
    const r = formatProviderErrorMessage("Project `proj_a` does not have access to model `o3`");
    expect(r.summary).toContain("won't allow this model");
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

  test("forbidden code has its own copy, distinct from auth", () => {
    const forbidden = formatProviderErrorMessage("permission denied", "forbidden");
    const auth = formatProviderErrorMessage("invalid api key", "auth");
    expect(forbidden.summary).toContain("won't allow this model");
    expect(forbidden.summary).not.toBe(auth.summary);
  });

  test("structured code still outranks digits in the raw message", () => {
    // A quota failure whose payload happens to carry a 403/401-looking token
    // must stay in the rate-limit bucket.
    const r = formatProviderErrorMessage(
      '{"error":{"message":"quota exceeded"},"request_id":"req-403-xyz"}',
      "rate_limit",
    );
    expect(r.summary).toContain("rate-limit");
    expect(r.summary).not.toContain("won't allow this model");
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

  test("does NOT match '403' embedded in unrelated digits", () => {
    const r = formatProviderErrorMessage("prompt length was 4030 tokens");
    expect(r.summary).not.toContain("won't allow this model");
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
