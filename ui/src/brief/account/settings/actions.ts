import { resetOnboarding } from "../../../v2/onboarding/resetClient";
/** Optional host action. Tutorial replay never requests provider/profile setup. */
export async function replayExistingTutorial(): Promise<{
  state: "replayed" | "unknown";
}> {
  try {
    const result = await resetOnboarding("tutorial");
    return {
      state: result.ok && result.scope === "tutorial" ? "replayed" : "unknown",
    };
  } catch {
    return { state: "unknown" };
  }
}
