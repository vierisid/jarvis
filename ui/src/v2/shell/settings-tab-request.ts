/**
 * Opening Settings on a given tab from outside the room (the sidecar update
 * hint). The room keeps its tab in local state, so the request is left here
 * for the next SettingsRoomBody to mount with, and also broadcast for one
 * that is already mounted. Consumed once.
 */

import type { SettingsTab } from "../rooms/settings/SettingsRoom";

export const SETTINGS_TAB_EVENT = "jarvis:settings-tab";

let pending: SettingsTab | null = null;

export function requestSettingsTab(tab: SettingsTab): void {
  pending = tab;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<SettingsTab>(SETTINGS_TAB_EVENT, { detail: tab }));
  }
}

/** The requested tab, if any, for a Settings room that is mounting now. */
export function takeRequestedSettingsTab(): SettingsTab | null {
  const tab = pending;
  pending = null;
  return tab;
}

/** Sidecar data changed by an action (an update request); pollers refresh. */
export const SIDECARS_CHANGED_EVENT = "jarvis:sidecars-changed";

export function announceSidecarsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SIDECARS_CHANGED_EVENT));
}
