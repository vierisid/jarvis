import {
  changedValues,
  matchesPatch,
  readSettings,
  type AuthorityDestination,
  type AuthorityPort,
  type NavigationResult,
} from "./model";

export interface AuthorityHost {
  /** An authenticated, scope-bound transport. Never share this binding across accounts. */
  request(input: string, init: RequestInit): Promise<Response>;
  canWrite: boolean;
  /** F-25 provides explicit destinations. No guessed hash, emergency effect or override writer here. */
  destinations: Readonly<Record<AuthorityDestination, boolean>>;
  navigate(
    destination: AuthorityDestination,
    signal: AbortSignal,
  ): Promise<NavigationResult>;
}
export function createAuthorityPort(
  scopeId: string,
  host?: AuthorityHost,
): AuthorityPort {
  const read: AuthorityPort["read"] = async (signal) => {
    if (!host) return { state: "unsupported" };
    if (signal.aborted) return { state: "error" };
    try {
      const response = await host.request("/api/authority/status", {
        method: "GET",
        cache: "no-store",
        signal,
      });
      if (response.status === 401 || response.status === 403)
        return { state: "unavailable" };
      if (response.status === 404 || response.status === 501)
        return { state: "unsupported" };
      if (!response.ok || signal.aborted) return { state: "error" };
      const status = await response.json();
      if (status?.enabled === false) return { state: "unavailable" };
      if (
        status?.enabled !== true ||
        !status.config ||
        typeof status.config !== "object"
      )
        return { state: "error" };
      // The engine config contains a startup copy. Only EmergencyController's
      // top-level status reflects subsequent pause/resume/kill/reset operations.
      const data = readSettings({
        ...status.config,
        emergency_state: status.emergency_state,
      });
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
    destinations: host?.destinations ?? {
      "advanced-authority": false,
      "emergency-controls": false,
    },
    read,
    async save(base, draft, signal, retryFields = []) {
      if (!host) return { state: "unsupported" };
      if (!host.canWrite || signal.aborted) return { state: "unavailable" };
      if (
        !readSettings({ ...base, emergency_state: "normal" }) ||
        !readSettings({ ...draft, emergency_state: "normal" })
      )
        return { state: "unknown" };
      const patch = changedValues(base, draft, retryFields);
      const fresh = await read(signal);
      if (fresh.state !== "ready")
        return { state: fresh.state === "error" ? "unknown" : fresh.state };
      // The existing endpoint has no revision/CAS. Detect changes to fields being edited
      // before posting, and send only those fields so advanced policy is never overwritten.
      const expected = Object.fromEntries(
        Object.keys(patch).map((key) => [key, base[key as keyof typeof base]]),
      );
      if (!matchesPatch(fresh.data, expected))
        return { state: "conflict", data: fresh.data };
      if (!Object.keys(patch).length)
        return { state: "confirmed", data: fresh.data };
      if (signal.aborted || !host.canWrite) return { state: "unavailable" };
      try {
        const response = await host.request("/api/authority/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
          signal,
        });
        if (response.status === 401 || response.status === 403)
          return { state: "unavailable" };
        // A failed response can follow an in-memory apply. Never report it as persisted
        // or replay the write automatically, even if a later GET happens to match.
        if (!response.ok || signal.aborted) return { state: "unknown" };
        const receipt = await response.json();
        if (receipt?.ok !== true || !readSettings(receipt.config))
          return { state: "unknown" };
        const verified = await read(signal);
        if (
          verified.state === "unavailable" ||
          verified.state === "unsupported"
        )
          return { state: verified.state };
        if (verified.state !== "ready" || !matchesPatch(verified.data, patch))
          return { state: "unknown" };
        return { state: "confirmed", data: verified.data };
      } catch {
        return { state: "unknown" };
      }
    },
    async navigate(destination, signal) {
      if (!host || !host.destinations[destination] || signal.aborted)
        return { state: "unavailable" };
      try {
        return await host.navigate(destination, signal);
      } catch {
        return { state: "unavailable" };
      }
    },
  };
}
