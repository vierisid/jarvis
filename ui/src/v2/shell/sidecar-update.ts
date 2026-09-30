/**
 * Sidecar self-update, dashboard side: which connected sidecars are behind the
 * version this brain ships with, what the dashboard can do about each, and the
 * two requests that do it. Pure where it can be (tested in
 * sidecar-update.test.ts); the brain routes are /api/sidecars/:id/update-prompt
 * and /api/sidecars/:id/update (docs/sidecar/SIDECAR_PROTOCOL.md).
 */

export type SidecarUpdatePhase =
  | "available" | "checking" | "downloading" | "verifying" | "installing"
  | "restarting" | "failed" | "unavailable";

export interface SidecarUpdateState {
  phase: SidecarUpdatePhase;
  version?: string;
  error?: string;
  manual_command?: string;
  at?: string;
}

/** The fields of /api/sidecars this module reads. */
export interface SidecarUpdateInfo {
  id: string;
  name: string;
  connected: boolean;
  hostname?: string;
  os?: string;
  version?: string;
  features?: string[];
  latest_version?: string;
  update_available?: boolean;
  update_state?: SidecarUpdateState;
}

/**
 * What the dashboard does for an outdated sidecar:
 *   - prompt: open the sidecar's own update prompt on that machine (the same
 *     window it shows at startup), where the user confirms
 *   - apply:  no prompt there (Linux): confirm here, then install directly
 *   - manual: the sidecar predates self-update or cannot update itself;
 *     explain how instead
 */
export type SidecarUpdateAction = "prompt" | "apply" | "manual";

export function updateActionFor(sc: SidecarUpdateInfo): SidecarUpdateAction {
  const f = sc.features ?? [];
  if (f.includes("update_prompt")) return "prompt";
  if (f.includes("update_apply")) return "apply";
  return "manual";
}

/** Connected sidecars behind the version this brain ships with. */
export function outdatedSidecars(list: readonly SidecarUpdateInfo[]): SidecarUpdateInfo[] {
  return list.filter((sc) => sc.connected && sc.update_available === true);
}

const PHASE_LABEL: Partial<Record<SidecarUpdatePhase, string>> = {
  checking: "checking…",
  downloading: "downloading…",
  verifying: "verifying…",
  installing: "installing…",
  restarting: "restarting…",
};

/** A short in-progress label for an update the sidecar is installing, or null. */
export function updateProgressLabel(state: SidecarUpdateState | undefined): string | null {
  return state ? PHASE_LABEL[state.phase] ?? null : null;
}

/** Whether an install is running on that sidecar right now. */
export function updateInProgress(state: SidecarUpdateState | undefined): boolean {
  return updateProgressLabel(state) !== null;
}

/**
 * How to update a sidecar that cannot do it itself (older sidecars, or an
 * install it cannot swap). The sidecar's own failure message wins when it
 * sent one.
 */
export function manualUpdateHint(sc: SidecarUpdateInfo): string {
  if (sc.update_state?.manual_command) return sc.update_state.manual_command;
  const v = sc.latest_version ? `@${sc.latest_version}` : "";
  const os = (sc.os ?? "").toLowerCase();
  if (os === "windows" || os === "darwin") {
    return `Run the Jarvis installer on ${sc.hostname ?? sc.name}, or if it was installed with bun: bun add -g @usejarvis/sidecar${v}`;
  }
  return `On ${sc.hostname ?? sc.name}: bun add -g @usejarvis/sidecar${v} (or npm install -g), then restart it`;
}

/**
 * The top-bar pill. Hidden when nothing is behind. One outdated sidecar the
 * dashboard can act on is handled in place; several (or one it cannot act
 * on) send the user to Settings > Sidecar, where each row has its own action.
 */
export type PillView =
  | { show: false }
  | { show: true; label: string; title: string; target: "sidecar"; sidecar: SidecarUpdateInfo; action: "prompt" | "apply" }
  | { show: true; label: string; title: string; target: "settings" };

export function pillView(list: readonly SidecarUpdateInfo[]): PillView {
  const outdated = outdatedSidecars(list);
  if (outdated.length === 0) return { show: false };
  if (outdated.length === 1) {
    const sc = outdated[0]!;
    const action = updateActionFor(sc);
    const progress = updateProgressLabel(sc.update_state);
    const label = progress ? `sidecar update · ${progress}` : "sidecar update";
    const title = `${sc.name} runs sidecar ${sc.version ?? "?"}; ${sc.latest_version ?? "a newer version"} is available`;
    if (action !== "manual") return { show: true, label, title, target: "sidecar", sidecar: sc, action };
    return { show: true, label, title, target: "settings" };
  }
  return {
    show: true,
    label: `${outdated.length} sidecar updates`,
    title: `${outdated.map((s) => s.name).join(", ")} can be updated`,
    target: "settings",
  };
}

export type UpdateRequestResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Ask the brain to open the sidecar's update prompt ("prompt") or to install
 * the update directly ("apply"). The sidecar decides what is installable; a
 * refusal comes back as the brain's `{error}` message.
 */
export async function requestSidecarUpdate(
  sc: Pick<SidecarUpdateInfo, "id" | "name" | "hostname">,
  action: "prompt" | "apply",
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateRequestResult> {
  const path = action === "prompt" ? "update-prompt" : "update";
  try {
    const r = await fetchImpl(`/api/sidecars/${encodeURIComponent(sc.id)}/${path}`, { method: "POST" });
    if (!r.ok) {
      let message = `Request failed (HTTP ${r.status}).`;
      try {
        const body = (await r.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error) message = body.error;
      } catch { /* not JSON */ }
      return { ok: false, message };
    }
    const where = sc.hostname ?? sc.name;
    return {
      ok: true,
      message: action === "prompt"
        ? `The update prompt is open on ${where}.`
        : `Updating the sidecar on ${where}; it restarts when done.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Request failed." };
  }
}
