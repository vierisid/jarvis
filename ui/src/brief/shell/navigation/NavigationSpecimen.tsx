import React, { useMemo, useState } from "react";
import { BriefButton, BriefInput, BriefSelect, BriefSwitch } from "../../components/controls";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { BRIEF_ROOMS } from "../../rooms/registry";
import { NavigationShell } from "./NavigationShell";
import type { BriefNavigationBinding, BriefNavigationData } from "./model";
import "./specimen.css";

/** The production shell with explicit fixtures. No API, socket, microphone,
 * account mutation, or fabricated live room is mounted by this review URL. */
export function NavigationSpecimen() {
  const [route, setRoute] = useState<BriefRoute>({ room: "today", selection: {} });
  const [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded");
  const [chatOpen, setChatOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [connection, setConnection] = useState<BriefNavigationData["connection"]>("connected");
  const [accountState, setAccountState] = useState("ready");
  const [badgeCount, setBadgeCount] = useState(4);
  const [draft, setDraft] = useState("");
  const shell = useMemo<BriefShellPort>(() => ({ mode: "preview", route, sidebar, setSidebar, chatOpen, setChatOpen,
    theme, setTheme, navigate: setRoute }), [route, sidebar, chatOpen, theme, setTheme]);
  const binding: BriefNavigationBinding = { capabilities: null, view: { source: "fixture", state: { status: "ready", data: {
    workspaceName: "Vieri’s workspace", account: {
      name: accountState === "unavailable" ? null : accountState === "long" ? "Vieri Balboni · Design partner workspace" : "Vieri Balboni",
      plan: accountState === "ready" ? { status: "ready", data: "Pro plan" } : accountState === "self" ? { status: "ready", data: "Self-hosted" }
        : accountState === "long" ? { status: "ready", data: "Hosted Business + Additional storage" }
        : accountState === "loading" ? { status: "loading" } : { status: "unavailable", reason: "Unavailable" },
    }, connection, hosting: accountState === "self" ? "self" : "hosted",
    badges: { workflows: badgeCount, opportunities: 2, "needs-you": 1 },
    objectTitle: route.selection.flowId ? "Meeting follow-ups" : undefined,
  } } } };
  return <div className="brief-root" data-brief-theme={theme}>
    <NavigationShell shell={shell} rooms={BRIEF_ROOMS} binding={binding}>
      <div className="brief-shell-reading brief-navigation-specimen">
        <p className="brief-type-data brief-navigation-specimen__eyebrow">D-05 · ISOLATED SHELL REVIEW</p>
        <h1 className="brief-type-room-title">{BRIEF_ROOMS[route.room]?.title}</h1>
        <p className="brief-type-body brief-navigation-specimen__intro">The sidebar and header are the working components. This content is a review harness; account details and counts below are illustrative. Room layouts arrive in their own PRs.</p>
        <section className="brief-navigation-specimen__controls" aria-label="Review controls">
          <h2 className="brief-type-section-heading">Try the shell</h2>
          <div className="brief-navigation-specimen__toolbar">
            <BriefButton variant="secondary" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Switch to {theme === "light" ? "dark" : "light"}</BriefButton>
            <BriefSwitch label="Retained conversation state" checked={chatOpen} onCheckedChange={setChatOpen} onLabel="Conversation open" offLabel="Conversation closed" />
            <BriefButton variant="secondary" onClick={() => setBadgeCount(badgeCount === 4 ? 99 : badgeCount === 99 ? 120 : 4)}>Change badge count</BriefButton>
          </div>
          <div className="brief-navigation-specimen__fields">
            <BriefSelect label="Connection example" value={connection} onChange={event => setConnection(event.target.value as typeof connection)}>
              <option value="connected">Connected</option><option value="reconnecting">Reconnecting</option><option value="offline">Offline</option><option value="unknown">Unavailable</option>
            </BriefSelect>
            <BriefSelect label="Account example" value={accountState} onChange={event => setAccountState(event.target.value)}>
              <option value="ready">Known plan</option><option value="loading">Loading plan</option><option value="unavailable">Unavailable account</option><option value="self">Self-hosted</option><option value="long">Long name and plan</option>
            </BriefSelect>
          </div>
        </section>
        <section className="brief-navigation-specimen__continuity" aria-label="Continuity check">
          <h2 className="brief-type-section-heading">Keep your place</h2>
          <BriefInput label="Retained draft" value={draft} placeholder="Write something, then collapse the sidebar" onChange={event => setDraft(event.target.value)} />
          <div className="brief-navigation-specimen__toolbar">
            <BriefButton variant="secondary" onClick={() => setRoute({ room: "workflow-runs", selection: { flowId: "fixture-follow-up", runId: "fixture-run-012" } })}>Select sample run</BriefButton>
            <BriefButton variant="text" onClick={() => setRoute({ room: "today", selection: {} })}>Return to Today</BriefButton>
          </div>
          <dl className="brief-navigation-specimen__state" aria-label="Retained shell state">
            <div><dt>Sidebar preference</dt><dd>{sidebar}</dd></div><div><dt>Conversation</dt><dd>{chatOpen ? "open" : "closed"}</dd></div>
            <div><dt>Selected run</dt><dd>{route.selection.runId ?? "None"}</dd></div><div><dt>Appearance</dt><dd>{theme}</dd></div>
          </dl>
        </section>
        <p className="brief-type-utility brief-navigation-specimen__note">The conversation state above checks continuity only. Pebble placement and panel reflow belong to D-06. No live navigation is enabled before F-25.</p>
        <a className="brief-link" href="?brief=preview#/_brief_preview">Back to implementation references</a>
      </div>
    </NavigationShell>
  </div>;
}
