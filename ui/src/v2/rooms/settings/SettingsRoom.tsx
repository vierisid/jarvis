import React, { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Bot,
  Cable,
  Cog,
  MessagesSquare,
  Mic,
  Server,
  UserCircle2,
  type LucideIcon,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { useRovingTabs } from "../useRovingTabs";
import { useSettingsData, type LLMProvider, LLM_PROVIDERS } from "./useSettingsData";
import {
  resetOnboarding,
  type OnboardingResetScope,
} from "../../onboarding/resetClient";
import { GeneralTab } from "./tabs/GeneralTab";
import { ProfileTab } from "./tabs/ProfileTab";
import { LLMTab } from "./tabs/LLMTab";
import { ChannelsTab } from "./tabs/ChannelsTab";
import { VoiceTab } from "./tabs/VoiceTab";
import { IntegrationsTab } from "./tabs/IntegrationsTab";
import { SidecarTab } from "./tabs/SidecarTab";
import "./SettingsRoom.css";

export type SettingsTab =
  | "general"
  | "profile"
  | "llm"
  | "channels"
  | "voice"
  | "integrations"
  | "sidecar";

const TABS: ReadonlyArray<{ key: SettingsTab; label: string; icon: LucideIcon }> = [
  { key: "general", label: "General", icon: Cog },
  { key: "profile", label: "Profile", icon: UserCircle2 },
  { key: "llm", label: "LLM", icon: Bot },
  { key: "channels", label: "Channels", icon: MessagesSquare },
  { key: "voice", label: "Voice", icon: Mic },
  { key: "integrations", label: "Integrations", icon: Cable },
  { key: "sidecar", label: "Sidecar", icon: Server },
];

const VALID_TABS = new Set<SettingsTab>(TABS.map((t) => t.key));

export type RoomBodyMode = "inline" | "expanded";

const TAB_KEYS = TABS.map((t) => t.key) as ReadonlyArray<SettingsTab>;

export function SettingsRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useSettingsData();
  const [tab, setTab] = useState<SettingsTab>("general");
  const tabsApi = useRovingTabs<SettingsTab>(TAB_KEYS, tab, setTab, "v2-set");
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  const showToast = useCallback((text: string, tone: "ok" | "warn" = "ok") => {
    setToast({ text, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(id);
  }, [toast]);

  // ── Voice room actions ──
  useRoomActions("settings", (action, args) => {
    switch (action) {
      case "switch_tab": {
        const t = String(args.tab);
        if (VALID_TABS.has(t as SettingsTab)) {
          setTab(t as SettingsTab);
          return true;
        }
        return false;
      }
      case "read_status": {
        const lines: string[] = [];
        if (tab === "general" && data.autostart) {
          lines.push(
            `${data.autostart.installed ? "Service installed" : "Service not installed"} on ${data.autostart.platform} (${data.autostart.manager}).`,
          );
        }
        if (tab === "llm" && data.llm) {
          lines.push(`Primary provider is ${data.llm.primary}; fallback ${data.llm.fallback.join(", ") || "none"}.`);
        }
        if (tab === "channels" && data.channelCfg && data.ttsCfg) {
          lines.push(
            `Telegram ${data.channelCfg.telegram.enabled ? "on" : "off"}, Discord ${data.channelCfg.discord.enabled ? "on" : "off"}, TTS ${data.ttsCfg.enabled ? "on" : "off"} (${data.ttsCfg.provider}).`,
          );
        }
        if (tab === "integrations" && data.google) {
          lines.push(`Google: ${data.google.status.replace(/_/g, " ")}.`);
        }
        if (tab === "sidecar") {
          lines.push(
            `${data.sidecars.length} sidecar${data.sidecars.length === 1 ? "" : "s"} enrolled, ${data.stats.sidecarsConnected} connected.`,
          );
        }
        showToast(lines.join(" ") || "Nothing to report on this tab.", "ok");
        return true;
      }

      // ── LLM ──
      case "set_primary_llm": {
        const provider = String(args.provider).toLowerCase();
        if (!LLM_PROVIDERS.includes(provider as LLMProvider)) return false;
        setTab("llm");
        (async () => {
          const r = await data.setPrimaryLLM(provider as LLMProvider);
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "set_fallback_llm": {
        const fallbackArg = args.fallback ?? args.provider;
        const list = Array.isArray(fallbackArg)
          ? fallbackArg.map(String)
          : typeof fallbackArg === "string"
            ? fallbackArg.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
        if (list.length === 0) return false;
        setTab("llm");
        (async () => {
          const r = await data.setFallbackLLM(list);
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "set_model": {
        const provider = String(args.provider).toLowerCase();
        const model = String(args.model);
        if (!LLM_PROVIDERS.includes(provider as LLMProvider) || !model) return false;
        setTab("llm");
        (async () => {
          const r = await data.setLLMModel(provider as LLMProvider, model);
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "test_provider": {
        const provider = String(args.provider).toLowerCase();
        if (!LLM_PROVIDERS.includes(provider as LLMProvider)) return false;
        setTab("llm");
        (async () => {
          const r = await data.testProvider(provider as LLMProvider);
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }

      // ── Channels ──
      case "enable_telegram": {
        setTab("channels");
        (async () => {
          const r = await data.setTelegram({ enabled: true });
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "disable_telegram": {
        setTab("channels");
        (async () => {
          const r = await data.setTelegram({ enabled: false });
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "enable_discord": {
        setTab("channels");
        (async () => {
          const r = await data.setDiscord({ enabled: true });
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "disable_discord": {
        setTab("channels");
        (async () => {
          const r = await data.setDiscord({ enabled: false });
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "set_stt_provider": {
        const provider = String(args.provider).toLowerCase();
        if (!["openai", "groq", "sarvam", "local"].includes(provider)) return false;
        setTab("channels");
        (async () => {
          const r = await data.setSTTProvider(provider as any);
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "enable_tts": {
        setTab("channels");
        (async () => {
          const r = await data.setTTS({ enabled: true });
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "disable_tts": {
        setTab("channels");
        (async () => {
          const r = await data.setTTS({ enabled: false });
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "set_tts_provider": {
        const provider = String(args.provider).toLowerCase();
        if (!["edge", "elevenlabs", "sarvam"].includes(provider)) return false;
        setTab("channels");
        (async () => {
          const r = await data.setTTS({ provider: provider as any });
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "set_tts_voice": {
        const voice = String(args.voice);
        if (!voice) return false;
        setTab("channels");
        (async () => {
          const r = await data.setTTS({ voice });
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }

      // ── General ──
      case "set_heartbeat_interval": {
        const minutes = Number(args.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) return false;
        setTab("general");
        (async () => {
          const r = await data.setHeartbeatInterval(minutes);
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "set_heartbeat_aggressiveness": {
        const level = String(args.level).toLowerCase();
        if (!["passive", "moderate", "aggressive"].includes(level)) return false;
        setTab("general");
        (async () => {
          const r = await data.setHeartbeatAggressiveness(level as any);
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "restart_daemon": {
        (async () => {
          const r = await data.restartDaemon();
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }

      case "replay_onboarding": {
        // Voice path mirrors the General-tab debug button + the
        // ?onboarding=reset URL trigger — all three funnel through
        // resetOnboarding(), which clears the right localStorage keys
        // and reloads the page so the OnboardingGate (when it ships)
        // re-evaluates its initial state cleanly.
        const rawScope = String(args.scope ?? "all");
        const scope: OnboardingResetScope =
          rawScope === "setup" ||
          rawScope === "profile" ||
          rawScope === "tutorial" ||
          rawScope === "all"
            ? rawScope
            : "all";
        showToast("Replaying onboarding — reloading…", "ok");
        (async () => {
          try {
            await resetOnboarding(scope);
          } catch (err) {
            showToast(
              err instanceof Error ? err.message : "Reset failed",
              "warn",
            );
          }
        })();
        return true;
      }

      default:
        return false;
    }
  });

  // ── Stats ribbon ──
  const stats = data.stats;

  return (
    <div className={`v2-set v2-set--${mode}`}>
      {/* Stats ribbon */}
      <div className="v2-set__stats">
        <StatCard
          label="Providers"
          value={stats.providersWithKey}
          sub="with API key"
          tone={stats.providersWithKey > 0 ? "ok" : "neutral"}
        />
        <StatCard
          label="Channels"
          value={stats.channelsEnabled}
          sub="enabled"
          tone={stats.channelsEnabled > 0 ? "ok" : "neutral"}
        />
        <StatCard
          label="Sidecars"
          value={`${stats.sidecarsConnected}/${stats.sidecarsTotal}`}
          sub="connected"
          tone={stats.sidecarsConnected > 0 ? "ok" : "neutral"}
        />
        <StatCard
          label="Restart"
          value={stats.restartPending ? "Pending" : "Clean"}
          sub={stats.restartPending ? "save needs apply" : "all changes live"}
          tone={stats.restartPending ? "warn" : "ok"}
        />
      </div>

      {/* Restart banner — only when there's a pending restart-required change */}
      {stats.restartPending && (
        <div className="v2-set__banner" role="alert">
          <Icon icon={AlertCircle} size="sm" />
          <span>
            Some recent changes (channels, STT, integrations) only take effect after a daemon restart.
          </span>
          <button
            type="button"
            className="v2-set__banner-btn"
            onClick={async () => {
              if (!confirm("Restart Jarvis now? Your dashboard will reconnect after a few seconds.")) return;
              const r = await data.restartDaemon();
              showToast(r.message, r.ok ? "ok" : "warn");
            }}
          >
            Restart now
          </button>
          <button
            type="button"
            className="v2-set__banner-dismiss"
            onClick={() => data.setRestartPending(false)}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Tab bar */}
      <nav
        className="v2-set__tabs"
        role="tablist"
        aria-label="Settings sections"
        ref={tabsApi.tablistRef}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            data-active={tab === t.key}
            className="v2-set__tab"
            {...tabsApi.getTabProps(t.key)}
          >
            <Icon icon={t.icon} size="sm" />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {/* Tab body */}
      <div className="v2-set__body" {...tabsApi.getPanelProps()}>
        {data.loading && !data.llm ? (
          <div className="v2-set__empty">Loading settings…</div>
        ) : (
          <>
            {tab === "general" && <GeneralTab data={data} onToast={showToast} />}
            {tab === "profile" && <ProfileTab data={data} onToast={showToast} />}
            {tab === "llm" && <LLMTab data={data} onToast={showToast} />}
            {tab === "channels" && <ChannelsTab data={data} onToast={showToast} />}
            {tab === "voice" && <VoiceTab data={data} onToast={showToast} />}
            {tab === "integrations" && <IntegrationsTab data={data} onToast={showToast} />}
            {tab === "sidecar" && <SidecarTab data={data} onToast={showToast} />}
          </>
        )}
      </div>

      {toast && (
        <div className="v2-set__toast" role="status" aria-live="polite" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function SettingsRoom() {
  return (
    <RoomShell title="Settings" subtitle="providers · channels · integrations · sidecar" breadcrumb={["Settings"]}>
      <SettingsRoomBody mode="expanded" />
    </RoomShell>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone?: "neutral" | "ok" | "warn" | "accent";
}) {
  return (
    <div className="v2-set__stat" data-tone={tone ?? "neutral"}>
      <div className="v2-set__stat-label">{label}</div>
      <div className="v2-set__stat-value">{value}</div>
      <div className="v2-set__stat-sub">{sub}</div>
    </div>
  );
}

// silence unused-import lints
void Chip;
