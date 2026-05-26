import React, { useState } from "react";
import type { SettingsHook } from "../useSettingsData";
import {
  resetOnboarding,
  type OnboardingResetScope,
} from "../../../onboarding/resetClient";

const HEARTBEAT_LEVELS = ["passive", "moderate", "aggressive"] as const;

export function GeneralTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const { autostart, rootCfg, personality, role } = data;
  const [restarting, setRestarting] = useState(false);

  const handleRestart = async () => {
    if (!confirm("Restart Jarvis now? Your dashboard will reconnect after a few seconds.")) return;
    setRestarting(true);
    const r = await data.restartDaemon();
    onToast(r.message, r.ok ? "ok" : "warn");
    setRestarting(false);
  };

  return (
    <div>
      {/* Service / Restart */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">24/7 Service</h3>
            <div className="v2-set__section-sub">
              Keepalive that runs Jarvis in the background after the terminal closes.
            </div>
          </div>
          {autostart && (
            <span
              className={
                "v2-set__chip " + (autostart.installed ? "v2-set__chip--ok" : "")
              }
            >
              {autostart.installed ? "Installed" : "Not installed"}
            </span>
          )}
        </div>

        {autostart ? (
          <>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Manager</span>
              <span className="v2-set__row-value">{autostart.manager}</span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Platform</span>
              <span className="v2-set__row-value">{autostart.platform}</span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Restart</span>
              <span className="v2-set__row-value">
                {autostart.restart_supported
                  ? "Available"
                  : autostart.keepalive_supported
                    ? "Install keepalive first"
                    : "Not supported"}
              </span>
            </div>
            <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                disabled={!autostart.restart_supported || restarting}
                onClick={handleRestart}
              >
                {restarting ? "Restarting…" : "Restart Jarvis"}
              </button>
              <button
                type="button"
                className="v2-set__btn"
                onClick={() => data.refresh()}
              >
                Refresh status
              </button>
            </div>
          </>
        ) : (
          <div className="v2-set__empty">Service controls unavailable.</div>
        )}
      </section>

      {/* Heartbeat */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Heartbeat</h3>
            <div className="v2-set__section-sub">
              How often Jarvis checks in with you proactively.
            </div>
          </div>
        </div>

        {rootCfg?.heartbeat ? (
          <>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Interval</span>
              <span className="v2-set__row-value">
                {rootCfg.heartbeat.interval_minutes} min
              </span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Active hours</span>
              <span className="v2-set__row-value">
                {rootCfg.heartbeat.active_hours.start}:00 –{" "}
                {rootCfg.heartbeat.active_hours.end}:00
              </span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Aggressiveness</span>
              <span className="v2-set__row-value" style={{ textTransform: "capitalize" }}>
                {rootCfg.heartbeat.aggressiveness}
              </span>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Set aggressiveness (write)</label>
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
                    {lv}
                  </button>
                ))}
              </div>
              <p className="v2-set__hint">
                Note: heartbeat write endpoint is not yet wired in the daemon — these buttons
                surface the capability for parity with voice actions but currently return a
                "not implemented" message.
              </p>
            </div>
          </>
        ) : (
          <div className="v2-set__empty">No heartbeat config loaded.</div>
        )}
      </section>

      {/* Personality (read-only) */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Personality</h3>
            <div className="v2-set__section-sub">
              Learned from interactions over time. Read-only.
            </div>
          </div>
        </div>

        {personality ? (
          <>
            <div className="v2-set__field">
              <span className="v2-set__field-label">Core traits</span>
              <div className="v2-set__chip-row">
                {personality.core_traits.map((t) => (
                  <span key={t} className="v2-set__chip">
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div className="v2-set__field">
              <span className="v2-set__field-label">Learned preferences</span>
              <PrefBar label="Verbosity" value={personality.learned_preferences.verbosity} />
              <PrefBar label="Formality" value={personality.learned_preferences.formality} />
              <PrefBar label="Humor" value={personality.learned_preferences.humor_level} />
              <div className="v2-set__row">
                <span className="v2-set__row-label">Emoji usage</span>
                <span className="v2-set__row-value">
                  {personality.learned_preferences.emoji_usage ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className="v2-set__row">
                <span className="v2-set__row-label">Preferred format</span>
                <span className="v2-set__row-value" style={{ textTransform: "capitalize" }}>
                  {personality.learned_preferences.preferred_format}
                </span>
              </div>
            </div>
            <div className="v2-set__field">
              <span className="v2-set__field-label">Relationship</span>
              <div className="v2-set__row">
                <span className="v2-set__row-label">Messages exchanged</span>
                <span className="v2-set__row-value">
                  {personality.relationship.message_count}
                </span>
              </div>
              <PrefBar label="Trust level" value={personality.relationship.trust_level} />
              <div className="v2-set__row">
                <span className="v2-set__row-label">First interaction</span>
                <span className="v2-set__row-value">
                  {new Date(personality.relationship.first_interaction).toLocaleDateString()}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="v2-set__empty">Personality data unavailable.</div>
        )}
      </section>

      {/* Active role (read-only) */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Active Role</h3>
            <div className="v2-set__section-sub">
              Authority and tools available to the orchestrator.
            </div>
          </div>
        </div>
        {role?.role ? (
          <>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Role</span>
              <span className="v2-set__row-value">{role.role.name}</span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Authority</span>
              <span className="v2-set__row-value">{role.role.authority_level}/10</span>
            </div>
            <div className="v2-set__field">
              <span className="v2-set__field-label">Tools</span>
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
                  Available specialists ({role.role.sub_roles?.length ?? 0})
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
          <div className="v2-set__empty">Role data unavailable.</div>
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
  const [busy, setBusy] = useState(false);

  const handleRerun = async () => {
    if (
      !confirm(
        "Re-run first-time setup? You'll be sent back to the LLM provider + TTS picker. Your saved profile and tutorial state are preserved. The page will reload.",
      )
    )
      return;
    setBusy(true);
    try {
      await resetOnboarding("setup");
      onToast("Re-running setup — reloading…", "ok");
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), "warn");
      setBusy(false);
    }
  };

  return (
    <section className="v2-set__section">
      <div className="v2-set__section-head">
        <div>
          <h3 className="v2-set__section-title">Re-run first-time setup</h3>
          <div className="v2-set__section-sub">
            Send yourself back through the LLM provider + TTS pickers — useful
            after switching providers or rotating an API key. Your profile and
            tutorial progress stay intact.
          </div>
        </div>
        <button
          type="button"
          className="v2-set__btn"
          onClick={handleRerun}
          disabled={busy}
        >
          {busy ? "Restarting…" : "Re-run setup"}
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
  const [scope, setScope] = useState<OnboardingResetScope | "">("");
  const [busy, setBusy] = useState(false);

  const handleReset = async () => {
    if (!scope) return;
    const label =
      scope === "all"
        ? "all onboarding phases"
        : scope === "setup"
          ? "the LLM/TTS setup screens"
          : scope === "profile"
            ? "the profile interview (your saved profile will be cleared)"
            : "the dashboard tutorial";
    if (!confirm(`Replay ${label}? The page will reload.`)) return;
    setBusy(true);
    try {
      // resetOnboarding triggers a full page reload on success, so the
      // toast below only fires if reload is somehow skipped (e.g. test
      // harness).
      await resetOnboarding(scope);
      onToast(`Reset queued — reloading…`, "ok");
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), "warn");
      setBusy(false);
    }
  };

  return (
    <section className="v2-set__section">
      <div className="v2-set__section-head">
        <div>
          <h3 className="v2-set__section-title">Onboarding</h3>
          <div className="v2-set__section-sub">
            Replay any phase of first-run onboarding. Useful after Jarvis
            updates or for testing. Page reloads after the reset fires.
          </div>
        </div>
      </div>

      <div className="v2-set__field">
        <label className="v2-set__field-label" htmlFor="onboarding-scope">
          Replay scope
        </label>
        <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <select
            id="onboarding-scope"
            className="v2-set__select"
            value={scope}
            onChange={(e) => setScope(e.target.value as OnboardingResetScope | "")}
            style={{ flex: 1 }}
          >
            <option value="">Pick a phase…</option>
            <option value="all">All phases (full reset)</option>
            <option value="setup">Setup only (LLM + TTS picker)</option>
            <option value="profile">Profile interview (clears your saved profile)</option>
            <option value="tutorial">Dashboard tutorial</option>
          </select>
          <button
            type="button"
            className="v2-set__btn v2-set__btn--danger"
            onClick={handleReset}
            disabled={!scope || busy}
          >
            {busy ? "Resetting…" : "Replay"}
          </button>
        </div>
        <p className="v2-set__hint">
          You can also visit{" "}
          <code className="v2-set__code">?onboarding=reset</code> on the
          dashboard URL, or say <strong>"replay onboarding"</strong> by voice.
        </p>
      </div>
    </section>
  );
}
