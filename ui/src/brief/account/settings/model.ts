export type Application = "applied" | "restart_required" | "failed" | "unknown";
export interface VoicePreference {
  revision: string;
  state: "editable" | "unavailable";
  reason:
    | "provider_setup_required"
    | "use_existing_voice_settings"
    | "settings_unreadable"
    | null;
  pipeline: "standard_tts";
  provider: string | null;
  voice: string | null;
  enabled: boolean;
  choices: { id: string; label: string }[];
}
export interface SettingsValue {
  voice: VoicePreference;
  checkIn: {
    state: "unavailable";
    reason: "check_in_not_supported";
    choices: [];
  };
  setup: {
    deployment: "hosted" | "self_hosted";
    providerSetup: "managed" | "settings";
    settingsTab: "channels";
  };
  replay: ("profile" | "tutorial")[];
}
export const DESTINATIONS = [
  "authority",
  "connections",
  "voice-settings",
  "advanced-settings",
] as const;
export type SettingsDestination = (typeof DESTINATIONS)[number];
export type SettingsRead =
  | { state: "ready"; data: SettingsValue }
  | { state: "error" | "unavailable" | "unsupported" };
export type VoiceSave =
  | { state: "confirmed"; data: SettingsValue; application: Application }
  | {
      state: "unknown" | "conflict" | "invalid" | "unavailable" | "unsupported";
    };
export interface SettingsPort {
  scopeId: string;
  source: "live" | "fixture";
  canWrite: boolean;
  destinations: Readonly<Record<SettingsDestination, boolean>>;
  canReplayTutorial: boolean;
  read(signal: AbortSignal): Promise<SettingsRead>;
  saveVoice(
    revision: string,
    voice: string,
    signal: AbortSignal,
  ): Promise<VoiceSave>;
  navigate(
    destination: SettingsDestination,
  ): Promise<{ state: "opened" | "unavailable" }>;
  replayTutorial(): Promise<{ state: "replayed" | "unknown" | "unavailable" }>;
}
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
export const revision = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function readVoice(value: unknown): VoicePreference | null {
  if (
    !record(value) ||
    !revision(value.revision) ||
    !["editable", "unavailable"].includes(value.state) ||
    ![
      null,
      "provider_setup_required",
      "use_existing_voice_settings",
      "settings_unreadable",
    ].includes(value.reason) ||
    value.pipeline !== "standard_tts" ||
    typeof value.enabled !== "boolean" ||
    (value.provider !== null && !text(value.provider, 100)) ||
    (value.voice !== null && !text(value.voice, 200)) ||
    !Array.isArray(value.choices) ||
    value.choices.length > 500 ||
    value.choices.some(
      (c: unknown) => !record(c) || !text(c.id, 200) || !text(c.label, 300),
    ) ||
    new Set(value.choices.map((c: { id: string }) => c.id)).size !==
      value.choices.length ||
    (value.state === "editable" &&
      (value.reason !== null || !value.choices.length)) ||
    (value.state === "unavailable" &&
      (value.reason === null || value.choices.length !== 0))
  )
    return null;
  return {
    revision: value.revision,
    state: value.state,
    reason: value.reason,
    pipeline: value.pipeline,
    provider: value.provider,
    voice: value.voice,
    enabled: value.enabled,
    choices: value.choices.map((c: { id: string; label: string }) => ({
      id: c.id,
      label: c.label,
    })),
  };
}
export function readSettings(value: unknown): SettingsValue | null {
  if (
    !record(value) ||
    value.contractVersion !== 1 ||
    !record(value.setup) ||
    !["hosted", "self_hosted"].includes(value.setup.deployment) ||
    value.setup.providerSetup !==
      (value.setup.deployment === "hosted" ? "managed" : "settings") ||
    value.setup.settingsTab !== "channels" ||
    !record(value.checkIn) ||
    value.checkIn.state !== "unavailable" ||
    value.checkIn.reason !== "check_in_not_supported" ||
    !Array.isArray(value.checkIn.choices) ||
    value.checkIn.choices.length !== 0 ||
    !Array.isArray(value.replay) ||
    value.replay.length > 2 ||
    new Set(value.replay).size !== value.replay.length ||
    value.replay.some((s: string) => !["profile", "tutorial"].includes(s))
  )
    return null;
  const voice = readVoice(value.voice);
  return voice
    ? {
        voice,
        setup: {
          deployment: value.setup.deployment,
          providerSetup: value.setup.providerSetup,
          settingsTab: "channels",
        },
        checkIn: {
          state: "unavailable",
          reason: "check_in_not_supported",
          choices: [],
        },
        replay: [...value.replay],
      }
    : null;
}
