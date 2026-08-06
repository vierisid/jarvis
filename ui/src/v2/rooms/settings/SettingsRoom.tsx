import React, { useCallback, useEffect, useState } from "react";
import {
  Bot,
  Cable,
  Cog,
  CreditCard,
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
import { useLiveData } from "../../shell/LiveDataContext";
import { useSettingsData } from "./useSettingsData";
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
import { BillingTab } from "./tabs/BillingTab";
import "./SettingsRoom.css";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/translations";

export type SettingsTab =
  | "general"
  | "profile"
  | "llm"
  | "channels"
  | "voice"
  | "integrations"
  | "billing"
  | "sidecar";

const TABS: ReadonlyArray<{ key: SettingsTab; labelKey: MessageKey; icon: LucideIcon }> = [
  { key: "general", labelKey: "settings.general", icon: Cog },
  { key: "profile", labelKey: "settings.profile", icon: UserCircle2 },
  { key: "llm", labelKey: "settings.llm", icon: Bot },
  { key: "channels", labelKey: "settings.channels", icon: MessagesSquare },
  { key: "voice", labelKey: "settings.voice", icon: Mic },
  { key: "integrations", labelKey: "settings.integrations", icon: Cable },
  { key: "billing", labelKey: "settings.billing", icon: CreditCard },
  { key: "sidecar", labelKey: "settings.sidecar", icon: Server },
];

const VALID_TABS = new Set<SettingsTab>(TABS.map((t) => t.key));

export type RoomBodyMode = "inline" | "expanded";

const TAB_KEYS = TABS.map((t) => t.key) as ReadonlyArray<SettingsTab>;

export function SettingsRoomBody({ mode }: { mode: RoomBodyMode }) {
  const { t } = useI18n();
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

  // ── Settings hot-apply results (daemon `settings_applied` broadcast) ──
  // Applies can finish AFTER a save request returned (debounced channel
  // restarts, SIGHUP / POST /api/config/reload): surface those outcomes
  // here — failures as a toast, and always refetch so the tabs show the
  // actually-applied state.
  const { settingsEvents } = useLiveData();
  const lastApplied = settingsEvents.length > 0 ? settingsEvents[settingsEvents.length - 1]! : null;
  useEffect(() => {
    if (!lastApplied) return;
    if (!lastApplied.ok) {
      const detail = (lastApplied.errors ?? [])
        .map((e) => `${e.section}: ${e.error}`)
        .join("; ");
      showToast(t("settings.applyFailed", { detail: detail || lastApplied.sections.join(", ") }), "warn");
    }
    data.refresh();
    // Keyed on the event object: useWebSocket appends a new array entry per
    // broadcast, so this fires exactly once per apply batch.
  }, [lastApplied]); // eslint-disable-line react-hooks/exhaustive-deps

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
            t("settings.status.onPlatform", {
              status: t(data.autostart.installed ? "settings.status.serviceInstalled" : "settings.status.serviceNotInstalled"),
              platform: data.autostart.platform,
              manager: data.autostart.manager,
            }),
          );
        }
        if (tab === "llm" && data.llm) {
          const names = Object.keys(data.llm.providers);
          const desc = names.length === 0
            ? t("settings.status.noProviders")
            : t(names.length === 1 ? "settings.status.oneProvider" : "settings.status.manyProviders", {
                count: names.length,
                names: names.join(", "),
              });
          const model = data.llm.default
            ? t("settings.status.defaultModel", { model: data.llm.default })
            : data.llm.tiers.conversation
              ? t("settings.status.routerFirst")
              : t("settings.status.noModel");
          lines.push(`${desc}. ${model}`);
        }
        if (tab === "channels" && data.channelCfg && data.ttsCfg) {
          lines.push(
            t("settings.status.channelSummary", {
              telegram: t(data.channelCfg.telegram.enabled ? "settings.status.on" : "settings.status.off"),
              discord: t(data.channelCfg.discord.enabled ? "settings.status.on" : "settings.status.off"),
              tts: t(data.ttsCfg.enabled ? "settings.status.on" : "settings.status.off"),
              provider: data.ttsCfg.provider,
            }),
          );
        }
        if (tab === "integrations" && data.google) {
          lines.push(t("settings.status.google", { status: data.google.status.replace(/_/g, " ") }));
        }
        if (tab === "sidecar") {
          lines.push(
            t(data.sidecars.length === 1 ? "settings.status.oneSidecar" : "settings.status.manySidecars", {
              count: data.sidecars.length,
              connected: data.stats.sidecarsConnected,
            }),
          );
        }
        showToast(lines.join(" ") || t("settings.status.nothing"), "ok");
        return true;
      }

      // ── LLM ──
      // Voice room-actions for the LLM panel were tied to the legacy
      // primary/fallback/model triplet. After the provider/model split,
      // the equivalent is a `provider:model` ref. We surface a single
      // "set the default model" action for voice; advanced per-tier
      // configuration stays UI-only since it's rarely voice-driven.
      case "set_default_model":
      case "set_model": {
        const ref = args.ref
          ? String(args.ref)
          : args.provider && args.model
            ? `${args.provider}:${args.model}`
            : "";
        if (!ref || !ref.includes(":")) return false;
        setTab("llm");
        (async () => {
          const r = await data.setDefaultModel(ref);
          showToast(r.message, r.ok ? "ok" : "warn");
        })();
        return true;
      }
      case "test_provider": {
        const name = String(args.provider ?? args.name ?? "").trim();
        if (!name) return false;
        setTab("llm");
        (async () => {
          const r = await data.testProvider(name);
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
        showToast(t("settings.replaying"), "ok");
        (async () => {
          try {
            await resetOnboarding(scope);
          } catch (err) {
            showToast(
              err instanceof Error ? err.message : t("settings.resetFailed"),
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
          label={t("settings.stats.providers")}
          value={stats.providersWithKey}
          sub={t("settings.stats.withApiKey")}
          tone={stats.providersWithKey > 0 ? "ok" : "neutral"}
        />
        <StatCard
          label={t("settings.stats.channels")}
          value={stats.channelsEnabled}
          sub={t("settings.stats.enabled")}
          tone={stats.channelsEnabled > 0 ? "ok" : "neutral"}
        />
        <StatCard
          label={t("settings.stats.sidecars")}
          value={`${stats.sidecarsConnected}/${stats.sidecarsTotal}`}
          sub={t("settings.stats.connected")}
          tone={stats.sidecarsConnected > 0 ? "ok" : "neutral"}
        />
        <StatCard
          label={t("settings.stats.changes")}
          value={lastApplied ? t(lastApplied.ok ? "settings.stats.applied" : "settings.stats.failed") : t("settings.stats.live")}
          sub={
            lastApplied
              ? t("settings.stats.last", { sections: lastApplied.sections.join(", ") })
              : t("settings.stats.hotApplied")
          }
          tone={lastApplied && !lastApplied.ok ? "warn" : "ok"}
        />
      </div>

      {/* Tab bar */}
      <nav
        className="v2-set__tabs"
        role="tablist"
        aria-label={t("settings.sections")}
        ref={tabsApi.tablistRef}
      >
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            data-active={tab === item.key}
            className="v2-set__tab"
            {...tabsApi.getTabProps(item.key)}
          >
            <Icon icon={item.icon} size="sm" />
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </nav>

      {/* Tab body */}
      <div className="v2-set__body" {...tabsApi.getPanelProps()}>
        {data.loading && !data.llm ? (
          <div className="v2-set__empty">{t("settings.loading")}</div>
        ) : (
          <>
            {tab === "general" && <GeneralTab data={data} onToast={showToast} />}
            {tab === "profile" && <ProfileTab data={data} onToast={showToast} />}
            {tab === "llm" && <LLMTab data={data} onToast={showToast} />}
            {tab === "channels" && <ChannelsTab data={data} onToast={showToast} />}
            {tab === "voice" && <VoiceTab data={data} onToast={showToast} />}
            {tab === "integrations" && <IntegrationsTab data={data} onToast={showToast} />}
            {tab === "billing" && <BillingTab data={data} onToast={showToast} />}
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
  const { t } = useI18n();
  return (
    <RoomShell title={t("room.settings")} subtitle={t("settings.subtitle")} breadcrumb={[t("room.settings")]}>
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
