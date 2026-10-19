import { ProfileController } from "./controller";
import {
  validPatch,
  type ProfilePatch,
  type ProfilePort,
  type ProfileValue,
} from "./model";

/** In-memory stand-in for the F-23 profile owner. It makes no HTTP request; the live
 * port lands with F-23 (#945), whose routes are not on main yet. */
export const PROFILE_SCOPE = "d29-isolated-profile";
export const PROFILE_EXAMPLES = [
  "ready",
  "empty",
  "read-only",
  "save-failure",
  "lost-response",
  "conflict",
  "unavailable",
  "unsupported",
  "error",
] as const;
export type ProfileExample = (typeof PROFILE_EXAMPLES)[number];
const revisionOf = (n: number) => n.toString(16).padStart(64, "0");
export function makeProfileFixture(
  example: ProfileExample = "ready",
  delay = 0,
) {
  let revision = 1,
    failRead = example === "error",
    recovered = false,
    denied: "unavailable" | "unsupported" | null =
      example === "unavailable" || example === "unsupported" ? example : null;
  let profile: ProfileValue = {
    revision: revisionOf(revision),
    answers:
      example === "empty"
        ? {}
        : {
            preferred_name: "Alex",
            company: "Northwind",
            work_role: "Founder and designer",
            current_projects:
              "Building a useful planning tool for the Northwind team.",
            communication_preferences:
              "Clear answers, with time to think before deciding.",
            interests: "Walking and astronomy",
          },
  };
  const writes: { revision: string; answers: ProfilePatch }[] = [];
  const change = (answers: Record<string, string>) => {
    profile = {
      revision: revisionOf(++revision),
      answers: { ...profile.answers, ...answers },
    };
  };
  const settle = async (signal: AbortSignal) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return !signal.aborted;
  };
  const port: ProfilePort = {
    scopeId: PROFILE_SCOPE,
    source: "fixture",
    canWrite: example !== "read-only",
    async read(signal) {
      if (!(await settle(signal))) return { state: "error" };
      if (denied) return { state: denied };
      if (failRead) return { state: "error" };
      return { state: "ready", data: structuredClone(profile) };
    },
    async save(base, patch, signal) {
      if (!port.canWrite || signal.aborted) return { state: "unavailable" };
      if (!/^[a-f0-9]{64}$/.test(base) || !validPatch(patch))
        return { state: "invalid" };
      if (!(await settle(signal))) return { state: "unknown" };
      if (denied) return { state: denied };
      writes.push({ revision: base, answers: { ...patch } });
      if (!recovered && example === "save-failure") return { state: "unknown" };
      if (!recovered && example === "conflict")
        change({ company: "External correction" });
      if (base !== profile.revision) return { state: "conflict" };
      const answers = { ...profile.answers };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || !value.trim()) delete answers[key];
        else answers[key] = value.trim();
      }
      if (JSON.stringify(answers) !== JSON.stringify(profile.answers))
        profile = { answers, revision: revisionOf(++revision) };
      // The write applied but its acknowledgment was lost.
      if (!recovered && example === "lost-response") return { state: "unknown" };
      return { state: "confirmed", data: structuredClone(profile) };
    },
  };
  return {
    port,
    controller: new ProfileController(port),
    writes,
    current: () => structuredClone(profile),
    change,
    failReads: (fail: boolean) => {
      failRead = fail;
    },
    deny: () => {
      denied = "unavailable";
    },
    recoverWrites: () => {
      recovered = true;
    },
  };
}
