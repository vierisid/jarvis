import { briefHash } from "../entry/route";
import type { NavigationHost } from "./controller";
import { targetHref } from "./destinations";
import { clearRequestedSettingsTab, requestSettingsTab } from "../../v2/shell/settings-tab-request";

export interface BrowserNavigationOptions extends Omit<NavigationHost, "commit"> {
  /** Must reveal the canonical item or throw. Merely opening chat is not successful routing. */
  revealConversationItem(id: string): void;
}
export function browserNavigationHost(options: BrowserNavigationOptions): NavigationHost {
  return {
    ...options,
    commit(target) {
      if (target.kind === "conversation") { options.revealConversationItem(target.itemId); return; }
      const url = new URL(window.location.href);
      if (target.kind === "brief") {
        url.searchParams.set("brief", "1");
        url.searchParams.delete("settingsTab");
        url.searchParams.delete("sidecarId");
        url.searchParams.delete("briefMaintenance");
        url.hash = briefHash(target.route);
      }
      const next = target.kind === "legacy" ? targetHref(url.href, target) : url.href;
      // Stay in this module lifetime: queued canonical room actions must survive
      // a Brief -> legacy handoff. Both routers subscribe, but only one root mounts.
      const oldURL = window.location.href;
      clearRequestedSettingsTab();
      window.history.pushState(null, "", next);
      if (target.kind === "legacy" && target.settingsTab) requestSettingsTab(target.settingsTab);
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: next }));
    },
  };
}
