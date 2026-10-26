import React, { lazy, Suspense, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { BriefOnboardingHost, OnboardingGate } from "../../v2/onboarding/OnboardingGate";
import { useTheme } from "../../v2/shell/useTheme";
import { BriefButton } from "../components/controls";
import type { BriefGate, BriefRoomRegistry, BriefRoute, BriefShellPort } from "../contracts";
import { BRIEF_ROOMS } from "../rooms/registry";
import { briefHash, legacyHref } from "./route";
import { isDevToolsEnabled } from "../../v2/devtools";
import { assessBriefRelease, BRIEF_RELEASE, hasReleaseComposition, type BriefReleaseConfig, type BriefReleaseRuntime } from "./release";
import { resolveReleaseEntry, rollbackHref } from "./release-route";
import { NavigationShell } from "../shell/navigation/NavigationShell";
import { canMountNavigation, type BriefNavigationBinding } from "../shell/navigation/model";
import "./foundation.css";
import "../styles/index.css";
import type { BriefConversationBinding } from "../shell/pebble-layout/PebbleLayout";
import { DESTINATIONS, targetHref } from "../navigation/destinations";

const FoundationPreview = lazy(() => import("../preview/FoundationPreview").then(module => ({ default: module.FoundationPreview })));

function subscribeLocation(changed: () => void) {
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  return () => {
    window.removeEventListener("hashchange", changed);
    window.removeEventListener("popstate", changed);
  };
}
const locationSnapshot = () => window.location.href;
const serverSnapshot = () => "http://localhost/";

export interface DashboardEntryProps {
  legacy: ReactNode;
  // Injection is for isolated integration tests and later room composition.
  rooms?: BriefRoomRegistry;
  Gate?: BriefGate;
  /** F-25 supplies the live navigationCompatibility snapshot and read-only view.
   * No binding means no navigation replacement and no additional API reads. */
  navigation?: BriefNavigationBinding;
  /** One conversation supplied by the existing owner; no second live thread. */
  conversation?: BriefConversationBinding;
  /** Reviewed configuration and authenticated runtime, supplied before mounting.
   * No runtime binding/default manifest means production stays on v2. */
  release?: BriefReleaseConfig;
  runtime?: BriefReleaseRuntime;
}

/** Exactly one root is mounted. No live thread, socket, voice or domain writer here. */
export function DashboardEntry({ legacy, rooms = BRIEF_ROOMS, Gate = OnboardingGate, navigation, conversation, release = BRIEF_RELEASE, runtime }: DashboardEntryProps) {
  const href = useSyncExternalStore(subscribeLocation, locationSnapshot, serverSnapshot);
  // Rollout is a document-start decision. Polling/readiness changes must never
  // unmount a room with unsaved work. Room action guards still react to outages.
  // A configured rollback applies on reload, through normal beforeunload guards.
  const [rollout] = useState(() => hasReleaseComposition(rooms, navigation, conversation)
    ? assessBriefRelease(release, runtime).rollout : "off");
  const [devtools] = useState(isDevToolsEnabled);
  const entry = resolveReleaseEntry(href, rollout, devtools);
  if (entry.kind === "legacy") {
    const rollback = rollbackHref(href);
    return rollback ? <RestoreLegacy href={rollback} /> : <>{legacy}</>;
  }
  if (entry.kind === "preview") return <Suspense fallback={null}><FoundationPreview /></Suspense>;
  // Both Brief branches tell the gate it is inside Brief; the legacy branch
  // above never does, whatever the URL says (#1105).
  if (entry.kind === "moved") return <div className="jarvis-v2-root"><BriefOnboardingHost><Gate>
    <main className="brief-foundation"><section className="brief-foundation__notice">
      <h1>This view is not part of Brief</h1>
      <p>Advanced settings and support has links to the retained controls. Your data has not changed.</p>
      <a href={targetHref(href, DESTINATIONS["advanced-settings"].legacy)}>Open advanced settings and support</a>
      <p><a href={legacyHref(href)}>Open current dashboard</a></p>
    </section></main>
  </Gate></BriefOnboardingHost></div>;
  return (
    <div className="jarvis-v2-root">
      <BriefOnboardingHost>
        <Gate><BriefHost route={entry.route} rooms={rooms} navigation={navigation} conversation={conversation} /></Gate>
      </BriefOnboardingHost>
    </div>
  );
}

/** Normalize the hash before the legacy router mounts and takes its snapshot. */
function RestoreLegacy({ href }: { href: string }) {
  useLayoutEffect(() => {
    window.history.replaceState(window.history.state, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [href]);
  return null;
}

export function BriefHost({ route, rooms, navigation, conversation, guardShell, visibility, children }: {
  route: BriefRoute; rooms: BriefRoomRegistry; navigation?: BriefNavigationBinding; conversation?: BriefConversationBinding;
  children?: ReactNode;
  guardShell?: (shell: BriefShellPort) => BriefShellPort; visibility?: { open: boolean; setOpen(value: boolean): void };
}) {
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [localChatOpen, setLocalChatOpen] = useState(false);
  const chatOpen = visibility?.open ?? localChatOpen, setChatOpen = visibility?.setOpen ?? setLocalChatOpen;
  const [theme, setTheme] = useTheme();
  const baseShell: BriefShellPort = useMemo(() => ({
    mode: "live", route, sidebar, setSidebar, chatOpen, setChatOpen, theme, setTheme,
    navigate: (next) => { window.location.hash = briefHash(next); },
  }), [route, sidebar, chatOpen, theme, setTheme, setChatOpen]);
  const shell = guardShell ? guardShell(baseShell) : baseShell;
  const room = rooms[route.room];
  const Body = room?.Body;
  const activated = canMountNavigation(shell.mode, navigation);
  return (
    <div className={`brief-root${activated ? "" : " brief-foundation"}`} data-brief-room={route.room} data-brief-theme={theme}>
      <NavigationShell shell={shell} rooms={rooms} binding={navigation} conversation={conversation}>
      {children ?? (Body ? <Body key={route.room} shell={shell} /> : (
        <section className="brief-foundation__notice" aria-labelledby="brief-unavailable-title">
          <p className="brief-foundation__label">Brief preview</p>
          <h1 id="brief-unavailable-title">{room?.title ?? "This room"} is not available in Brief yet</h1>
          <p>Your current dashboard is still available. No data has been changed.</p>
          <BriefButton onClick={() => {
            window.location.assign(legacyHref(window.location.href, room?.legacyRoom ? `#/_room_${room.legacyRoom}` : "#/"));
          }}>Open current dashboard</BriefButton>
        </section>
      ))}
      </NavigationShell>
    </div>
  );
}
