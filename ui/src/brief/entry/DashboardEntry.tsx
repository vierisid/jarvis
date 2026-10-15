import React, { useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { OnboardingGate } from "../../v2/onboarding/OnboardingGate";
import { useTheme } from "../../v2/shell/useTheme";
import { BriefButton } from "../components/controls";
import type { BriefGate, BriefRoomRegistry, BriefRoute, BriefShellPort } from "../contracts";
import { BRIEF_ROOMS } from "../rooms/registry";
import { FoundationPreview } from "../preview/FoundationPreview";
import { briefHash, legacyHref, resolveBriefEntry } from "./route";
import "./foundation.css";
import "../styles/index.css";

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
}

/** Exactly one root is mounted. No live thread, socket, voice or domain writer here. */
export function DashboardEntry({ legacy, rooms = BRIEF_ROOMS, Gate = OnboardingGate }: DashboardEntryProps) {
  const href = useSyncExternalStore(subscribeLocation, locationSnapshot, serverSnapshot);
  const entry = resolveBriefEntry(href);
  if (entry.kind === "legacy") return <>{legacy}</>;
  if (entry.kind === "preview") return <FoundationPreview />;
  return (
    <div className="jarvis-v2-root">
      <Gate><BriefHost route={entry.route} rooms={rooms} /></Gate>
    </div>
  );
}

function BriefHost({ route, rooms }: { route: BriefRoute; rooms: BriefRoomRegistry }) {
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [chatOpen, setChatOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const shell: BriefShellPort = useMemo(() => ({
    mode: "live", route, sidebar, setSidebar, chatOpen, setChatOpen, theme, setTheme,
    navigate: (next) => { window.location.hash = briefHash(next); },
  }), [route, sidebar, chatOpen, theme, setTheme]);
  const room = rooms[route.room];
  const Body = room?.Body;
  return (
    <main className="brief-root brief-foundation" data-brief-room={route.room}>
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
    </main>
  );
}
