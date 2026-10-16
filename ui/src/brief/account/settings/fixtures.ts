import { SettingsController } from "./controller";
import {
  DESTINATIONS,
  revision as isRevision,
  type Application,
  type SettingsDestination,
  type SettingsPort,
  type SettingsValue,
} from "./model";

/** In-memory stand-in for the F-23 settings owner. It makes no HTTP request; the live
 * port lands with F-23 (#945), whose routes are not on main yet. */
export const SETTINGS_SCOPE = "d30-isolated-settings";
export const SETTINGS_EXAMPLES = [
  "local",
  "hosted",
  "read-only",
  "voice-unavailable",
  "save-failure",
  "lost-response",
  "conflict",
  "restart-required",
  "apply-failure",
  "unavailable",
  "unsupported",
  "error",
] as const;
export type SettingsExample = (typeof SETTINGS_EXAMPLES)[number];
export function settingsEnvelope(data: SettingsValue) {
  return { status: "ready", data: { contractVersion: 1, ...data } };
}
export function makeSettingsFixture(
  example: SettingsExample = "local",
  delay = 0,
  navigate?: (destination: SettingsDestination) => void,
) {
  let revision = 1,
    failReads = example === "error",
    recovered = false,
    failReplay = false;
  const hosted = example === "hosted";
  let data: SettingsValue = {
    voice: {
      revision: revision.toString(16).padStart(64, "0"),
      state: example === "voice-unavailable" ? "unavailable" : "editable",
      reason:
        example === "voice-unavailable" ? "use_existing_voice_settings" : null,
      pipeline: "standard_tts",
      provider: hosted ? "usejarvis" : "edge",
      voice: hosted ? "alloy" : "en-US-AriaNeural",
      enabled: true,
      choices:
        example === "voice-unavailable"
          ? []
          : hosted
            ? [
                { id: "alloy", label: "alloy" },
                { id: "echo", label: "echo" },
              ]
            : [
                { id: "en-US-AriaNeural", label: "Aria (US Female)" },
                { id: "en-US-GuyNeural", label: "Guy (US Male)" },
                { id: "en-GB-SoniaNeural", label: "Sonia (UK Female)" },
              ],
    },
    checkIn: {
      state: "unavailable",
      reason: "check_in_not_supported",
      choices: [],
    },
    setup: {
      deployment: hosted ? "hosted" : "self_hosted",
      providerSetup: hosted ? "managed" : "settings",
      settingsTab: "channels",
    },
    replay: ["profile", "tutorial"],
  };
  const writes: { revision: string; voice: string }[] = [],
    destinations: SettingsDestination[] = [],
    replays: string[] = [];
  const change = (voice: string) => {
    data = {
      ...data,
      voice: {
        ...data.voice,
        voice,
        revision: (++revision).toString(16).padStart(64, "0"),
      },
    };
  };
  const settle = async (signal: AbortSignal) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return !signal.aborted;
  };
  const denied =
    example === "unavailable" || example === "unsupported" ? example : null;
  const canWrite = example !== "read-only";
  const port: SettingsPort = {
    scopeId: SETTINGS_SCOPE,
    source: "fixture",
    canWrite,
    destinations: Object.fromEntries(
      DESTINATIONS.map((d) => [d, true]),
    ) as Record<SettingsDestination, boolean>,
    canReplayTutorial: canWrite,
    async read(signal) {
      if (!(await settle(signal))) return { state: "error" };
      if (denied) return { state: denied };
      if (failReads) return { state: "error" };
      return { state: "ready", data: structuredClone(data) };
    },
    async saveVoice(base, voice, signal) {
      if (!port.canWrite || signal.aborted) return { state: "unavailable" };
      if (!isRevision(base) || !voice || voice.length > 200)
        return { state: "invalid" };
      if (!(await settle(signal))) return { state: "unknown" };
      if (denied) return { state: denied };
      writes.push({ revision: base, voice });
      if (!recovered && example === "save-failure") return { state: "unknown" };
      if (!recovered && example === "conflict")
        change(data.voice.choices.at(-1)!.id);
      if (base !== data.voice.revision) return { state: "conflict" };
      if (!data.voice.choices.some((c) => c.id === voice))
        return { state: "invalid" };
      change(voice);
      // The write applied but its acknowledgment was lost.
      if (!recovered && example === "lost-response") return { state: "unknown" };
      const application: Application =
        example === "restart-required"
          ? "restart_required"
          : example === "apply-failure"
            ? "failed"
            : "applied";
      return { state: "confirmed", data: structuredClone(data), application };
    },
    async navigate(destination) {
      destinations.push(destination);
      navigate?.(destination);
      return { state: "opened" };
    },
    async replayTutorial() {
      if (!port.canWrite) return { state: "unavailable" };
      replays.push("tutorial");
      return { state: failReplay ? "unknown" : "replayed" };
    },
  };
  return {
    port,
    controller: new SettingsController(port),
    current: () => structuredClone(data),
    change,
    writes,
    destinations,
    replays,
    failReads: (value: boolean) => {
      failReads = value;
    },
    recoverWrites: () => {
      recovered = true;
    },
    failReplay: (value: boolean) => {
      failReplay = value;
    },
  };
}
