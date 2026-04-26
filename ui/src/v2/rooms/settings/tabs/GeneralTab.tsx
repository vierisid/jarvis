import React, { useState } from "react";
import type { SettingsHook } from "../useSettingsData";

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
            {role.role.sub_roles.length > 0 && (
              <div className="v2-set__field">
                <span className="v2-set__field-label">
                  Available specialists ({role.role.sub_roles.length})
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
                  {role.role.sub_roles.map((sr) => (
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
    </div>
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
