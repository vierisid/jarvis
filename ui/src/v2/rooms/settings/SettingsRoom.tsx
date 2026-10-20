import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { useSettingsData, type ActionResult } from "./useSettingsData";
import {
  reloadAfterOnboardingReset,
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
import { useBilling } from "../../billing/useBilling";
import { billingTabVisible } from "../../billing/billing-view";
import { SETTINGS_TAB_EVENT, takeRequestedSettingsTab, settingsTabFromHref, clearRequestedSettingsTab } from "../../shell/settings-tab-request";
import { isRoomTab, ROOM_TABS, type RoomTab } from "../../../../../src/daemon/room-tabs";
import { withRoomActionDefaults } from "../../../../../src/daemon/room-action-targets";
import "./SettingsRoom.css";

export type SettingsTab = RoomTab<"settings">;

// Keyed by every tab in ROOM_TABS.settings, so a tab added there without a
// label and icon here does not type-check (#933).
const TAB_META: Record<SettingsTab, { label: string; icon: LucideIcon }> = {
  general: { label: "General", icon: Cog },
  profile: { label: "Profile", icon: UserCircle2 },
  llm: { label: "LLM", icon: Bot },
  channels: { label: "Channels", icon: MessagesSquare },
  voice: { label: "Voice", icon: Mic },
  integrations: { label: "Integrations", icon: Cable },
  billing: { label: "Billing", icon: CreditCard },
  sidecar: { label: "Sidecar", icon: Server },
};

const TABS: ReadonlyArray<{ key: SettingsTab; label: string; icon: LucideIcon }> =
  ROOM_TABS.settings.map((key) => ({ key, ...TAB_META[key] }));

const VALID_TABS = new Set<SettingsTab>(TABS.map((t) => t.key));

export type RoomBodyMode = "inline" | "expanded";

export function SettingsRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useSettingsData();
  // Opened on a tab from outside the room (the sidecar update hint), or on
  // General.
  const [tab, setTab] = useState<SettingsTab>(() => takeRequestedSettingsTab() ?? "general");
  useEffect(() => {
    const onRequest = (e: Event) => {
      const t = (e as CustomEvent<SettingsTab>).detail;
      if (VALID_TABS.has(t)) {
        // Inline observers must leave it for the destination mount. An expanded
        // destination has already received it and must not leak it to a later room.
        if (mode === "expanded") clearRequestedSettingsTab();
        setTab(t);
      }
    };
    const onLocation = () => {
      const t = settingsTabFromHref(window.location.href);
      if (t) setTab(t);
    };
    window.addEventListener(SETTINGS_TAB_EVENT, onRequest);
    window.addEventListener("popstate", onLocation);
    window.addEventListener("hashchange", onLocation);
    return () => {
      window.removeEventListener(SETTINGS_TAB_EVENT, onRequest);
      window.removeEventListener("popstate", onLocation);
      window.removeEventListener("hashchange", onLocation);
    };
  }, [mode]);
  // A retained-control link names its tab in the query. Keep it in step with
  // the selected tab, or a later remount or reload jumps back to the old one.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!settingsTabFromHref(url.href) || url.searchParams.get("settingsTab") === tab) return;
    url.searchParams.set("settingsTab", tab);
    window.history.replaceState(window.history.state, "", url);
  }, [tab]);
  // A self-hosted install has no bill, so it gets no Billing tab. Same shared
  // store as the shell banner, and refreshOnMount: false so opening Settings
  // does not itself trigger a read; see billingTabVisible for why the tab stays
  // while the answer is not known yet.
  const showBilling = billingTabVisible(useBilling({ refreshOnMount: false }).state);
  const visibleTabs = useMemo(
    () => (showBilling ? TABS : TABS.filter((t) => t.key !== "billing")),
    [showBilling],
  );
  const visibleKeys = useMemo(() => visibleTabs.map((t) => t.key), [visibleTabs]);
  const tabsApi = useRovingTabs<SettingsTab>(visibleKeys, tab, setTab, "v2-set");
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  const showToast = useCallback((text: string, tone: "ok" | "warn" = "ok") => {
    setToast({ text, tone });
  }, []);

  // Sitting on Billing when the install turns out to be self-hosted (possible
  // only before the first read lands): move off a tab that no longer exists,
  // and say why, so the jump is not a mystery.
  useEffect(() => {
    if (showBilling || tab !== "billing") return;
    setTab("general");
    showToast("This Jarvis is self-hosted, so there's no billing to show.", "ok");
  }, [showBilling, tab, showToast]);

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
      showToast(`Applying settings failed — ${detail || lastApplied.sections.join(", ")}`, "warn");
    }
    data.refresh();
    // Keyed on the event object: useWebSocket appends a new array entry per
    // broadcast, so this fires exactly once per apply batch.
  }, [lastApplied]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Voice room actions ──
  // A side-effecting action is answered once its request has settled, with
  // whether it worked (#1015): it used to answer yes as the request went out,
  // so a failed save, or a heartbeat write the daemon has no endpoint for,
  // was confirmed by voice.
  const answerFrom = (work: Promise<ActionResult>): Promise<boolean> =>
    work.then((r) => {
      showToast(r.message, r.ok ? "ok" : "warn");
      return r.ok;
    });

  useRoomActions("settings", (action, args) => {
    switch (action) {
      case "switch_tab": {
        const t = args.tab;
        if (isRoomTab("settings", t) && (showBilling || t !== "billing")) {
          setTab(t);
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
          const names = Object.keys(data.llm.providers);
          const desc = names.length === 0
            ? "no providers configured"
            : `${names.length} provider${names.length === 1 ? "" : "s"} configured (${names.join(", ")})`;
          const model = data.llm.default
            ? `Default model: ${data.llm.default}.`
            : data.llm.tiers.conversation
              ? "Router-first mode (per-tier models configured)."
              : "No model selected.";
          lines.push(`${desc}. ${model}`);
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
        return answerFrom(data.setDefaultModel(ref));
      }
      case "test_provider": {
        const name = String(args.provider ?? args.name ?? "").trim();
        if (!name) return false;
        setTab("llm");
        return answerFrom(data.testProvider(name));
      }

      // ── Channels ──
      case "enable_telegram": {
        setTab("channels");
        return answerFrom(data.setTelegram({ enabled: true }));
      }
      case "disable_telegram": {
        setTab("channels");
        return answerFrom(data.setTelegram({ enabled: false }));
      }
      case "enable_discord": {
        setTab("channels");
        return answerFrom(data.setDiscord({ enabled: true }));
      }
      case "disable_discord": {
        setTab("channels");
        return answerFrom(data.setDiscord({ enabled: false }));
      }
      case "set_stt_provider": {
        const provider = String(args.provider).toLowerCase();
        if (!["openai", "groq", "sarvam", "local", "usejarvis"].includes(provider)) return false;
        setTab("channels");
        return answerFrom(data.setSTTProvider(provider as any));
      }
      case "enable_tts": {
        setTab("channels");
        return answerFrom(data.setTTS({ enabled: true }));
      }
      case "disable_tts": {
        setTab("channels");
        return answerFrom(data.setTTS({ enabled: false }));
      }
      case "set_tts_provider": {
        const provider = String(args.provider).toLowerCase();
        if (!["edge", "elevenlabs", "sarvam"].includes(provider)) return false;
        setTab("channels");
        return answerFrom(data.setTTS({ provider: provider as any }));
      }
      case "set_tts_voice": {
        // Not String(args.voice): a voice left out became the voice
        // "undefined", which no card showed (#1008).
        const voice = typeof args.voice === "string" ? args.voice.trim() : "";
        if (!voice) return false;
        setTab("channels");
        return answerFrom(data.setTTS({ voice }));
      }

      // ── General ──
      case "set_heartbeat_interval": {
        const minutes = Number(args.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) return false;
        setTab("general");
        return answerFrom(data.setHeartbeatInterval(minutes));
      }
      case "set_heartbeat_aggressiveness": {
        const level = String(args.level).toLowerCase();
        if (!["passive", "moderate", "aggressive"].includes(level)) return false;
        setTab("general");
        return answerFrom(data.setHeartbeatAggressiveness(level as any));
      }
      case "restart_daemon": {
        // Answered from the route, so a restart it refuses (no keepalive
        // service installed) is a no (#1015). The restart itself comes a
        // moment after the route answers: on Linux from a systemd timer
        // 2s out (#1037), on macOS from launchctl 1s out. A spoken answer
        // longer than that can still be cut off by the restart.
        return answerFrom(data.restartDaemon());
      }

      case "replay_onboarding": {
        // Voice path mirrors the General-tab debug button + the
        // ?onboarding=reset URL trigger — all three funnel through
        // resetOnboarding(), which clears the right localStorage keys
        // and reloads the page so the OnboardingGate (when it ships)
        // re-evaluates its initial state cleanly.
        // No scope, or one it does not know, is "all", which clears the
        // user profile; the daemon shows that on the card before a held
        // voice action runs, from the same defaults (#1008).
        const scope = withRoomActionDefaults("settings", "replay_onboarding", args).scope as OnboardingResetScope;
        showToast("Replaying onboarding — reloading…", "ok");
        // Answered before the page reloads (#1015): the reload closes the
        // socket the answer goes back on. The answer is sent as this
        // promise settles, a microtask, so the reload waits a task.
        return resetOnboarding(scope, { reload: false }).then(
          () => {
            window.setTimeout(reloadAfterOnboardingReset, 0);
            return true;
          },
          (err: unknown) => {
            showToast(err instanceof Error ? err.message : "Reset failed", "warn");
            return false;
          },
        );
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
          label="Changes"
          value={lastApplied ? (lastApplied.ok ? "Applied" : "Failed") : "Live"}
          sub={
            lastApplied
              ? `last: ${lastApplied.sections.join(", ")}`
              : "settings hot-applied"
          }
          tone={lastApplied && !lastApplied.ok ? "warn" : "ok"}
        />
      </div>

      {/* Tab bar */}
      <nav
        className="v2-set__tabs"
        role="tablist"
        aria-label="Settings sections"
        ref={tabsApi.tablistRef}
      >
        {visibleTabs.map((t) => (
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
            {tab === "billing" && showBilling && <BillingTab data={data} onToast={showToast} />}
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
