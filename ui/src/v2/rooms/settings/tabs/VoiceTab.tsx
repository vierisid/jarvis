import React, { useState } from "react";
import type { RealtimeReasoningEffort, SettingsHook } from "../useSettingsData";
import { Chip } from "../../../ui";

/** OpenAI realtime voices (gpt-realtime-2). */
const REALTIME_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "sage", "shimmer", "verse"];

const REASONING_EFFORTS: ReadonlyArray<{ id: RealtimeReasoningEffort; label: string }> = [
  { id: "minimal", label: "Minimal — fastest, least deliberate" },
  { id: "low", label: "Low — default, low latency" },
  { id: "medium", label: "Medium — balanced" },
  { id: "high", label: "High — more deliberate" },
  { id: "xhigh", label: "X-High — most deliberate, highest latency/cost" },
];

export function VoiceTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const voice = data.voiceCfg;
  const rt = voice?.realtime;
  const [apiKey, setApiKey] = useState("");

  const statusChip = !rt?.enabled
    ? { label: "Off", tone: undefined }
    : rt.available
      ? { label: "Active", tone: "ok" as const }
      : { label: "No API key", tone: "warn" as const };

  return (
    <div className="v2-set__tabpane">
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Premium Realtime Voice</h3>
            <div className="v2-set__section-sub">
              Speech-to-speech via OpenAI&apos;s gpt-realtime-2 — lower latency, natural
              turn-taking, reasons mid-conversation. Bring your own OpenAI key; you are billed
              by OpenAI (~$0.30/min). Off by default; the standard voice pipeline is unaffected.
            </div>
          </div>
          <Chip tone={statusChip.tone}>{statusChip.label}</Chip>
        </div>

        <label className="v2-set__toggle-row">
          <button
            type="button"
            className="v2-set__toggle"
            data-checked={!!rt?.enabled}
            aria-checked={!!rt?.enabled}
            role="switch"
            onClick={async () => {
              const r = await data.setVoiceConfig({ realtime: { enabled: !rt?.enabled } });
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          />
          <span>Enable premium realtime voice</span>
        </label>

        {rt?.enabled && (
          <>
            {!rt.available && (
              <p className="v2-set__hint" data-tone="warn">
                Enabled, but no OpenAI key resolves yet. Add one below (or set the OpenAI provider
                key under the LLM tab). Until then JARVIS uses the standard voice pipeline.
              </p>
            )}

            {/* API key (BYO) */}
            <div className="v2-set__field">
              <label className="v2-set__field-label">OpenAI API key</label>
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <input
                  className="v2-set__input"
                  type="password"
                  placeholder="leave empty to keep existing / reuse LLM key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="v2-set__btn v2-set__btn--primary"
                  disabled={!apiKey}
                  onClick={async () => {
                    const r = await data.setVoiceConfig({ realtime: { api_key: apiKey } });
                    if (r.ok) setApiKey("");
                    onToast(r.message, r.ok ? "ok" : "warn");
                  }}
                >
                  Save key
                </button>
              </div>
              <p className="v2-set__hint">
                {rt.has_api_key
                  ? "A realtime-specific key is configured."
                  : "No realtime-specific key; falls back to the OpenAI LLM key or env."}
              </p>
            </div>

            {/* Voice */}
            <div className="v2-set__field">
              <label className="v2-set__field-label">Voice</label>
              <select
                className="v2-set__select"
                value={rt.voice ?? "marin"}
                onChange={async (e) => {
                  const r = await data.setVoiceConfig({ realtime: { voice: e.target.value } });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                {REALTIME_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>

            {/* Reasoning effort */}
            <div className="v2-set__field">
              <label className="v2-set__field-label">Reasoning effort</label>
              <select
                className="v2-set__select"
                value={rt.reasoning_effort ?? "low"}
                onChange={async (e) => {
                  const r = await data.setVoiceConfig({
                    realtime: { reasoning_effort: e.target.value as RealtimeReasoningEffort },
                  });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                {REASONING_EFFORTS.map((eff) => (
                  <option key={eff.id} value={eff.id}>
                    {eff.label}
                  </option>
                ))}
              </select>
              <p className="v2-set__hint">
                Higher effort = more deliberate answers, but more latency and cost. Start with
                Low for everyday use.
              </p>
            </div>

            {/* Cost guards */}
            <div className="v2-set__field">
              <label className="v2-set__field-label">Max session length (minutes)</label>
              <select
                className="v2-set__select"
                value={String(rt.max_session_minutes ?? 10)}
                onChange={async (e) => {
                  const r = await data.setVoiceConfig({
                    realtime: { max_session_minutes: Number(e.target.value) },
                  });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                {[5, 10, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
              <p className="v2-set__hint">
                A session closes automatically at this limit to cap runaway cost.
              </p>
            </div>

            <p className="v2-set__hint" data-tone="warn">
              Continuous audio is streamed to OpenAI while a realtime session is live. Tool calls
              are auto-approved during realtime sessions (hard denies still apply). Monitor usage
              at platform.openai.com.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
