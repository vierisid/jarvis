import React, { useState } from "react";
import { ArrowRight, Check, Loader2, Volume2, VolumeX, type LucideIcon } from "lucide-react";
import { Button, Icon } from "../ui";
import "./SetupRoom.css";

/**
 * Phase A — first-run setup. Two screens, then `POST /api/onboarding/setup`
 * which atomically saves LLM + TTS + flips the completion flag. Daemon
 * hot-reloads providers; gate refetches status; we fall through to the
 * normal AppShell (or to Phase B once that's built).
 *
 * Deliberately self-contained — no Settings Room hook reuse — because
 * setup runs BEFORE the daemon has any LLM/TTS state to read, and the
 * tabbed Settings UI's polling would hammer 503s. Reuses only the v2
 * tokens + Button primitive.
 */

type LLMProviderId =
  | "anthropic"
  | "openai"
  | "groq"
  | "gemini"
  | "ollama"
  | "openrouter"
  | "nvidia";

const PROVIDERS: ReadonlyArray<{
  id: LLMProviderId;
  label: string;
  /** True when the provider needs an API key (false for local Ollama). */
  needsKey: boolean;
  models: string[];
  /** Default model on first pick — the safest current model per provider. */
  defaultModel: string;
}> = [
  {
    id: "anthropic",
    label: "Anthropic",
    needsKey: true,
    models: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ],
    defaultModel: "claude-opus-4-7",
  },
  {
    id: "openai",
    label: "OpenAI",
    needsKey: true,
    models: ["gpt-5.4", "gpt-5.4-thinking", "gpt-5-mini", "o4-mini"],
    defaultModel: "gpt-5.4",
  },
  {
    id: "groq",
    label: "Groq",
    needsKey: true,
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    id: "gemini",
    label: "Gemini",
    needsKey: true,
    models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro"],
    defaultModel: "gemini-3.1-pro-preview",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    needsKey: false,
    models: ["llama3.1", "llama3.2", "mistral", "qwen2.5", "deepseek-coder-v2"],
    defaultModel: "llama3.1",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    needsKey: true,
    models: [
      "anthropic/claude-opus-4",
      "anthropic/claude-sonnet-4",
      "openai/gpt-5.4",
      "google/gemini-2.5-pro",
    ],
    defaultModel: "anthropic/claude-sonnet-4",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    needsKey: true,
    models: ["mistral-nemo-minitron-8b-base", "gemma-2-2b-it"],
    defaultModel: "mistral-nemo-minitron-8b-base",
  },
];

type TTSChoice = "off" | "edge" | "elevenlabs";

const EDGE_VOICES = [
  { id: "en-US-AriaNeural", label: "Aria · US Female" },
  { id: "en-US-GuyNeural", label: "Guy · US Male" },
  { id: "en-GB-SoniaNeural", label: "Sonia · UK Female" },
  { id: "en-AU-NatashaNeural", label: "Natasha · AU Female" },
  { id: "en-US-JennyNeural", label: "Jenny · US Female" },
  { id: "en-US-DavisNeural", label: "Davis · US Male" },
];

export function SetupRoom({ onComplete }: { onComplete: () => void }) {
  const [screen, setScreen] = useState<"llm" | "tts">("llm");

  // ── LLM screen state ───────────────────────────────────────────────
  const [providerId, setProviderId] = useState<LLMProviderId>("anthropic");
  const provider = PROVIDERS.find((p) => p.id === providerId)!;
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(provider.defaultModel);
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    | { ok: true; model: string }
    | { ok: false; error: string }
    | null
  >(null);

  // ── TTS screen state ───────────────────────────────────────────────
  const [ttsChoice, setTtsChoice] = useState<TTSChoice>("edge");
  const [edgeVoice, setEdgeVoice] = useState(EDGE_VOICES[0]!.id);
  const [elevenKey, setElevenKey] = useState("");

  // ── Submit state ───────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handlePickProvider = (id: LLMProviderId) => {
    setProviderId(id);
    const p = PROVIDERS.find((x) => x.id === id)!;
    setModel(p.defaultModel);
    setApiKey("");
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { provider: providerId, model };
      if (provider.needsKey) {
        if (!apiKey) {
          setTestResult({ ok: false, error: "Enter an API key first." });
          return;
        }
        body.api_key = apiKey;
      } else if (providerId === "ollama") {
        body.base_url = baseUrl;
      }
      const r = await fetch("/api/config/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as { ok: boolean; model?: string; error?: string };
      if (data.ok) {
        setTestResult({ ok: true, model: data.model ?? model });
      } else {
        setTestResult({ ok: false, error: data.error ?? "Test failed." });
      }
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Test failed." });
    } finally {
      setTesting(false);
    }
  };

  const llmReady = testResult?.ok === true;

  const handleFinish = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Build the LLM payload — omit api_key if local provider.
      const llmBlock: Record<string, unknown> = { primary: providerId };
      const provBlock: Record<string, unknown> = { model };
      if (provider.needsKey && apiKey) provBlock.api_key = apiKey;
      if (providerId === "ollama") provBlock.base_url = baseUrl;
      llmBlock[providerId] = provBlock;

      // Build the TTS payload — explicit choice always sent so the
      // user's "off" decision is recorded, not just defaulted.
      const ttsBlock: Record<string, unknown> = {
        enabled: ttsChoice !== "off",
        provider: ttsChoice === "off" ? "edge" : ttsChoice,
      };
      if (ttsChoice === "edge") {
        ttsBlock.voice = edgeVoice;
        ttsBlock.rate = "+0%";
      } else if (ttsChoice === "elevenlabs") {
        if (elevenKey) ttsBlock.elevenlabs = { api_key: elevenKey };
      }

      const r = await fetch("/api/onboarding/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm: llmBlock, tts: ttsBlock }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => `HTTP ${r.status}`);
        throw new Error(text || `HTTP ${r.status}`);
      }
      onComplete();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="v2-setup" role="dialog" aria-modal="true" aria-label="First-run setup">
      <div className="v2-setup__wrap">
        <header className="v2-setup__head">
          <div className="v2-setup__brand">JARVIS</div>
          <div className="v2-setup__progress">
            <div
              className="v2-setup__progress-step"
              data-active={screen === "llm"}
              data-done={screen !== "llm"}
            >
              1 · LLM
            </div>
            <div className="v2-setup__progress-sep">·</div>
            <div
              className="v2-setup__progress-step"
              data-active={screen === "tts"}
            >
              2 · Voice
            </div>
          </div>
        </header>

        {screen === "llm" ? (
          <section className="v2-setup__screen">
            <h1 className="v2-setup__title">Pick an LLM to power Jarvis.</h1>
            <p className="v2-setup__sub">
              Anthropic's Claude is the recommended default. Ollama runs
              locally with no API key. You can change this any time from
              Settings.
            </p>

            <div className="v2-setup__field">
              <label className="v2-setup__label">Provider</label>
              <div className="v2-setup__provider-grid" role="radiogroup">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={providerId === p.id}
                    className="v2-setup__provider-card"
                    data-active={providerId === p.id}
                    onClick={() => handlePickProvider(p.id)}
                  >
                    <span className="v2-setup__provider-name">{p.label}</span>
                    <span className="v2-setup__provider-meta">
                      {p.needsKey ? "API key" : "local"}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {provider.needsKey && (
              <div className="v2-setup__field">
                <label className="v2-setup__label" htmlFor="setup-key">
                  API key
                </label>
                <input
                  id="setup-key"
                  className="v2-setup__input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="paste your key"
                  autoComplete="off"
                />
              </div>
            )}

            {providerId === "ollama" && (
              <div className="v2-setup__field">
                <label className="v2-setup__label" htmlFor="setup-baseurl">
                  Ollama base URL
                </label>
                <input
                  id="setup-baseurl"
                  className="v2-setup__input"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    setTestResult(null);
                  }}
                />
              </div>
            )}

            <div className="v2-setup__field">
              <label className="v2-setup__label" htmlFor="setup-model">
                Model
              </label>
              <select
                id="setup-model"
                className="v2-setup__select"
                value={provider.models.includes(model) ? model : "custom"}
                onChange={(e) => {
                  const v = e.target.value;
                  setModel(v === "custom" ? "" : v);
                  setTestResult(null);
                }}
              >
                {provider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {!provider.models.includes(model) && (
                <input
                  className="v2-setup__input"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="model id (e.g. your local Ollama model name)"
                  autoComplete="off"
                  style={{ marginTop: "var(--s-2)" }}
                />
              )}
            </div>

            <div className="v2-setup__test-row">
              <Button
                variant="ghost"
                size="md"
                onClick={handleTest}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <Icon icon={Loader2} size="sm" className="v2-setup__spin" />
                    Testing…
                  </>
                ) : (
                  "Test connection"
                )}
              </Button>
              {testResult?.ok && (
                <span className="v2-setup__test-ok">
                  <Icon icon={Check} size="sm" />
                  Connected · {testResult.model}
                </span>
              )}
              {testResult && !testResult.ok && (
                <span className="v2-setup__test-err">{testResult.error}</span>
              )}
            </div>

            <div className="v2-setup__cta-row">
              <span className="v2-setup__hint">
                {llmReady
                  ? "Looking good — continue to voice setup."
                  : "Test the connection before continuing."}
              </span>
              <Button
                variant="primary"
                size="md"
                onClick={() => setScreen("tts")}
                disabled={!llmReady}
              >
                Continue
                <Icon icon={ArrowRight} size="sm" />
              </Button>
            </div>
          </section>
        ) : (
          <section className="v2-setup__screen">
            <h1 className="v2-setup__title">Should Jarvis speak to you?</h1>
            <p className="v2-setup__sub">
              Voice replies are optional. You can always change this in
              Settings later.
            </p>

            <div className="v2-setup__tts-grid" role="radiogroup">
              <TTSCard
                id="off"
                active={ttsChoice === "off"}
                onClick={() => setTtsChoice("off")}
                icon={VolumeX}
                title="No voice"
                body="Text replies only. Lightest option."
              />
              <TTSCard
                id="edge"
                active={ttsChoice === "edge"}
                onClick={() => setTtsChoice("edge")}
                icon={Volume2}
                title="Edge TTS"
                body="Free, clean, ships with Jarvis. Pick a voice below."
              />
              <TTSCard
                id="elevenlabs"
                active={ttsChoice === "elevenlabs"}
                onClick={() => setTtsChoice("elevenlabs")}
                icon={Volume2}
                title="ElevenLabs"
                body="Higher fidelity. Needs an ElevenLabs API key."
              />
            </div>

            {ttsChoice === "edge" && (
              <div className="v2-setup__field">
                <label className="v2-setup__label" htmlFor="setup-edge-voice">
                  Voice
                </label>
                <select
                  id="setup-edge-voice"
                  className="v2-setup__select"
                  value={edgeVoice}
                  onChange={(e) => setEdgeVoice(e.target.value)}
                >
                  {EDGE_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {ttsChoice === "elevenlabs" && (
              <div className="v2-setup__field">
                <label className="v2-setup__label" htmlFor="setup-eleven-key">
                  ElevenLabs API key
                </label>
                <input
                  id="setup-eleven-key"
                  className="v2-setup__input"
                  type="password"
                  value={elevenKey}
                  onChange={(e) => setElevenKey(e.target.value)}
                  placeholder="paste your key"
                  autoComplete="off"
                />
                <p className="v2-setup__hint" style={{ marginTop: "var(--s-2)" }}>
                  Voice picker shows up in Settings → Channels once your key
                  is saved (we fetch the list from your account).
                </p>
              </div>
            )}

            {saveError && (
              <div className="v2-setup__error" role="alert">
                {saveError}
              </div>
            )}

            <div className="v2-setup__cta-row">
              <Button
                variant="ghost"
                size="md"
                onClick={() => setScreen("llm")}
                disabled={saving}
              >
                ← Back
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={handleFinish}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Icon icon={Loader2} size="sm" className="v2-setup__spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    Finish setup
                    <Icon icon={ArrowRight} size="sm" />
                  </>
                )}
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function TTSCard({
  active,
  onClick,
  icon,
  title,
  body,
  id,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  title: string;
  body: string;
  id: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className="v2-setup__tts-card"
      data-active={active}
      onClick={onClick}
      data-id={id}
    >
      <Icon icon={icon} size="md" />
      <span className="v2-setup__tts-title">{title}</span>
      <span className="v2-setup__tts-body">{body}</span>
    </button>
  );
}
