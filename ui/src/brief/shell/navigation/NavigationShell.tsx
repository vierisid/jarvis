import React, { useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Eye, FileText, GitBranch, House, Laptop, PanelLeftClose, PanelLeftOpen, ShieldCheck, Target } from "lucide-react";
import { BriefTooltip } from "../../components/controls";
import { BriefBrand } from "../../styles/BriefBrand";
import { useBriefMotion } from "../../motion";
import type { BriefRoomRegistry, BriefShellPort } from "../../contracts";
import { AccountMenu } from "../account-menu/AccountMenu";
import { badgeLabel, breadcrumbs, canMountNavigation, connectionLabel, DIRECTION_NAV, navigationData,
  navigationRoute, NAV_LABELS, parentRoom, PRIMARY_NAV, UNKNOWN_NAVIGATION, UTILITY_NAV,
  type BriefNavigationBinding, type BriefNavigationData, type NavRoom } from "./model";
import "./navigation.css";
import { PebbleLayout, type BriefConversationBinding } from "../pebble-layout/PebbleLayout";

const ICONS = { today: House, workflows: GitBranch, opportunities: Eye, "needs-you": ShieldCheck,
  goals: Target, memory: FileText, "connected-workspace": Laptop, authority: ShieldCheck };
const NARROW_QUERY = "(max-width: 699px)";
function subscribeWidth(changed: () => void) {
  const media = window.matchMedia(NARROW_QUERY); media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
}
function narrowSnapshot() { return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches; }

export interface NavigationShellProps {
  shell: BriefShellPort;
  rooms: BriefRoomRegistry;
  binding?: BriefNavigationBinding;
  conversation?: BriefConversationBinding;
  reducedMotion?: boolean;
  children: React.ReactNode;
}

/** D-01 owns routing and state; this shell only lays out those persistent children.
 * F-25 activation and a live view are required before replacing released navigation. */
export function NavigationShell({ shell, rooms, binding, conversation, reducedMotion, children }: NavigationShellProps) {
  const id = useId();
  const content = useRef<HTMLElement>(null);
  const active = canMountNavigation(shell.mode, binding);
  const narrow = useSyncExternalStore(subscribeWidth, narrowSnapshot, () => false);
  // A dense viewport uses the existing rail; the user's wider-layout preference survives.
  const rail = narrow || shell.sidebar === "rail";
  const data = active && binding ? navigationData(binding.view) : UNKNOWN_NAVIGATION;
  const crumbs = breadcrumbs(shell.route, rooms[shell.route.room]?.title ?? "Today", data.objectTitle);
  const statusLabel = connectionLabel(data);
  // A new destination starts at its heading. Local selection, theme, chat and
  // sidebar changes keep their current offset; they are not room navigation.
  useLayoutEffect(() => {
    if (content.current) { content.current.scrollTop = 0; content.current.scrollLeft = 0; }
  }, [shell.route.room]);
  // Keep the content's entire ancestor chain mounted as readiness changes.
  // Only navigation chrome is gated, so an outage cannot discard local edits.
  return <div className="brief-navigation" data-navigation-active={active} data-rail={rail} data-requested-sidebar={shell.sidebar} data-chat-open={shell.chatOpen}>
    {active && <a className="brief-skip" href={`#${id}-content`} onClick={event => {
      event.preventDefault(); content.current?.focus();
    }}>Skip to content</a>}
    {active && <Sidebar shell={shell} data={data} rail={rail} narrow={narrow} id={id} />}
    <div className="brief-workspace">
      {active && <header className="brief-workspace-header">
        <nav className="brief-breadcrumb" aria-label="Breadcrumb">
          <span className="brief-workspace-name" title={data.workspaceName || "Your workspace"}>{data.workspaceName || "Your workspace"}</span>
          <span aria-hidden="true">/</span>
          {crumbs.parent && <><button type="button" onClick={() => shell.navigate(crumbs.parent!.route)}>{crumbs.parent.label}</button><span aria-hidden="true">/</span></>}
          <strong aria-current="page" title={crumbs.current}>{crumbs.current}</strong>
        </nav>
        <BriefTooltip label={statusLabel}>
          <button type="button" className="brief-connection" aria-label={`${statusLabel}. Open connected workspace`}
            onClick={() => { if (shell.route.room !== "connected-workspace") shell.navigate({ room: "connected-workspace", selection: {} }); }}>
            <span className="brief-connection-dot" data-state={data.connection} aria-hidden="true" />
          </button>
        </BriefTooltip>
      </header>}
      <PebbleLayout shell={shell} enabled={active} conversation={conversation} reducedMotion={reducedMotion}>
      <main ref={content} className="brief-workspace-content" id={`${id}-content`} tabIndex={-1} data-brief-room={shell.route.room}>
        {children}
      </main>
      </PebbleLayout>
    </div>
  </div>;
}

function Sidebar({ shell, data, rail, narrow, id }: {
  shell: BriefShellPort; data: BriefNavigationData; rail: boolean; narrow: boolean; id: string;
}) {
  const selected = parentRoom(shell.route.room);
  const sidebarRef = useBriefMotion<HTMLElement>({ width: rail ? 72 : 232 }, { kind: "reflow", active: rail });
  const wordRef = useBriefMotion<HTMLSpanElement>({ opacity: rail ? 0 : 1 }, { kind: "reveal", active: !rail });
  const row = (room: NavRoom) => {
    const Icon = ICONS[room];
    const label = NAV_LABELS[room];
    const count = badgeLabel(data.badges[room as keyof typeof data.badges]);
    const route = navigationRoute(room, shell.route);
    return <BriefTooltip key={room} label={label} placement="right" disabled={!rail}>
      <button type="button" className="brief-nav-row" aria-label={label} aria-describedby={count === null ? undefined : `${id}-${room}-count`} aria-current={selected === room ? "page" : undefined}
        onClick={() => { if (route !== shell.route) shell.navigate(route); }}>
        <Icon className="brief-nav-icon" size={17} strokeWidth={1.6} aria-hidden="true" />
        <span className="brief-nav-label" aria-hidden={rail}>{label}</span>
        <span id={`${id}-${room}-count`} className="brief-nav-count" data-attention={room === "needs-you" && count !== "0"}
          aria-label={count === null ? undefined : `${data.badges[room as keyof typeof data.badges]} ${label.toLowerCase()}`}>
          {count}
        </span>
      </button>
    </BriefTooltip>;
  };
  return <aside className="brief-sidebar" ref={sidebarRef} aria-label="Workspace navigation">
      <div className="brief-sidebar-brand" role="img" aria-label="usejarvis">
        <span className="brief-sidebar-brand__mark" aria-hidden="true"><BriefBrand /></span>
        <span className="brief-sidebar-brand__word" ref={wordRef} aria-hidden="true"><BriefBrand /></span>
      </div>
      <div className="brief-collapse-anchor">
        <BriefTooltip label={narrow ? "Compact navigation" : rail ? "Expand sidebar" : "Collapse sidebar"} placement={rail ? "right" : undefined}>
          <button type="button" className="brief-collapse" aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!rail} aria-controls={`${id}-navigation`} disabled={narrow}
            onClick={() => shell.setSidebar(rail ? "expanded" : "rail")}>
            {rail ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
          </button>
        </BriefTooltip>
      </div>
      <nav id={`${id}-navigation`} className="brief-navigation-rows" aria-label="Main navigation">
        <div className="brief-nav-primary">{PRIMARY_NAV.map(row)}</div>
        <div className="brief-nav-direction">
          <p className="brief-nav-group" aria-hidden={rail}>The bigger picture</p>
          {DIRECTION_NAV.map(row)}
        </div>
        <div className="brief-nav-utilities">{UTILITY_NAV.map(row)}</div>
      </nav>
      <div className="brief-account-block"><AccountMenu shell={shell} account={data.account} rail={rail} /></div>
  </aside>;
}
