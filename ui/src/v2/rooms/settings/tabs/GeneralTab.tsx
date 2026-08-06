import React, { useState } from "react";
import type { SettingsHook } from "../useSettingsData";
import type { JarvisLanguage } from "../useSettingsData";
import { confirmDialog } from "../../../ui/ConfirmDialog";
import {
  resetOnboarding,
  type OnboardingResetScope,
} from "../../../onboarding/resetClient";
import { useI18n } from "../../../i18n/I18nProvider";
import type { MessageKey } from "../../../i18n/translations";

const HEARTBEAT_LEVELS = ["passive", "moderate", "aggressive"] as const;
const HEARTBEAT_LABEL_KEYS: Record<string, MessageKey> = {
  passive: "settings.general.passive",
  moderate: "settings.general.moderate",
  aggressive: "settings.general.aggressive",
} as const;
const RESPONSE_LANGUAGES: ReadonlyArray<{ id: JarvisLanguage; label: string }> = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];

export function GeneralTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const { autostart, rootCfg, personality, role } = data;
  const { locale, setLocale, t } = useI18n();
  const [restarting, setRestarting] = useState(false);

  const handleRestart = async () => {
    if (!await confirmDialog(t("settings.general.restartConfirm"))) return;
    setRestarting(true);
    const r = await data.restartDaemon();
    onToast(r.message, r.ok ? "ok" : "warn");
    setRestarting(false);
  };

  return (
    <div>
      {/* Response language */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">{t("settings.languageTitle")}</h3>
            <div className="v2-set__section-sub">
              {t("settings.languageDescription")}
            </div>
          </div>
          <span className="v2-set__chip">
            {rootCfg?.user?.language === "es" ? "Español" : "English"}
          </span>
        </div>
        <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
          {RESPONSE_LANGUAGES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`v2-set__btn ${(rootCfg?.user?.language ?? "en") === option.id ? "v2-set__btn--primary" : ""}`}
              data-active={(rootCfg?.user?.language ?? "en") === option.id}
              aria-pressed={(rootCfg?.user?.language ?? "en") === option.id}
              onClick={async () => {
                const r = await data.setResponseLanguage(option.id);
                if (r.ok) setLocale(option.id);
                onToast(r.message, r.ok ? "ok" : "warn");
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="v2-set__hint">
          {t("settings.languageHint")}
        </p>
      </section>

      {/* Service / Restart */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">{t("settings.general.serviceTitle")}</h3>
            <div className="v2-set__section-sub">
              {t("settings.general.serviceDescription")}
            </div>
          </div>
          {autostart && (
            <span
              className={
                "v2-set__chip " + (autostart.installed ? "v2-set__chip--ok" : "")
              }
            >
              {t(autostart.installed ? "settings.general.installed" : "settings.general.notInstalled")}
            </span>
          )}
        </div>

        {autostart ? (
          <>
            <div className="v2-set__row">
              <span className="v2-set__row-label">{t("settings.general.manager")}</span>
              <span className="v2-set__row-value">{autostart.manager}</span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">{t("settings.general.platform")}</span>
              <span className="v2-set__row-value">{autostart.platform}</span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">{t("settings.general.restart")}</span>
              <span className="v2-set__row-value">
                {autostart.restart_supported
                  ? t("settings.general.available")
                  : autostart.keepalive_supported
                    ? t("settings.general.installKeepalive")
                    : t("settings.general.notSupported")}
              </span>
            </div>
            <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                disabled={!autostart.restart_supported || restarting}
                onClick={handleRestart}
              >
                {restarting ? t("settings.general.restarting") : t("settings.general.restartJarvis")}
              </button>
              <button
                type="button"
                className="v2-set__btn"
                onClick={() => data.refresh()}
              >
                {t("settings.general.refreshStatus")}
              </button>
            </div>
          </>
        ) : (
          <div className="v2-set__empty">{t("settings.general.serviceUnavailable")}</div>
        )}
      </section>

      {/* Heartbeat */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">{t("settings.general.heartbeat")}</h3>
            <div className="v2-set__section-sub">
              {t("settings.general.heartbeatDescription")}
            </div>
          </div>
        </div>

        {rootCfg?.heartbeat ? (
          <>
            <div className="v2-set__row">
              <span className="v2-set__row-label">{t("settings.general.interval")}</span>
              <span className="v2-set__row-value">
                {rootCfg.heartbeat.interval_minutes} min
              </span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">{t("settings.general.activeHours")}</span>
              <span className="v2-set__row-value">
                {rootCfg.heartbeat.active_hours.start}:00 –{" "}
                {rootCfg.heartbeat.active_hours.end}:00
              </span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">{t("settings.general.aggressiveness")}</span>
              <span className="v2-set__row-value" style={{ textTransform: "capitalize" }}>
                {t(HEARTBEAT_LABEL_KEYS[rootCfg.heartbeat.aggressiveness] ?? "settings.general.moderate")}
              </span>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">{t("settings.general.setAggressiveness")}</label>
              <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
                {HEARTBEAT_LEVELS.map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    className="v2-set__btn"
                    data-active={rootCfg.heartbeat?.aggressiveness === lv}
                    onClick={async () => {
                      const r = await data.setHeartbeatAggressiveness(lv);
                      onToast(r.message, r.ok ? "ok" : "warn");
                    }}
                  >
                    {t(HEARTBEAT_LABEL_KEYS[lv]!)}
                  </button>
                ))}
              </div>
              <p className="v2-set__hint">
                {t("settings.general.heartbeatWriteNote")}
              </p>
            </div>
          </>
        ) : (
          <div className="v2-set__empty">{t("settings.general.noHeartbeat")}</div>
        )}
      </section>

      {/* Personality (read-only) */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">{t("settings.general.personality")}</h3>
            <div className="v2-set__section-sub">
              {t("settings.general.personalityDescription")}
            </div>
          </div>
        </div>

        {personality ? (
          <>
            <div className="v2-set__field">
              <span className="v2-set__field-label">{t("settings.general.coreTraits")}</span>
              <div className="v2-set__chip-row">
                {personality.core_traits.map((t) => (
                  <span key={t} className="v2-set__chip">
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div className="v2-set__field">
              <span className="v2-set__field-label">{t("settings.general.learnedPreferences")}</span>
              <PrefBar label={t("settings.general.verbosity")} value={personality.learned_preferences.verbosity} />
              <PrefBar label={t("settings.general.formality")} value={personality.learned_preferences.formality} />
              <PrefBar label={t("settings.general.humor")} value={personality.learned_preferences.humor_level} />
              <div className="v2-set__row">
                <span className="v2-set__row-label">{t("settings.general.emojiUsage")}</span>
                <span className="v2-set__row-value">
                  {t(personality.learned_preferences.emoji_usage ? "settings.general.enabled" : "settings.general.disabled")}
                </span>
              </div>
              <div className="v2-set__row">
                <span className="v2-set__row-label">{t("settings.general.preferredFormat")}</span>
                <span className="v2-set__row-value" style={{ textTransform: "capitalize" }}>
                  {personality.learned_preferences.preferred_format}
                </span>
              </div>
            </div>
            <div className="v2-set__field">
              <span className="v2-set__field-label">{t("settings.general.relationship")}</span>
              <div className="v2-set__row">
                <span className="v2-set__row-label">{t("settings.general.messagesExchanged")}</span>
                <span className="v2-set__row-value">
                  {personality.relationship.message_count}
                </span>
              </div>
              <PrefBar label={t("settings.general.trustLevel")} value={personality.relationship.trust_level} />
              <div className="v2-set__row">
                <span className="v2-set__row-label">{t("settings.general.firstInteraction")}</span>
                <span className="v2-set__row-value">
                  {new Date(personality.relationship.first_interaction).toLocaleDateString(locale)}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="v2-set__empty">{t("settings.general.personalityUnavailable")}</div>
        )}
      </section>

      {/* Active role (read-only) */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">{t("settings.general.activeRole")}</h3>
            <div className="v2-set__section-sub">
              {t("settings.general.roleDescription")}
            </div>
          </div>
        </div>
        {role?.role ? (
          <>
            <div className="v2-set__row">
              <span className="v2-set__row-label">{t("settings.general.role")}</span>
              <span className="v2-set__row-value">{role.role.name}</span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">{t("settings.general.authority")}</span>
              <span className="v2-set__row-value">{role.role.authority_level}/10</span>
            </div>
            <div className="v2-set__field">
              <span className="v2-set__field-label">{t("settings.general.tools")}</span>
              <div className="v2-set__chip-row">
                {role.role.tools.map((t) => (
                  <span key={t} className="v2-set__chip">
                    {t}
                  </span>
                ))}
              </div>
            </div>
            {(role.role.sub_roles?.length ?? 0) > 0 && (
              <div className="v2-set__field">
                <span className="v2-set__field-label">
                  {t("settings.general.specialists", { count: role.role.sub_roles?.length ?? 0 })}
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
                  {(role.role.sub_roles ?? []).map((sr) => (
                    <div
                      key={sr.role_id}
                      style={{
                        padding: "var(--s-2) var(--s-3)",
                        background: "var(--paper)",
                        border: "1px solid var(--rule-soft)",
                        borderRadius: "var(--r-1)",
                      }}
                    >
                      <div style={{ fontSize: "var(--text-sm)", color: "var(--ink)" }}>
                        {sr.name}
                      </div>
                      <div
                        style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)", marginTop: 2 }}
                      >
                        {sr.description}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="v2-set__empty">{t("settings.general.roleUnavailable")}</div>
        )}
      </section>

      <RerunSetupSection onToast={onToast} />

      <OnboardingDebugSection onToast={onToast} />
    </div>
  );
}

/**
 * Phase E — quick-access shortcut for "Re-run first-time setup" so users
 * who want to switch LLM provider don't have to dig into the debug
 * dropdown. The debug section below still exposes the full scope picker
 * for everything else (profile / tutorial / all).
 */
function RerunSetupSection({
  onToast,
}: {
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const handleRerun = async () => {
    if (
      !await confirmDialog(
        t("settings.general.rerunConfirm"),
      )
    )
      return;
    setBusy(true);
    try {
      await resetOnboarding("setup");
      onToast(t("settings.general.rerunToast"), "ok");
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), "warn");
      setBusy(false);
    }
  };

  return (
    <section className="v2-set__section">
      <div className="v2-set__section-head">
        <div>
          <h3 className="v2-set__section-title">{t("settings.general.rerunTitle")}</h3>
          <div className="v2-set__section-sub">
            {t("settings.general.rerunDescription")}
          </div>
        </div>
        <button
          type="button"
          className="v2-set__btn"
          onClick={handleRerun}
          disabled={busy}
        >
          {busy ? t("settings.general.restarting") : t("settings.general.rerunButton")}
        </button>
      </div>
    </section>
  );
}

function PrefBar({ label, value, max = 10 }: { label: string; value: number; max?: number }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div>
      <div className="v2-set__row">
        <span className="v2-set__row-label">{label}</span>
        <span className="v2-set__row-value">
          {value}/{max}
        </span>
      </div>
      <div className="v2-set__pers-bar">
        <div className="v2-set__pers-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Onboarding reset section (Phase A — reset gate). Lets the user (or a
 * developer rehearsing a fresh-install run) replay any phase of the
 * onboarding flow without nuking `~/.jarvis/`. The same reset is also
 * reachable via voice ("replay onboarding") and via the URL trigger
 * `?onboarding=reset[&scope=...]` — see `resetClient.ts`.
 */
function OnboardingDebugSection({
  onToast,
}: {
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<OnboardingResetScope | "">("");
  const [busy, setBusy] = useState(false);

  const handleReset = async () => {
    if (!scope) return;
    const label =
      scope === "all"
        ? t("settings.general.scopeAll")
        : scope === "setup"
          ? t("settings.general.scopeSetup")
          : scope === "profile"
            ? t("settings.general.scopeProfile")
            : t("settings.general.scopeTutorial");
    if (!await confirmDialog(t("settings.general.replayConfirm", { scope: label }))) return;
    setBusy(true);
    try {
      // resetOnboarding triggers a full page reload on success, so the
      // toast below only fires if reload is somehow skipped (e.g. test
      // harness).
      await resetOnboarding(scope);
      onToast(t("settings.general.resetQueued"), "ok");
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), "warn");
      setBusy(false);
    }
  };

  return (
    <section className="v2-set__section">
      <div className="v2-set__section-head">
        <div>
          <h3 className="v2-set__section-title">{t("settings.general.onboarding")}</h3>
          <div className="v2-set__section-sub">
            {t("settings.general.onboardingDescription")}
          </div>
        </div>
      </div>

      <div className="v2-set__field">
        <label className="v2-set__field-label" htmlFor="onboarding-scope">
          {t("settings.general.replayScope")}
        </label>
        <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <select
            id="onboarding-scope"
            className="v2-set__select"
            value={scope}
            onChange={(e) => setScope(e.target.value as OnboardingResetScope | "")}
            style={{ flex: 1 }}
          >
            <option value="">{t("settings.general.pickPhase")}</option>
            <option value="all">{t("settings.general.allPhases")}</option>
            <option value="setup">{t("settings.general.setupOnly")}</option>
            <option value="profile">{t("settings.general.profileInterview")}</option>
            <option value="tutorial">{t("settings.general.dashboardTutorial")}</option>
          </select>
          <button
            type="button"
            className="v2-set__btn v2-set__btn--danger"
            onClick={handleReset}
            disabled={!scope || busy}
          >
            {busy ? t("settings.general.resetting") : t("settings.general.replay")}
          </button>
        </div>
        <p className="v2-set__hint">
          {t("settings.general.onboardingHintBefore")}{" "}
          <code className="v2-set__code">?onboarding=reset</code>
          {" "}{t("settings.general.onboardingHintAfter")}
        </p>
      </div>
    </section>
  );
}
