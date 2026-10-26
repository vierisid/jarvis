import { createSettingsPort, type SettingsHost } from "./adapter";
import { SettingsController } from "./controller";
import {
  DESTINATIONS,
  type SettingsDestination,
  type SettingsValue,
  type Application,
} from "./model";
/** In-memory F-23 stand-in. It answers like the real routes, so the preview and the tests
 * drive the live adapter (createSettingsPort) instead of a second port. */
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
  const requests: { path: string; method: string; body?: unknown }[] = [],
    writes: { revision: string; voice: string }[] = [],
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
  const host: SettingsHost = {
    canWrite: example !== "read-only",
    destinations: Object.fromEntries(
      DESTINATIONS.map((d) => [
        d,
        () => {
          destinations.push(d);
          navigate?.(d);
        },
      ]),
    ),
    async replayTutorial() {
      replays.push("tutorial");
      return { state: failReplay ? "unknown" : "replayed" };
    },
    async request(path, init) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (init.signal?.aborted) throw Error("Canceled");
      requests.push({
        path,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (example === "unavailable") return new Response(null, { status: 403 });
      if (example === "unsupported") return new Response(null, { status: 501 });
      if (init.method !== "PATCH")
        return failReads
          ? new Response(null, { status: 503 })
          : Response.json(settingsEnvelope(data));
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (!recovered && example === "save-failure")
        return new Response(null, { status: 503 });
      if (!recovered && example === "conflict")
        change(data.voice.choices[2]!.id);
      if (body.revision !== data.voice.revision)
        return new Response(null, { status: 409 });
      if (!data.voice.choices.some((c) => c.id === body.voice))
        return new Response(null, { status: 422 });
      change(body.voice);
      if (!recovered && example === "lost-response")
        throw Error("Lost response");
      const application: Application =
        example === "restart-required"
          ? "restart_required"
          : example === "apply-failure"
            ? "failed"
            : "applied";
      return Response.json({ saved: true, voice: data.voice, application });
    },
  };
  const port = {
    ...createSettingsPort(SETTINGS_SCOPE, host),
    source: "fixture" as const,
  };
  return {
    host,
    port,
    controller: new SettingsController(port),
    current: () => structuredClone(data),
    change,
    requests,
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
