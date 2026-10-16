import React, { useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { OnboardingGate } from "../../v2/onboarding/OnboardingGate";
import { useTheme } from "../../v2/shell/useTheme";
import { BriefButton } from "../components/controls";
import type { BriefGate, BriefRoomRegistry, BriefRoute, BriefShellPort } from "../contracts";
import { BRIEF_ROOMS } from "../rooms/registry";
import { FoundationPreview } from "../preview/FoundationPreview";
import { briefHash, legacyHref, resolveBriefEntry } from "./route";
import { NavigationShell } from "../shell/navigation/NavigationShell";
import { canMountNavigation, type BriefNavigationBinding } from "../shell/navigation/model";
import "./foundation.css";
import "../styles/index.css";
import type { BriefConversationBinding } from "../shell/pebble-layout/PebbleLayout";

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
}

/** Exactly one root is mounted. No live thread, socket, voice or domain writer here. */
export function DashboardEntry({ legacy, rooms = BRIEF_ROOMS, Gate = OnboardingGate, navigation, conversation }: DashboardEntryProps) {
  const href = useSyncExternalStore(subscribeLocation, locationSnapshot, serverSnapshot);
  const entry = resolveBriefEntry(href);
  if (entry.kind === "legacy") return <>{legacy}</>;
  if (entry.kind === "preview") return <FoundationPreview />;
  return (
    <div className="jarvis-v2-root">
      <Gate><BriefHost route={entry.route} rooms={rooms} navigation={navigation} conversation={conversation} /></Gate>
    </div>
  );
}

function BriefHost({ route, rooms, navigation, conversation }: { route: BriefRoute; rooms: BriefRoomRegistry; navigation?: BriefNavigationBinding; conversation?: BriefConversationBinding }) {
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [chatOpen, setChatOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const shell: BriefShellPort = useMemo(() => ({
    mode: "live", route, sidebar, setSidebar, chatOpen, setChatOpen, theme, setTheme,
    navigate: (next) => { window.location.hash = briefHash(next); },
  }), [route, sidebar, chatOpen, theme, setTheme]);
  const room = rooms[route.room];
  const Body = room?.Body;
  const activated = canMountNavigation(shell.mode, navigation);
  return (
    <div className={`brief-root${activated ? "" : " brief-foundation"}`} data-brief-room={route.room} data-brief-theme={theme}>
      <NavigationShell shell={shell} rooms={rooms} binding={navigation} conversation={conversation}>
      {Body ? <Body key={route.room} shell={shell} /> : (
        <section className="brief-foundation__notice" aria-labelledby="brief-unavailable-title">
          <p className="brief-foundation__label">Brief preview</p>
          <h1 id="brief-unavailable-title">{room?.title ?? "This room"} is not available in Brief yet</h1>
          <p>Your current dashboard is still available. No data has been changed.</p>
          <BriefButton onClick={() => {
            window.location.assign(legacyHref(window.location.href, room?.legacyRoom ? `#/_room_${room.legacyRoom}` : "#/"));
          }}>Open current dashboard</BriefButton>
        </section>
      )}
      </NavigationShell>
    </div>
  );
}
