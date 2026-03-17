import React, { useState, useEffect } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { useVoice } from "./hooks/useVoice";

import ChatPage from "./pages/ChatPage";

// Lazy page imports
const TasksPage = React.lazy(() => import("./pages/TasksPage"));
const PipelinePage = React.lazy(() => import("./pages/PipelinePage"));
const KnowledgePage = React.lazy(() => import("./pages/KnowledgePage"));
const MemoryPage = React.lazy(() => import("./pages/MemoryPage"));
const CalendarPage = React.lazy(() => import("./pages/CalendarPage"));
const OfficePage = React.lazy(() => import("./pages/OfficePage"));
const CommandPage = React.lazy(() => import("./pages/CommandPage"));
const AuthorityPage = React.lazy(() => import("./pages/AuthorityPage"));
const SettingsPage = React.lazy(() => import("./pages/SettingsPage"));
const AwarenessPage = React.lazy(() => import("./pages/AwarenessPage"));
const WorkflowsPage = React.lazy(() => import("./pages/WorkflowsPage"));
const GoalsPage = React.lazy(() => import("./pages/GoalsPage"));

type Route = "chat" | "tasks" | "pipeline" | "memory" | "calendar" | "office" | "knowledge" | "command" | "authority" | "awareness" | "workflows" | "goals" | "settings";

export type SettingsSection = "general" | "llm" | "channels" | "integrations" | "sidecar";

const SETTINGS_SECTIONS: SettingsSection[] = ["general", "llm", "channels", "integrations", "sidecar"];

function getRoute(): Route {
  const hash = window.location.hash.replace("#/", "");
  if (hash.startsWith("settings")) return "settings";
  if (["chat", "tasks", "pipeline", "memory", "calendar", "office", "knowledge", "command", "authority", "awareness", "workflows", "goals"].includes(hash)) {
    return hash as Route;
  }
  return "chat";
}

function getSettingsSection(): SettingsSection {
  const hash = window.location.hash.replace("#/", "");
  if (hash.startsWith("settings/")) {
    const section = hash.replace("settings/", "");
    if (SETTINGS_SECTIONS.includes(section as SettingsSection)) {
      return section as SettingsSection;
    }
  }
  return "general";
}

function PageFallback() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      color: "var(--j-text-dim)",
      fontSize: "14px",
    }}>
      Loading...
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(getRoute);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(getSettingsSection);
  const ws = useWebSocket();
  const voice = useVoice({ wsRef: ws.wsRef });

  // Wire voice callbacks into WS hook
  useEffect(() => {
    ws.voiceCallbacksRef.current = {
      onTTSBinary: voice.handleTTSBinary,
      onTTSStart: voice.handleTTSStart,
      onTTSEnd: voice.handleTTSEnd,
      onError: voice.handleError,
    };
  }, [voice.handleTTSBinary, voice.handleTTSStart, voice.handleTTSEnd, voice.handleError]);

  useEffect(() => {
    const onHashChange = () => {
      setRoute(getRoute());
      setSettingsSection(getSettingsSection());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Set default hash if none
  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = "#/chat";
    }
  }, []);

  const navigate = (r: Route) => {
    window.location.hash = `#/${r}`;
  };

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
      {/* Sidebar */}
      <nav style={{
        width: "240px",
        minWidth: "240px",
        background: "var(--j-surface)",
        borderRight: "1px solid var(--j-border)",
        display: "flex",
        flexDirection: "column",
        padding: "0",
      }}>
        {/* Logo */}
        <div style={{
          padding: "24px 16px 20px",
          borderBottom: "1px solid var(--j-border)",
        }}>
          <div style={{
            fontSize: "18px",
            fontWeight: 700,
            color: "var(--j-accent)",
            letterSpacing: "3px",
            textAlign: "center",
            textShadow: "0 0 20px rgba(0, 212, 255, 0.5), 0 0 40px rgba(0, 212, 255, 0.2)",
          }}>
            J.A.R.V.I.S.
          </div>
          <div style={{
            fontSize: "10px",
            color: "var(--j-text-muted)",
            textAlign: "center",
            marginTop: "4px",
            letterSpacing: "1.5px",
          }}>
            INTELLIGENT SYSTEM
          </div>
        </div>

        {/* Nav Links */}
        <div style={{ flex: 1, minHeight: 0, padding: "12px 8px", display: "flex", flexDirection: "column", gap: "2px", overflowY: "auto" }}>
          <NavItem icon={"\u25C8"} label="Chat" route="chat" active={route} onClick={navigate} />
          <NavItem icon={"\u2726"} label="Tasks" route="tasks" active={route} onClick={navigate} />
          <NavItem icon={"\u25B6"} label="Pipeline" route="pipeline" active={route} onClick={navigate} />
          <NavItem icon={"\u25C6"} label="Memory" route="memory" active={route} onClick={navigate} />
          <NavItem icon={"\u25A1"} label="Calendar" route="calendar" active={route} onClick={navigate} />
          <NavItem icon={"\u25CB"} label="Office" route="office" active={route} onClick={navigate} />
          <NavItem icon={"\u25C7"} label="Knowledge" route="knowledge" active={route} onClick={navigate} />
          <NavItem icon={"\u25A3"} label="Command Center" route="command" active={route} onClick={navigate} />
          <NavItem icon={"\u25CE"} label="Awareness" route="awareness" active={route} onClick={navigate} />
          <NavItem icon={"\u26A1"} label="Workflows" route="workflows" active={route} onClick={navigate} />
          <NavItem icon={"\u25B2"} label="Goals" route="goals" active={route} onClick={navigate} />
          <NavItem icon={"\u2666"} label="Authority" route="authority" active={route} onClick={navigate} />

          {/* Settings with collapsible sub-items */}
          <SettingsNavGroup
            isActive={route === "settings"}
            activeSection={settingsSection}
          />
        </div>

        {/* Status */}
        <AwarenessStatusBar isConnected={ws.isConnected} />
      </nav>

      {/* Main Content */}
      <main style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <React.Suspense fallback={<PageFallback />}>
          {route === "chat" && <ChatPage messages={ws.messages} isConnected={ws.isConnected} sendMessage={ws.sendMessage} voice={voice} />}
          {route === "tasks" && <TasksPage taskEvents={ws.taskEvents} />}
          {route === "pipeline" && <PipelinePage contentEvents={ws.contentEvents} sendMessage={ws.sendMessage} />}
          {route === "memory" && <MemoryPage />}
          {route === "calendar" && <CalendarPage taskEvents={ws.taskEvents} contentEvents={ws.contentEvents} />}
          {route === "office" && <OfficePage agentActivity={ws.agentActivity} />}
          {route === "knowledge" && <KnowledgePage />}
          {route === "command" && <CommandPage />}
          {route === "awareness" && <AwarenessPage />}
          {route === "workflows" && <WorkflowsPage workflowEvents={ws.workflowEvents} sendMessage={ws.sendMessage} />}
          {route === "goals" && <GoalsPage goalEvents={ws.goalEvents} />}
          {route === "authority" && <AuthorityPage />}
          {route === "settings" && <SettingsPage section={settingsSection} />}
        </React.Suspense>
      </main>
    </div>
  );
}

function NavItem({ icon, label, route, active, onClick }: {
  icon: string;
  label: string;
  route: Route;
  active: Route;
  onClick: (r: Route) => void;
}) {
  const isActive = route === active;
  return (
    <button
      onClick={() => onClick(route)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        borderRadius: "6px",
        border: "none",
        background: isActive ? "rgba(0, 212, 255, 0.1)" : "transparent",
        color: isActive ? "var(--j-accent)" : "var(--j-text-dim)",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: isActive ? 600 : 400,
        textAlign: "left",
        width: "100%",
        transition: "all 0.15s ease",
        borderLeft: isActive ? "2px solid var(--j-accent)" : "2px solid transparent",
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = "var(--j-surface-hover)";
          e.currentTarget.style.color = "var(--j-text)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--j-text-dim)";
        }
      }}
    >
      <span style={{ fontSize: "14px", width: "20px", textAlign: "center" }}>{icon}</span>
      {label}
    </button>
  );
}

const SETTINGS_NAV: { section: SettingsSection; label: string }[] = [
  { section: "general", label: "General" },
  { section: "llm", label: "LLM" },
  { section: "channels", label: "Channels" },
  { section: "integrations", label: "Integrations" },
  { section: "sidecar", label: "Sidecar" },
];

function SettingsNavGroup({ isActive, activeSection }: {
  isActive: boolean;
  activeSection: SettingsSection;
}) {
  return (
    <div>
      {/* Settings parent button */}
      <button
        onClick={() => {
          if (!isActive) {
            window.location.hash = "#/settings/general";
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "8px 12px",
          borderRadius: "6px",
          border: "none",
          background: isActive ? "rgba(0, 212, 255, 0.1)" : "transparent",
          color: isActive ? "var(--j-accent)" : "var(--j-text-dim)",
          cursor: "pointer",
          fontSize: "13px",
          fontWeight: isActive ? 600 : 400,
          textAlign: "left",
          width: "100%",
          transition: "all 0.15s ease",
          borderLeft: isActive ? "2px solid var(--j-accent)" : "2px solid transparent",
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            e.currentTarget.style.background = "var(--j-surface-hover)";
            e.currentTarget.style.color = "var(--j-text)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--j-text-dim)";
          }
        }}
      >
        <span style={{ fontSize: "14px", width: "20px", textAlign: "center" }}>{"\u2699"}</span>
        <span style={{ flex: 1 }}>Settings</span>
        <span style={{
          fontSize: "10px",
          color: "var(--j-text-muted)",
          transition: "transform 0.2s",
          transform: isActive ? "rotate(90deg)" : "rotate(0deg)",
        }}>{"\u25B6"}</span>
      </button>

      {/* Sub-items — only visible when settings is active */}
      {isActive && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", marginTop: "2px" }}>
          {SETTINGS_NAV.map(({ section, label }) => {
            const isSectionActive = activeSection === section;
            return (
              <button
                key={section}
                onClick={() => { window.location.hash = `#/settings/${section}`; }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 12px 6px 42px",
                  borderRadius: "4px",
                  border: "none",
                  background: isSectionActive ? "rgba(0, 212, 255, 0.08)" : "transparent",
                  color: isSectionActive ? "var(--j-accent)" : "var(--j-text-muted)",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: isSectionActive ? 600 : 400,
                  textAlign: "left",
                  width: "100%",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (!isSectionActive) {
                    e.currentTarget.style.background = "var(--j-surface-hover)";
                    e.currentTarget.style.color = "var(--j-text)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSectionActive) {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--j-text-muted)";
                  }
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AwarenessStatusBar({ isConnected }: { isConnected: boolean }) {
  const [status, setStatus] = useState<{ running: boolean; appName?: string; captureCount?: number } | null>(null);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const resp = await fetch("/api/awareness/status");
        if (resp.ok && mounted) {
          const data = await resp.json();
          setStatus({
            running: data.running,
            appName: data.liveContext?.currentApp,
            captureCount: data.liveContext?.captureCount,
          });
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  const dotColor = !isConnected
    ? "var(--j-text-muted)"
    : status?.running
    ? "var(--j-success)"
    : "var(--j-warning, #f59e0b)";

  const label = !isConnected
    ? "Disconnected"
    : status?.running
    ? status.appName
      ? `Watching: ${status.appName}`
      : "Awareness Active"
    : "System Online";

  return (
    <div style={{
      padding: "12px 16px",
      borderTop: "1px solid var(--j-border)",
      fontSize: "11px",
      color: "var(--j-text-muted)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: dotColor,
          display: "inline-block",
          boxShadow: status?.running ? `0 0 6px ${dotColor}` : "none",
        }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
      </div>
    </div>
  );
}
