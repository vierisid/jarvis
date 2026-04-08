import React from "react";
import type { SettingsSection } from "../App";
import { PersonalityPanel } from "../components/settings/PersonalityPanel";
import { LLMPanel } from "../components/settings/LLMPanel";
import { HeartbeatPanel } from "../components/settings/HeartbeatPanel";
import { RolePanel } from "../components/settings/RolePanel";
import { IntegrationsPanel } from "../components/settings/IntegrationsPanel";
import { ChannelsPanel } from "../components/settings/ChannelsPanel";
import { SidecarPanel } from "../components/settings/SidecarPanel";
import { ServicePanel } from "../components/settings/ServicePanel";
import { UpdatePanel } from "../components/settings/UpdatePanel";

const SECTION_META: Record<SettingsSection, { title: string; subtitle: string }> = {
  general: { title: "General", subtitle: "Personality, role, and heartbeat configuration" },
  llm: { title: "LLM Configuration", subtitle: "Manage AI providers, models, and API keys" },
  channels: { title: "Communication Channels", subtitle: "Telegram, Discord, voice transcription, and text-to-speech" },
  integrations: { title: "Integrations", subtitle: "Third-party service connections" },
  sidecar: { title: "Sidecar", subtitle: "Remote machine control via Go sidecar agents" },
  update: { title: "Update", subtitle: "Check GitHub releases and install the latest JARVIS build" },
};

export default function SettingsPage({ section }: { section: SettingsSection }) {
  const meta = SECTION_META[section];

  return (
    <div style={{ padding: "32px 40px", overflow: "auto", height: "100%" }}>
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>
        <h1 style={{
          fontSize: "18px",
          fontWeight: 600,
          color: "var(--j-text)",
          margin: 0,
        }}>
          {meta.title}
        </h1>
        <div style={{
          fontSize: "13px",
          color: "var(--j-text-muted)",
          marginTop: "4px",
          marginBottom: "28px",
        }}>
          {meta.subtitle}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {section === "general" && (
            <>
              <ServicePanel />
              <PersonalityPanel />
              <RolePanel />
              <HeartbeatPanel />
            </>
          )}
          {section === "llm" && <LLMPanel />}
          {section === "channels" && <ChannelsPanel />}
          {section === "integrations" && <IntegrationsPanel />}
          {section === "sidecar" && <SidecarPanel />}
          {section === "update" && <UpdatePanel />}
        </div>
      </div>
    </div>
  );
}
