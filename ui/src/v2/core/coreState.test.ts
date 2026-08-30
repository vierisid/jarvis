import { describe, expect, test } from "bun:test";
import { deriveJarvisCoreState } from "./coreState";

const base = { connection: "live" as const, voiceState: "idle" as const };

describe("deriveJarvisCoreState", () => {
  test("uses safety-first priority", () => {
    expect(deriveJarvisCoreState({ ...base, hasError: true, hasPendingApproval: true })).toBe("ERROR");
    expect(deriveJarvisCoreState({ ...base, hasPendingApproval: true, hasActiveWork: true })).toBe("WAITING_APPROVAL");
  });

  test("maps live voice and work signals", () => {
    expect(deriveJarvisCoreState({ ...base, voiceState: "listening" })).toBe("LISTENING");
    expect(deriveJarvisCoreState({ ...base, voiceState: "thinking" })).toBe("THINKING");
    expect(deriveJarvisCoreState({ ...base, voiceState: "speaking" })).toBe("SPEAKING");
    expect(deriveJarvisCoreState({ ...base, hasActiveWork: true })).toBe("WORKING");
    expect(deriveJarvisCoreState(base)).toBe("IDLE");
  });

  test("represents lifecycle states without inventing activity", () => {
    expect(deriveJarvisCoreState({ ...base, isBooting: true })).toBe("AWAKENING");
    expect(deriveJarvisCoreState({ ...base, voiceState: "muted" })).toBe("SLEEPING");
  });
});
