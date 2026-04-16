import { describe, expect, test } from "bun:test";
import { matchesSpeechWakePhrase } from "./useVoice.ts";

describe("matchesSpeechWakePhrase", () => {
  test("accepts direct wake phrases", () => {
    expect(matchesSpeechWakePhrase("Jarvis")).toBe(true);
    expect(matchesSpeechWakePhrase("hey jarvis")).toBe(true);
    expect(matchesSpeechWakePhrase("Jarvis, stop")).toBe(true);
    expect(matchesSpeechWakePhrase("Hey Jarvis, hold on")).toBe(true);
  });

  test("rejects longer sentences that merely mention jarvis", () => {
    expect(matchesSpeechWakePhrase("Jarvis is already working on that")).toBe(false);
    expect(matchesSpeechWakePhrase("Can you tell Jarvis to send that")).toBe(false);
    expect(matchesSpeechWakePhrase("I said Jarvis in the middle of a sentence")).toBe(false);
    expect(matchesSpeechWakePhrase("Hey Jarvis can you help")).toBe(false);
  });
});
