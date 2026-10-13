import type { BriefConnection } from "../../../../src/brief/contracts";
import type { SidecarInfo } from "../../v2/rooms/settings/useSettingsData";
import { updateInProgress, updatePending } from "../../v2/shell/sidecar-update";
import { NavigationCompatibility, destinationPort } from "./controller";
import { DESTINATIONS } from "./destinations";

/** Snapshot supplied by the existing account-bound sidecar reader; null means not fresh. */
export function deviceNavigation(navigation: NavigationCompatibility, snapshot: () => readonly SidecarInfo[] | null) {
  const deviceDetails = (identity: BriefConnection) => {
    const row = identity.kind === "device" && identity.permissions.canInspect
      ? snapshot()?.find(sc => `device:${sc.id}` === identity.sourceId && sc.id === identity.accountId) : undefined;
    return row ? {
      version: row.version ?? null,
      updateLabel: row.update_available ? `Update ${row.latest_version ?? "available"}` : null,
      // This exposes an inspection handoff, including manual update instructions.
      canUpdate: row.connected && row.update_available === true && !updatePending(row) && !updateInProgress(row.update_state),
    } : null;
  };
  return {
    deviceDetails,
    addDevice: (signal: AbortSignal) => destinationPort(navigation).navigate("devices", signal),
    async manageDevice(identity: BriefConnection, action: "inspect" | "update" | "revoke", signal: AbortSignal): Promise<{ state: "opened" | "unavailable" }> {
      const result = await navigation.open(() => {
        const details = deviceDetails(identity);
        if (!details || (action === "update" && !details.canUpdate) || (action === "revoke" && !identity.permissions.canRevoke)) throw Error("Device control unavailable");
        return { target: { ...DESTINATIONS.devices.legacy, sidecarId: identity.accountId! }, message: "Opening device controls in the current dashboard. Review the selected device before making changes." };
      }, signal);
      return { state: result.state === "opened" ? "opened" : "unavailable" };
    },
  };
}
