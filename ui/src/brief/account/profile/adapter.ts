import {
  matchesProfilePatch,
  readProfile,
  readSnapshot,
  validPatch,
  type ProfilePort,
} from "./model";

export interface ProfileHost {
  /** Authenticated, account-bound transport; replacement/logout must retire its controller. */
  request(path: string, init: RequestInit): Promise<Response>;
  canWrite: boolean;
}
export function createProfilePort(
  scopeId: string,
  host?: ProfileHost,
): ProfilePort {
  const read: ProfilePort["read"] = async (signal) => {
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
        result?.status === "ready" ? readSnapshot(result.data) : null;
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
    async save(revision, patch, signal) {
      if (!host) return { state: "unsupported" };
      if (!host.canWrite || signal.aborted) return { state: "unavailable" };
      if (!/^[a-f0-9]{64}$/.test(revision) || !validPatch(patch))
        return { state: "invalid" };
      try {
        const response = await host.request(
          "/api/brief/profile-settings/profile",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ revision, answers: patch }),
            signal,
          },
        );
        if ([401, 403].includes(response.status))
          return { state: "unavailable" };
        if (response.status === 409) return { state: "conflict" };
        if ([404, 501].includes(response.status))
          return { state: "unsupported" };
        if ([400, 413, 422].includes(response.status))
          return { state: "invalid" };
        if (!response.ok || signal.aborted) return { state: "unknown" };
        const receipt = await response.json();
        const saved =
          receipt?.saved === true ? readProfile(receipt.profile) : null;
        if (!saved || !matchesProfilePatch(saved, patch))
          return { state: "unknown" };
        const fresh = await read(signal);
        if (fresh.state === "unavailable" || fresh.state === "unsupported")
          return { state: fresh.state };
        if (fresh.state !== "ready" || !matchesProfilePatch(fresh.data, patch))
          return { state: "unknown" };
        return { state: "confirmed", data: fresh.data };
      } catch {
        return { state: "unknown" };
      }
    },
  };
}
