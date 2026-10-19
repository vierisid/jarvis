import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { errorFrameContent, routeErrorFrame, extractNestedMessage, finalizeStreamMessage, formatProviderErrorMessage, mergeRestoredHistory, nextStreamBuffer, retiredVoiceConfirmationId, roomActionRequestFrom, stillPendingVoiceConfirmations } from "./useWebSocket.ts";
import type { UserFailure } from "../v2/ui/FailureNotice";

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

// Q-19: the summary comes from the server's typed code only. Wording that
// looks like a status code or a keyword never picks one.
describe("formatProviderErrorMessage: wording never classifies", () => {
  test.each([
    "OpenAI API error (401): invalid_api_key",
    "OpenAI API error (403): model access denied",
    "authentication_error: invalid x-api-key",
    "OpenAI API error (429): rate_limit_exceeded",
    "You exceeded your current quota: insufficient_quota",
    "Service temporarily unavailable (503)",
    "fetch failed: ECONNREFUSED 127.0.0.1:11434",
  ])("%s: the generic summary, with the text kept as detail", (raw) => {
    const r = formatProviderErrorMessage(raw);
    expect(r.summary).toBe("Your request failed. The details say what went wrong.");
    expect(r.detail).toBe(raw);
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

  test("an unknown code gets the generic summary, whatever the text says", () => {
    const r = formatProviderErrorMessage("OpenAI API error (401): invalid_api_key", "unknown");
    expect(r.summary).toBe("Your request failed. The details say what went wrong.");
  });

  test("unsupported_tools and setup_required have their own copy", () => {
    expect(formatProviderErrorMessage("x", "unsupported_tools").summary).toContain("can't use tools");
    expect(formatProviderErrorMessage("x", "setup_required").summary).toContain("first-run setup");
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

  test("a real-looking status code in the text still decides nothing without a code", () => {
    const r = formatProviderErrorMessage("HTTP 401 Unauthorized");
    expect(r.summary).not.toContain("Check your API key and model settings");
    expect(formatProviderErrorMessage("HTTP 401 Unauthorized", "auth").summary).toContain("Check your API key and model settings");
  });
});

// Q-19: a turn's error reaches every tab; only the tab that asked reacts.
describe("routeErrorFrame", () => {
  const tab = (sent: string[], followingTurn: string | null = null) => ({ sentAsText: (id: string) => sent.includes(id), followingTurn });

  test("a text turn this tab sent: voice reacts and the turn ends", () => {
    expect(routeErrorFrame({ id: "r1", requestId: "r1" }, tab(["r1"], "r1"))).toEqual({ askedHere: true, voiceRequestId: undefined, endsTurn: true });
  });

  test("another tab's turn this tab is not following: shown, but this tab's own turn goes on", () => {
    expect(routeErrorFrame({ id: "r2", requestId: "r2" }, tab(["r1"], "r1"))).toEqual({ askedHere: false, voiceRequestId: "r2", endsTurn: false });
  });

  test("a mirrored turn this tab was following ends here too, and voice decides whether it was its own", () => {
    expect(routeErrorFrame({ id: "v1", requestId: "v1" }, tab([], "v1"))).toEqual({ askedHere: false, voiceRequestId: "v1", endsTurn: true });
  });

  test("an error with no request id was sent to this socket alone", () => {
    expect(routeErrorFrame({}, tab([]))).toEqual({ askedHere: false, voiceRequestId: undefined, endsTurn: true });
  });
});

describe("errorFrameContent", () => {
  const failure: UserFailure = { category: "provider_limit", effect: "none", headline: "Your request failed: the AI provider is rate limiting requests.",
    outcome: "Nothing was done.", next: [{ step: "open_details", label: "Open the details." }], links: {}, code: "rate_limit", detail: "429", key: "k" };

  test("the daemon's failure is used as is, on any tab", () => {
    expect(errorFrameContent({ message: "429", code: "auth", failure }, false)).toEqual({ content: failure.headline, failure });
  });

  test("without a failure, a chat error this tab sent gets the typed summary", () => {
    expect(errorFrameContent({ message: "slow down", code: "rate_limit" }, true).content).toContain("rate-limit");
  });

  test("a non-chat error keeps its own wording", () => {
    expect(errorFrameContent({ message: "STT not configured." }, false)).toEqual({ content: "STT not configured." });
  });
});

describe("a voice confirmation card comes down when it can no longer be answered (#1011)", () => {
  test("resolved, expired, or its dashboard gone", () => {
    expect(retiredVoiceConfirmationId({ source: "voice_confirmation_resolved", id: "a", decision: "confirm" })).toBe("a");
    expect(retiredVoiceConfirmationId({ source: "voice_confirmation_expired", id: "b", reason: "expired" })).toBe("b");
    expect(retiredVoiceConfirmationId({ source: "voice_confirmation_expired", id: "c", reason: "disconnected" })).toBe("c");
    for (const bad of [null, {}, { source: "voice_confirmation_expired" }, { source: "voice_confirmation_expired", id: 7 }, { source: "repeat_back_request", id: "a" }]) {
      expect(retiredVoiceConfirmationId(bad)).toBeNull();
    }
  });

  test("the hook takes the card down for both", () => {
    const src = readFileSync(new URL("./useWebSocket.ts", import.meta.url), "utf8");
    const at = src.indexOf('payload.source === "voice_confirmation_resolved" || payload.source === "voice_confirmation_expired"');
    expect(at).toBeGreaterThanOrEqual(0);
    const branch = src.slice(at);
    const body = branch.slice(0, branch.indexOf("} else if"));
    expect(body).toContain("const id = retiredVoiceConfirmationId(payload);");
    expect(body).toContain("setClarifiers((prev) => prev.filter((c) => c.id !== id));");
    expect(body).toContain("setRepeatBacks((prev) => prev.filter((r) => r.id !== id));");
  });

  test("on reconnect, a card that ended while the socket was down comes down, and a newer one stays", () => {
    const keep = stillPendingVoiceConfirmations({ ids: ["live"], at: 1_000 })!;
    expect(keep({ id: "live", timestamp: 500 })).toBe(true);
    // Swept or expired while this dashboard could not hear it.
    expect(keep({ id: "dead", timestamp: 500 })).toBe(false);
    // Arrived after the list was read: not judged by it.
    expect(keep({ id: "new", timestamp: 1_001 })).toBe(true);
    // Stamped in the same millisecond the list was read: it was not in the
    // list, so it is still waiting and must stay.
    expect(keep({ id: "same-ms", timestamp: 1_000 })).toBe(true);
    // A reply it cannot read takes nothing down.
    for (const bad of [null, {}, { ids: ["x"] }, { ids: "x", at: 1 }, { at: 1 }]) {
      expect(stillPendingVoiceConfirmations(bad)).toBeNull();
    }
  });

  test("the hook rechecks its cards whenever a socket opens", () => {
    const src = readFileSync(new URL("./useWebSocket.ts", import.meta.url), "utf8");
    const at = src.indexOf("ws.onopen = async () => {");
    expect(at).toBeGreaterThanOrEqual(0);
    const onopen = src.slice(at, src.indexOf("ws.onclose = () => {"));
    expect(onopen).toContain('await fetch("/api/voice/confirmations")');
    expect(onopen).toContain("setClarifiers((prev) => prev.filter(keep));");
    expect(onopen).toContain("setRepeatBacks((prev) => prev.filter(keep));");
    // Not behind the first-connect-only history guard, which closes before
    // the approvals are rehydrated.
    expect(onopen.slice(onopen.indexOf("/api/authority/approvals"), onopen.indexOf("/api/voice/confirmations"))).not.toContain("historyHydratedRef");
  });
});

describe("roomActionRequestFrom (#965)", () => {
  const base = { source: "room_action", room: "settings", action: "switch_tab", args: { tab: "voice" } };

  test("keeps the resultId only when the daemon asked this dashboard", () => {
    expect(roomActionRequestFrom({ ...base, resultId: "r1", resultFrom: "dashboard" }, 5))
      .toEqual({ room: "settings", action: "switch_tab", args: { tab: "voice" }, ts: 5, resultId: "r1" });
    // The pebble's requests are for native panels to answer, not the dashboard.
    for (const extra of [{ resultId: "r1" }, { resultId: "r1", resultFrom: "panel" }, { resultId: "", resultFrom: "dashboard" }, { resultId: 7, resultFrom: "dashboard" }, {}]) {
      expect(roomActionRequestFrom({ ...base, ...extra }, 5)).toEqual({ room: "settings", action: "switch_tab", args: { tab: "voice" }, ts: 5 });
    }
  });

  test("runs an action that changes more than the screen only when it was addressed here (#974)", () => {
    const task = { source: "room_action", room: "tasks", action: "create_task", args: { title: "Pay rent" } };
    expect(roomActionRequestFrom({ ...task, resultId: "r1", resultFrom: "dashboard" }, 5))
      .toEqual({ room: "tasks", action: "create_task", args: { title: "Pay rent" }, ts: 5, resultId: "r1" });
    for (const extra of [{}, { resultId: "r1" }, { resultId: "r1", resultFrom: "panel" }, { resultId: "", resultFrom: "dashboard" }]) {
      expect(roomActionRequestFrom({ ...task, ...extra }, 5)).toBeNull();
    }
  });

  test("an action this dashboard answers expires when the daemon stops waiting, on this clock (#1010)", () => {
    const task = { source: "room_action", room: "tasks", action: "create_task", args: { title: "Pay rent" }, resultId: "r1", resultFrom: "dashboard" };
    // ts is the daemon's clock; the deadline is the arrival time here plus its wait.
    expect(roomActionRequestFrom({ ...task, expiresInMs: 3500 }, 5, 1_000)?.expiresAt).toBe(4_500);
    expect(roomActionRequestFrom({ ...task, expiresInMs: 0 }, 5, 1_000)?.expiresAt).toBe(1_000);
    for (const bad of [undefined, -1, "3500", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(roomActionRequestFrom({ ...task, expiresInMs: bad }, 5, 1_000)?.expiresAt).toBeUndefined();
    }
    // Not addressed here: nobody here is waited on, so nothing expires.
    expect(roomActionRequestFrom({ ...base, resultId: "r1", expiresInMs: 3500 }, 5, 1_000)?.expiresAt).toBeUndefined();
  });

  test("drops malformed actions", () => {
    expect(roomActionRequestFrom(null, 1)).toBeNull();
    expect(roomActionRequestFrom({ room: "settings" }, 1)).toBeNull();
    expect(roomActionRequestFrom({ room: 1, action: "x" }, 1)).toBeNull();
    expect(roomActionRequestFrom({ room: "tools", action: "search", args: "nope" }, 1)?.args).toEqual({});
  });
});
