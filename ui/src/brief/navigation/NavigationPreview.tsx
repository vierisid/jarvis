import React, { useMemo, useState } from "react";
import { BriefCapabilities } from "../../../../src/brief/capabilities";
import { registerNavigationCompatibility } from "../../../../src/brief/navigation-compatibility";
import { NavigationCompatibility } from "./controller";
import { DESTINATIONS, type DestinationId } from "./destinations";
import { AttentionRoutes } from "./AttentionRoutes";
import { MaintenanceLinks } from "./MaintenanceLinks";
import { attentionKey, type AttentionSnapshot } from "./notifications";
import "./preview.css";

/** Isolated F-25 behavior specimen. No runtime settings, network, voice or account effects. */
export function NavigationPreview() {
  const [last, setLast] = useState("No destination opened.");
  const [message, setMessage] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [intent, setIntent] = useState("arrange");
  const [read, setRead] = useState<string[]>([]);
  const dirtyRef = React.useRef(dirty); dirtyRef.current = dirty;
  const navigation = useMemo(() => {
    const nav = new NavigationCompatibility({
      roomAvailable: () => false,
      canLeave: async () => !dirtyRef.current,
      commit: target => setLast(JSON.stringify(target)), explain: setMessage,
    });
    nav.setAccess(new BriefCapabilities(registerNavigationCompatibility(() => ({
      destinations: true, guardedNavigation: true, roomIntents: true, notificationsOutsideChat: true,
    })), ["navigationCompatibility"]).snapshot());
    return nav;
  }, []);
  const snapshot: AttentionSnapshot = stale ? { status: "stale" } : {
    status: "ready", items: [
      { id: "approval-fixture", source: "approval", kind: "approval", title: "Review a pending approval", text: "Fixture permission request", timestamp: 1, tone: "warn", unread: !read.includes("approval:approval-fixture") },
      { id: "failure-fixture", source: "failure", kind: "system", title: "Inspect a failed task", text: "Fixture failure; opening does not retry it", timestamp: 2, tone: "warn", unread: !read.includes("failure:failure-fixture"), refs: { taskId: "task-fixture" } },
      { id: "update-fixture", source: "update", kind: "system", title: "Inspect a device update", text: "Fixture update; opening does not install it", timestamp: 3, tone: "neutral", unread: !read.includes("update:update-fixture") },
    ],
  };
  return <main className="brief-foundation brief-navigation-preview">
    <h1>F-25 · Navigation compatibility</h1>
    <p>Isolated behavior preview. All data is a fixture. No actions run.</p>
    <div className="brief-foundation__controls">
      <button onClick={() => setChatOpen(!chatOpen)}>Conversation: {chatOpen ? "open" : "closed"}</button>
      <button onClick={() => setStale(!stale)}>Notifications: {stale ? "stale" : "ready"}</button>
      <button onClick={() => setDirty(!dirty)}>Draft guard: {dirty ? "cancel" : "allow"}</button>
    </div>
    {chatOpen && <aside>Fixture conversation</aside>}
    <AttentionRoutes snapshot={snapshot} navigation={navigation} roomAvailable={() => false} markRead={identity => setRead(ids => [...ids, attentionKey(identity)])} />
    <section aria-label="Navigation checks">
      <label>Room request <input value={intent} onChange={e => setIntent(e.target.value)} /></label>
      <button onClick={() => void navigation.intent(intent)}>Open room request</button>
      <label>Retained destination <select defaultValue="advanced-settings" onChange={e => void navigation.navigate(e.target.value as DestinationId)}>
        {Object.entries(DESTINATIONS).map(([id, d]) => <option key={id} value={id}>{d.label}</option>)}
      </select></label>
      <p role="status">{message}</p><pre style={{ whiteSpace: "pre-wrap" }}>{last}</pre>
    </section>
    <MaintenanceLinks href="http://fixture.invalid/?brief=1#/brief/settings" onNavigate={id => void navigation.navigate(id)} />
  </main>;
}
