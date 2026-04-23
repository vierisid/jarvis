import { describe, expect, test } from "bun:test";
import { matchesSpeechWakePhrase, shouldSpeechWakeBeRunning } from "./useVoice.ts";

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

describe("shouldSpeechWakeBeRunning", () => {
  const base = {
    isMicAvailable: true,
    wakeWordEnabled: true,
    voiceState: "idle" as const,
    wakeEngine: "webspeech" as const,
    speechRecognitionAvailable: true,
  };

  test("runs in idle and speaking (for barge-in)", () => {
    expect(shouldSpeechWakeBeRunning(base)).toBe(true);
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "speaking" })).toBe(true);
  });

  test("does not run during recording, processing, wake_detected, or error", () => {
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "recording" })).toBe(false);
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "processing" })).toBe(false);
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "wake_detected" })).toBe(false);
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "error" })).toBe(false);
  });

  test("does not run when mic is unavailable or wake word is disabled", () => {
    expect(shouldSpeechWakeBeRunning({ ...base, isMicAvailable: false })).toBe(false);
    expect(shouldSpeechWakeBeRunning({ ...base, wakeWordEnabled: false })).toBe(false);
  });

  test("never runs when the configured engine is openwakeword", () => {
    expect(shouldSpeechWakeBeRunning({ ...base, wakeEngine: "openwakeword" })).toBe(false);
    expect(shouldSpeechWakeBeRunning({ ...base, wakeEngine: "openwakeword", voiceState: "speaking" })).toBe(false);
  });

  test("auto only runs speech wake when SpeechRecognition is present", () => {
    expect(shouldSpeechWakeBeRunning({ ...base, wakeEngine: "auto" })).toBe(true);
    expect(shouldSpeechWakeBeRunning({ ...base, wakeEngine: "auto", speechRecognitionAvailable: false })).toBe(false);
  });

  test("webspeech requires SpeechRecognition to be available", () => {
    expect(shouldSpeechWakeBeRunning({ ...base, speechRecognitionAvailable: false })).toBe(false);
  });
});
