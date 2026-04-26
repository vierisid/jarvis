import React, { useEffect, useState } from "react";
import type {
  STTProvider,
  SettingsHook,
  TTSProvider,
} from "../useSettingsData";

const EDGE_VOICES = [
  { id: "en-US-AriaNeural", label: "Aria (US Female)" },
  { id: "en-US-GuyNeural", label: "Guy (US Male)" },
  { id: "en-GB-SoniaNeural", label: "Sonia (UK Female)" },
  { id: "en-AU-NatashaNeural", label: "Natasha (AU Female)" },
  { id: "en-US-JennyNeural", label: "Jenny (US Female)" },
  { id: "en-US-DavisNeural", label: "Davis (US Male)" },
];

const EDGE_RATES = [
  { id: "-20%", label: "Slow" },
  { id: "+0%", label: "Normal" },
  { id: "+15%", label: "Fast" },
  { id: "+30%", label: "Very fast" },
];

const SARVAM_LANGUAGES = [
  "en-IN",
  "hi-IN",
  "ta-IN",
  "te-IN",
  "kn-IN",
  "ml-IN",
];

const SARVAM_SPEAKERS = [
  "anushka",
  "amit",
  "priya",
  "rohan",
  "simran",
  "kabir",
  "arya",
  "hitesh",
];

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
}

export function ChannelsTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const { channelStatus, channelCfg, sttCfg, ttsCfg } = data;

  // Telegram form
  const [tgToken, setTgToken] = useState("");
  const [tgAllowed, setTgAllowed] = useState("");

  // Discord form
  const [dcToken, setDcToken] = useState("");
  const [dcAllowed, setDcAllowed] = useState("");
  const [dcGuild, setDcGuild] = useState("");

  // STT form
  const [sttKey, setSttKey] = useState("");
  const [sttEndpoint, setSttEndpoint] = useState("http://localhost:8080");
  const [sttServerType, setSttServerType] = useState("whisper_cpp");

  // TTS extras
  const [elKey, setElKey] = useState("");
  const [elVoices, setElVoices] = useState<ElevenLabsVoice[]>([]);
  const [elVoicesLoading, setElVoicesLoading] = useState(false);
  const [sarvKey, setSarvKey] = useState("");

  useEffect(() => {
    if (channelCfg) {
      setTgAllowed(channelCfg.telegram.allowed_users.join(", "));
      setDcAllowed(channelCfg.discord.allowed_users.join(", "));
      setDcGuild(channelCfg.discord.guild_id ?? "");
    }
  }, [channelCfg]);

  useEffect(() => {
    if (sttCfg?.local_endpoint) setSttEndpoint(sttCfg.local_endpoint);
    if (sttCfg?.local_server_type) setSttServerType(sttCfg.local_server_type);
  }, [sttCfg]);

  useEffect(() => {
    if (ttsCfg?.provider !== "elevenlabs") return;
    if (!ttsCfg?.elevenlabs?.has_api_key) return;
    setElVoicesLoading(true);
    fetch("/api/tts/voices?provider=elevenlabs")
      .then((r) => (r.ok ? r.json() : []))
      .then((v) => setElVoices(Array.isArray(v) ? v : []))
      .catch(() => setElVoices([]))
      .finally(() => setElVoicesLoading(false));
  }, [ttsCfg?.provider, ttsCfg?.elevenlabs?.has_api_key]);

  return (
    <div>
      {/* Telegram */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Telegram</h3>
            <div className="v2-set__section-sub">
              Bot via @BotFather. Restart-required after token changes.
            </div>
          </div>
          <span className={"v2-set__chip " + (channelStatus?.channels.telegram ? "v2-set__chip--ok" : "")}>
            {channelStatus?.channels.telegram ? "Connected" : "Disconnected"}
          </span>
        </div>

        <label className="v2-set__toggle-row">
          <button
            type="button"
            className="v2-set__toggle"
            data-checked={!!channelCfg?.telegram.enabled}
            aria-checked={!!channelCfg?.telegram.enabled}
            role="switch"
            onClick={async () => {
              const r = await data.setTelegram({
                enabled: !channelCfg?.telegram.enabled,
              });
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          />
          <span>Enable Telegram</span>
          {channelCfg?.telegram.has_token && (
            <span className="v2-set__chip" style={{ marginLeft: "auto" }}>
              token configured
            </span>
          )}
        </label>

        <div className="v2-set__field">
          <label className="v2-set__field-label">Bot token</label>
          <input
            className="v2-set__input"
            type="password"
            placeholder="leave empty to keep existing"
            value={tgToken}
            onChange={(e) => setTgToken(e.target.value)}
          />
        </div>
        <div className="v2-set__field">
          <label className="v2-set__field-label">Allowed user IDs (comma-separated)</label>
          <input
            className="v2-set__input"
            type="text"
            value={tgAllowed}
            onChange={(e) => setTgAllowed(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="v2-set__btn v2-set__btn--primary"
            onClick={async () => {
              const allowed = tgAllowed
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .map(Number)
                .filter((n) => Number.isFinite(n));
              const r = await data.setTelegram({
                bot_token: tgToken || undefined,
                allowed_users: allowed,
              });
              if (r.ok) setTgToken("");
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          >
            Save Telegram
          </button>
        </div>
      </section>

      {/* Discord */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Discord</h3>
            <div className="v2-set__section-sub">
              Bot via discord.com/developers. Enable Message Content Intent. Restart-required.
            </div>
          </div>
          <span className={"v2-set__chip " + (channelStatus?.channels.discord ? "v2-set__chip--ok" : "")}>
            {channelStatus?.channels.discord ? "Connected" : "Disconnected"}
          </span>
        </div>

        <label className="v2-set__toggle-row">
          <button
            type="button"
            className="v2-set__toggle"
            data-checked={!!channelCfg?.discord.enabled}
            aria-checked={!!channelCfg?.discord.enabled}
            role="switch"
            onClick={async () => {
              const r = await data.setDiscord({
                enabled: !channelCfg?.discord.enabled,
              });
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          />
          <span>Enable Discord</span>
          {channelCfg?.discord.has_token && (
            <span className="v2-set__chip" style={{ marginLeft: "auto" }}>
              token configured
            </span>
          )}
        </label>

        <div className="v2-set__field">
          <label className="v2-set__field-label">Bot token</label>
          <input
            className="v2-set__input"
            type="password"
            placeholder="leave empty to keep existing"
            value={dcToken}
            onChange={(e) => setDcToken(e.target.value)}
          />
        </div>
        <div className="v2-set__field">
          <label className="v2-set__field-label">Allowed user IDs (comma-separated)</label>
          <input
            className="v2-set__input"
            type="text"
            value={dcAllowed}
            onChange={(e) => setDcAllowed(e.target.value)}
          />
        </div>
        <div className="v2-set__field">
          <label className="v2-set__field-label">Guild ID (optional, restrict to one server)</label>
          <input
            className="v2-set__input"
            type="text"
            value={dcGuild}
            onChange={(e) => setDcGuild(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="v2-set__btn v2-set__btn--primary"
            onClick={async () => {
              const allowed = dcAllowed
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const r = await data.setDiscord({
                bot_token: dcToken || undefined,
                allowed_users: allowed,
                guild_id: dcGuild || undefined,
              });
              if (r.ok) setDcToken("");
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          >
            Save Discord
          </button>
        </div>
      </section>

      {/* STT */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Voice Transcription (STT)</h3>
            <div className="v2-set__section-sub">
              Enables voice messages on Telegram and Discord. Restart-required.
            </div>
          </div>
        </div>

        <div className="v2-set__field">
          <label className="v2-set__field-label">Provider</label>
          <select
            className="v2-set__select"
            value={sttCfg?.provider ?? "openai"}
            onChange={async (e) => {
              const r = await data.setSTTProvider(e.target.value as STTProvider);
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          >
            <option value="openai">OpenAI Whisper</option>
            <option value="groq">Groq Whisper</option>
            <option value="sarvam">Sarvam AI</option>
            <option value="local">Local Whisper (whisper.cpp)</option>
          </select>
        </div>

        {(sttCfg?.provider === "openai" ||
          sttCfg?.provider === "groq" ||
          sttCfg?.provider === "sarvam") && (
          <div className="v2-set__field">
            <label className="v2-set__field-label">API key for {sttCfg?.provider}</label>
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              <input
                className="v2-set__input"
                type="password"
                placeholder="leave empty to keep existing"
                value={sttKey}
                onChange={(e) => setSttKey(e.target.value)}
              />
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                disabled={!sttKey}
                onClick={async () => {
                  if (!sttCfg) return;
                  const r = await data.setSTTProvider(
                    sttCfg.provider as STTProvider,
                    { api_key: sttKey },
                  );
                  if (r.ok) setSttKey("");
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                Save key
              </button>
            </div>
            <p className="v2-set__hint">
              {(sttCfg?.provider === "openai" && sttCfg?.has_openai_key) ||
              (sttCfg?.provider === "groq" && sttCfg?.has_groq_key) ||
              (sttCfg?.provider === "sarvam" && sttCfg?.has_sarvam_key)
                ? "API key configured."
                : "No key configured."}
            </p>
          </div>
        )}

        {sttCfg?.provider === "local" && (
          <>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Whisper endpoint</label>
              <input
                className="v2-set__input"
                value={sttEndpoint}
                onChange={(e) => setSttEndpoint(e.target.value)}
              />
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Server type</label>
              <select
                className="v2-set__select"
                value={sttServerType}
                onChange={(e) => setSttServerType(e.target.value)}
              >
                <option value="whisper_cpp">whisper.cpp</option>
                <option value="openai_compatible">OpenAI-compatible</option>
              </select>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                onClick={async () => {
                  const r = await data.setSTTProvider("local", {
                    endpoint: sttEndpoint,
                    server_type: sttServerType,
                  });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                Save local STT
              </button>
            </div>
          </>
        )}
      </section>

      {/* TTS */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Text-to-Speech (TTS)</h3>
            <div className="v2-set__section-sub">
              Voice responses from Jarvis via the dashboard. Hot-reloaded.
            </div>
          </div>
        </div>

        <label className="v2-set__toggle-row">
          <button
            type="button"
            className="v2-set__toggle"
            data-checked={!!ttsCfg?.enabled}
            aria-checked={!!ttsCfg?.enabled}
            role="switch"
            onClick={async () => {
              const r = await data.setTTS({ enabled: !ttsCfg?.enabled });
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          />
          <span>Enable TTS</span>
        </label>

        <div className="v2-set__field">
          <label className="v2-set__field-label">Provider</label>
          <select
            className="v2-set__select"
            value={ttsCfg?.provider ?? "edge"}
            onChange={async (e) => {
              const r = await data.setTTS({ provider: e.target.value as TTSProvider });
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          >
            <option value="edge">Edge TTS (free)</option>
            <option value="elevenlabs">ElevenLabs (API key)</option>
            <option value="sarvam">Sarvam AI (Indian languages)</option>
          </select>
        </div>

        {ttsCfg?.provider === "edge" && (
          <>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Voice</label>
              <select
                className="v2-set__select"
                value={ttsCfg?.voice ?? "en-US-AriaNeural"}
                onChange={async (e) => {
                  const r = await data.setTTS({ voice: e.target.value });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                {EDGE_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Speaking rate</label>
              <select
                className="v2-set__select"
                value={ttsCfg?.rate ?? "+0%"}
                onChange={async (e) => {
                  const r = await data.setTTS({ rate: e.target.value });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                {EDGE_RATES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {ttsCfg?.provider === "elevenlabs" && (
          <>
            <p className="v2-set__hint">
              Get your API key from elevenlabs.io/app/settings/api-keys.
            </p>
            <div className="v2-set__field">
              <label className="v2-set__field-label">ElevenLabs API key</label>
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <input
                  className="v2-set__input"
                  type="password"
                  placeholder="leave empty to keep existing"
                  value={elKey}
                  onChange={(e) => setElKey(e.target.value)}
                />
                <button
                  type="button"
                  className="v2-set__btn v2-set__btn--primary"
                  disabled={!elKey}
                  onClick={async () => {
                    const r = await data.setTTS({
                      elevenlabs: { api_key: elKey },
                    });
                    if (r.ok) setElKey("");
                    onToast(r.message, r.ok ? "ok" : "warn");
                  }}
                >
                  Save key
                </button>
              </div>
              <p className="v2-set__hint">
                {ttsCfg?.elevenlabs?.has_api_key
                  ? "API key configured."
                  : "No key configured. Save first, then voices will load."}
              </p>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Voice</label>
              {elVoicesLoading ? (
                <p className="v2-set__hint">Loading voices…</p>
              ) : elVoices.length > 0 ? (
                <select
                  className="v2-set__select"
                  value={ttsCfg?.elevenlabs?.voice_id ?? ""}
                  onChange={async (e) => {
                    const r = await data.setTTS({
                      elevenlabs: { voice_id: e.target.value },
                    });
                    onToast(r.message, r.ok ? "ok" : "warn");
                  }}
                >
                  <option value="">Default (Rachel)</option>
                  {elVoices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name} ({v.category})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="v2-set__hint">Save API key first to load voices.</p>
              )}
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Model</label>
              <select
                className="v2-set__select"
                value={ttsCfg?.elevenlabs?.model ?? "eleven_flash_v2_5"}
                onChange={async (e) => {
                  const r = await data.setTTS({
                    elevenlabs: { model: e.target.value },
                  });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                <option value="eleven_flash_v2_5">Flash v2.5 (fast, low latency)</option>
                <option value="eleven_multilingual_v2">Multilingual v2 (higher quality)</option>
              </select>
            </div>
          </>
        )}

        {ttsCfg?.provider === "sarvam" && (
          <>
            <p className="v2-set__hint">High-quality TTS for Indian languages.</p>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Sarvam subscription key</label>
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <input
                  className="v2-set__input"
                  type="password"
                  placeholder="leave empty to keep existing"
                  value={sarvKey}
                  onChange={(e) => setSarvKey(e.target.value)}
                />
                <button
                  type="button"
                  className="v2-set__btn v2-set__btn--primary"
                  disabled={!sarvKey}
                  onClick={async () => {
                    const r = await data.setTTS({
                      sarvam: { api_key: sarvKey },
                    });
                    if (r.ok) setSarvKey("");
                    onToast(r.message, r.ok ? "ok" : "warn");
                  }}
                >
                  Save key
                </button>
              </div>
              <p className="v2-set__hint">
                {ttsCfg?.sarvam?.has_api_key ? "API key configured." : "No key configured."}
              </p>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Model</label>
              <select
                className="v2-set__select"
                value={ttsCfg?.sarvam?.model ?? "bulbul:v3"}
                onChange={async (e) => {
                  const r = await data.setTTS({
                    sarvam: { model: e.target.value },
                  });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                <option value="bulbul:v3">Bulbul v3</option>
                <option value="bulbul:v2">Bulbul v2</option>
              </select>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Language</label>
              <select
                className="v2-set__select"
                value={ttsCfg?.sarvam?.language ?? "en-IN"}
                onChange={async (e) => {
                  const r = await data.setTTS({
                    sarvam: { language: e.target.value },
                  });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                {SARVAM_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Speaker</label>
              <select
                className="v2-set__select"
                value={ttsCfg?.sarvam?.speaker ?? "anushka"}
                onChange={async (e) => {
                  const r = await data.setTTS({
                    sarvam: { speaker: e.target.value },
                  });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                {SARVAM_SPEAKERS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Sampling rate</label>
              <select
                className="v2-set__select"
                value={ttsCfg?.sarvam?.sampling_rate ?? 48000}
                onChange={async (e) => {
                  const r = await data.setTTS({
                    sarvam: { sampling_rate: Number(e.target.value) },
                  });
                  onToast(r.message, r.ok ? "ok" : "warn");
                }}
              >
                <option value={16000}>16 kHz</option>
                <option value={24000}>24 kHz</option>
                <option value={48000}>48 kHz (high fidelity)</option>
              </select>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
