import { describe, expect, test } from "bun:test";
import {
  matchesSpeechWakePhrase,
  matchesSpeechWakePrefix,
  shouldSpeechWakeBeRunning,
  classifySpeechWakeError,
  selectActiveWakeEngine,
  isWithinSpeakingTailCooldown,
  planContainsWakeFlip,
} from "./useVoice.ts";

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

describe("matcher normalization (shared by both matchers)", () => {
  test("handles mixed case and surrounding whitespace", () => {
    expect(matchesSpeechWakePrefix("   HEY JARVIS   ")).toBe(true);
    expect(matchesSpeechWakePhrase("   JARVIS, STOP!   ")).toBe(true);
  });

  test("collapses stacked punctuation and multiple spaces", () => {
    expect(matchesSpeechWakePhrase("Jarvis... stop!!")).toBe(true);
    expect(matchesSpeechWakePrefix("hey   jarvis    play   music")).toBe(true);
  });

  test("is not fooled by mid-word 'jarvis' substrings", () => {
    // "starjarvis" is one token; without a word boundary it must not match.
    expect(matchesSpeechWakePrefix("starjarvis")).toBe(false);
    expect(matchesSpeechWakePhrase("starjarvis stop")).toBe(false);
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

  test("runs in every state except recording and error (mid-thought interrupts allowed)", () => {
    expect(shouldSpeechWakeBeRunning(base)).toBe(true);
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "speaking" })).toBe(true);
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "processing" })).toBe(true);
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "wake_detected" })).toBe(true);
  });

  test("does not run during active recording or error", () => {
    expect(shouldSpeechWakeBeRunning({ ...base, voiceState: "recording" })).toBe(false);
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

describe("selectActiveWakeEngine", () => {
  const base = {
    isMicAvailable: true,
    wakeWordEnabled: true,
    wakeEngine: "openwakeword" as const,
    speechRecognitionAvailable: true,
    speechWakeFatal: false,
  };

  test("returns 'none' when mic is unavailable or wake word is disabled", () => {
    expect(selectActiveWakeEngine({ ...base, isMicAvailable: false })).toBe("none");
    expect(selectActiveWakeEngine({ ...base, wakeWordEnabled: false })).toBe("none");
  });

  test("'openwakeword' always resolves to openwakeword (privacy-preserving path)", () => {
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "openwakeword" })).toBe("openwakeword");
    // Even with speech available, config wins:
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "openwakeword", speechRecognitionAvailable: true })).toBe("openwakeword");
    // Fatal speech-wake state is irrelevant when config doesn't want it.
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "openwakeword", speechWakeFatal: true })).toBe("openwakeword");
  });

  test("'webspeech' resolves to webspeech when available, else 'none' (hard mode)", () => {
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "webspeech" })).toBe("webspeech");
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "webspeech", speechRecognitionAvailable: false })).toBe("none");
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "webspeech", speechWakeFatal: true })).toBe("none");
  });

  test("'auto' prefers webspeech but gracefully falls back to openwakeword", () => {
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "auto" })).toBe("webspeech");
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "auto", speechRecognitionAvailable: false })).toBe("openwakeword");
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "auto", speechWakeFatal: true })).toBe("openwakeword");
    // Both unavailable → still falls back to openwakeword rather than silently no-op.
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "auto", speechRecognitionAvailable: false, speechWakeFatal: true })).toBe("openwakeword");
  });

  test("mic/toggle gates override everything else", () => {
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "auto", isMicAvailable: false })).toBe("none");
    expect(selectActiveWakeEngine({ ...base, wakeEngine: "openwakeword", wakeWordEnabled: false })).toBe("none");
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

describe("isWithinSpeakingTailCooldown", () => {
  test("returns true while now is strictly inside the cooldown window", () => {
    expect(isWithinSpeakingTailCooldown(0, 0, 700)).toBe(true);
    expect(isWithinSpeakingTailCooldown(1, 0, 700)).toBe(true);
    expect(isWithinSpeakingTailCooldown(699, 0, 700)).toBe(true);
  });

  test("returns false at the boundary and beyond", () => {
    expect(isWithinSpeakingTailCooldown(700, 0, 700)).toBe(false);
    expect(isWithinSpeakingTailCooldown(701, 0, 700)).toBe(false);
    expect(isWithinSpeakingTailCooldown(10_000, 0, 700)).toBe(false);
  });

  test("respects an absolute exitedAt timestamp, not just zero-anchored math", () => {
    const exitedAt = 1_700_000_000_000;
    expect(isWithinSpeakingTailCooldown(exitedAt + 100, exitedAt, 700)).toBe(true);
    expect(isWithinSpeakingTailCooldown(exitedAt + 700, exitedAt, 700)).toBe(false);
  });

  test("a zero cooldown means we're never inside (always allow)", () => {
    expect(isWithinSpeakingTailCooldown(0, 0, 0)).toBe(false);
    expect(isWithinSpeakingTailCooldown(1000, 999, 0)).toBe(false);
  });

  test("a custom (longer) cooldown extends the window per the option", () => {
    expect(isWithinSpeakingTailCooldown(1500, 0, 2000)).toBe(true);
    expect(isWithinSpeakingTailCooldown(2000, 0, 2000)).toBe(false);
  });
});

describe("planContainsWakeFlip — regression boundary for the mid-turn cooldown stamp bug", () => {
  // Background: when a TTS turn enters `speaking` with containsWake=false
  // and a later sentence introduces "Jarvis", the daemon flips containsWake
  // to true via a ref write. The exit-stamp effect inside useVoice
  // registers a cleanup function based on the predicate at setup time, so
  // a flag flip via ref does NOT re-run the effect — meaning when the turn
  // ends, no cleanup runs, no timestamp is stamped, and trailing TTS audio
  // re-triggers wake. The fix moves the stamp into the imperative handler
  // path. This test pins the contract: a false→true flip MUST stamp the
  // cooldown; a no-op call (already true) MUST NOT.
  test("first false→true flip stamps the cooldown and stops recognizers", () => {
    const plan = planContainsWakeFlip(false);
    expect(plan.shouldFlip).toBe(true);
    expect(plan.shouldStampCooldown).toBe(true);
    expect(plan.shouldStopRecognizers).toBe(true);
  });

  test("second call with flag already true is a complete no-op (don't re-stamp, don't re-stop)", () => {
    const plan = planContainsWakeFlip(true);
    expect(plan.shouldFlip).toBe(false);
    expect(plan.shouldStampCooldown).toBe(false);
    expect(plan.shouldStopRecognizers).toBe(false);
  });

  test("the three side-effects always travel together (atomic plan)", () => {
    // Either we're flipping and stamping and stopping, or we're doing none
    // of them. There's no half-state where we stamp but don't stop, etc.
    for (const current of [false, true]) {
      const plan = planContainsWakeFlip(current);
      const flags = [plan.shouldFlip, plan.shouldStampCooldown, plan.shouldStopRecognizers];
      const allEqual = flags.every((f) => f === flags[0]);
      expect(allEqual).toBe(true);
    }
  });
});
