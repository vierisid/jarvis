import { describe, expect, test } from "bun:test";
import { matchesSpeechWakePhrase, matchesSpeechWakePrefix, shouldSpeechWakeBeRunning, classifySpeechWakeError } from "./useVoice.ts";

describe("matchesSpeechWakePhrase (strict; used during TTS playback)", () => {
  test("accepts direct wake phrases", () => {
    expect(matchesSpeechWakePhrase("Jarvis")).toBe(true);
    expect(matchesSpeechWakePhrase("hey jarvis")).toBe(true);
    expect(matchesSpeechWakePhrase("Jarvis, stop")).toBe(true);
    expect(matchesSpeechWakePhrase("Hey Jarvis, hold on")).toBe(true);
  });

  test("rejects longer sentences that merely mention jarvis (echo protection)", () => {
    expect(matchesSpeechWakePhrase("Jarvis is already working on that")).toBe(false);
    expect(matchesSpeechWakePhrase("Can you tell Jarvis to send that")).toBe(false);
    expect(matchesSpeechWakePhrase("I said Jarvis in the middle of a sentence")).toBe(false);
    expect(matchesSpeechWakePhrase("Hey Jarvis can you help")).toBe(false);
  });
});

describe("matchesSpeechWakePrefix (loose; used when idle)", () => {
  test("accepts bare wake phrases", () => {
    expect(matchesSpeechWakePrefix("Jarvis")).toBe(true);
    expect(matchesSpeechWakePrefix("hey jarvis")).toBe(true);
  });

  test("accepts wake phrase followed by any command in one utterance", () => {
    expect(matchesSpeechWakePrefix("hey jarvis turn off the lights")).toBe(true);
    expect(matchesSpeechWakePrefix("jarvis what's the weather")).toBe(true);
    expect(matchesSpeechWakePrefix("Hey Jarvis, play some music")).toBe(true);
    expect(matchesSpeechWakePrefix("jarvis can you help me")).toBe(true);
  });

  test("rejects utterances that merely contain jarvis mid-sentence", () => {
    expect(matchesSpeechWakePrefix("Can you tell Jarvis to send that")).toBe(false);
    expect(matchesSpeechWakePrefix("I said Jarvis in the middle of a sentence")).toBe(false);
    expect(matchesSpeechWakePrefix("that was Jarvis talking")).toBe(false);
  });

  test("rejects empty or whitespace-only transcripts", () => {
    expect(matchesSpeechWakePrefix("")).toBe(false);
    expect(matchesSpeechWakePrefix("   ")).toBe(false);
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

  test("stops running once speechWakeFatal is set, even if everything else is fine", () => {
    expect(shouldSpeechWakeBeRunning({ ...base, speechWakeFatal: true })).toBe(false);
    expect(shouldSpeechWakeBeRunning({ ...base, speechWakeFatal: true, voiceState: "speaking" })).toBe(false);
    expect(shouldSpeechWakeBeRunning({ ...base, speechWakeFatal: true, wakeEngine: "auto" })).toBe(false);
  });
});

describe("classifySpeechWakeError", () => {
  test("aborted and no-speech are expected lifecycle events", () => {
    expect(classifySpeechWakeError("aborted")).toBe("expected");
    expect(classifySpeechWakeError("no-speech")).toBe("expected");
  });

  test("audio-capture and network are transient", () => {
    expect(classifySpeechWakeError("audio-capture")).toBe("transient");
    expect(classifySpeechWakeError("network")).toBe("transient");
  });

  test("not-allowed and service-not-allowed are fatal (user/env action required)", () => {
    expect(classifySpeechWakeError("not-allowed")).toBe("fatal");
    expect(classifySpeechWakeError("service-not-allowed")).toBe("fatal");
  });

  test("bad-grammar and language-not-supported are fatal (config problems)", () => {
    expect(classifySpeechWakeError("bad-grammar")).toBe("fatal");
    expect(classifySpeechWakeError("language-not-supported")).toBe("fatal");
  });
});
