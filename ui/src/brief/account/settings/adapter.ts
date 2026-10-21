import {
  DESTINATIONS,
  readSettings,
  readVoice,
  revision,
  type SettingsPort,
  type SettingsDestination,
} from "./model";
export interface SettingsHost {
  /** Authenticated account-bound transport; retire its controller on replacement/logout. */
  request(path: string, init: RequestInit): Promise<Response>;
  canWrite: boolean;
  /** Supplied by the host's navigation compatibility owner (F-25). */
  destinations: Partial<
    Record<SettingsDestination, () => void | Promise<void>>
  >;
  /** Delegate only to the existing tutorial reset owner, never setup/all/profile. */
  replayTutorial?: () => Promise<{
    state: "replayed" | "unknown" | "unavailable";
  }>;
}
export function createSettingsPort(
  scopeId: string,
  host?: SettingsHost,
): SettingsPort {
  const read: SettingsPort["read"] = async (signal) => {
    if (!host) return { state: "unsupported" };
    if (signal.aborted) return { state: "error" };
    try {
      const response = await host.request("/api/brief/profile-settings", {
        cache: "no-store",
        signal,
      });
      if ([401, 403].includes(response.status)) return { state: "unavailable" };
      if ([404, 501].includes(response.status)) return { state: "unsupported" };
      if (!response.ok || signal.aborted) return { state: "error" };
      const result = await response.json();
      const data =
        result?.status === "ready" ? readSettings(result.data) : null;
      return data && !signal.aborted
        ? { state: "ready", data }
        : { state: "error" };
    } catch {
      return { state: "error" };
    }
  };
  return {
    scopeId,
    source: "live",
    canWrite: host?.canWrite === true,
    read,
    destinations: Object.fromEntries(
      DESTINATIONS.map((d) => [d, typeof host?.destinations[d] === "function"]),
    ) as Record<SettingsDestination, boolean>,
    canReplayTutorial: !!host?.replayTutorial && host.canWrite === true,
    async navigate(destination) {
      const action = host?.destinations[destination];
      if (!action) return { state: "unavailable" };
      try {
        await action();
        return { state: "opened" };
      } catch {
        return { state: "unavailable" };
      }
    },
    async replayTutorial() {
      if (!host?.canWrite || !host.replayTutorial)
        return { state: "unavailable" };
      try {
        return await host.replayTutorial();
      } catch {
        return { state: "unknown" };
      }
    },
    async saveVoice(base, voice, signal) {
      if (!host) return { state: "unsupported" };
      if (!host.canWrite || signal.aborted) return { state: "unavailable" };
      if (!revision(base) || !voice || voice.length > 200)
        return { state: "invalid" };
      try {
        const response = await host.request(
          "/api/brief/profile-settings/voice",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ revision: base, voice }),
            signal,
          },
        );
        if ([401, 403].includes(response.status))
          return { state: "unavailable" };
        if ([404, 501].includes(response.status))
          return { state: "unsupported" };
        if (response.status === 409) return { state: "conflict" };
        if ([400, 413, 422].includes(response.status))
          return { state: "invalid" };
        if (!response.ok || signal.aborted) return { state: "unknown" };
        const result = await response.json(),
          receipt = result?.saved === true ? readVoice(result.voice) : null;
        if (
          !receipt ||
          receipt.voice !== voice ||
          !["applied", "restart_required", "failed"].includes(
            result.application,
          )
        )
          return { state: "unknown" };
        const fresh = await read(signal);
        if (fresh.state === "unavailable" || fresh.state === "unsupported")
          return { state: fresh.state };
        if (
          fresh.state !== "ready" ||
          fresh.data.voice.voice !== voice ||
          fresh.data.voice.provider !== receipt.provider
        )
          return { state: "unknown" };
        return {
          state: "confirmed",
          data: fresh.data,
          application: result.application,
        };
      } catch {
        return { state: "unknown" };
      }
    },
  };
}
