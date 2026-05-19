import React, { useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, Mic, MicOff, Volume2, VolumeX, type LucideIcon } from "lucide-react";
import { Button, Icon } from "../ui";
import "./SetupRoom.css";

/**
 * Phase A — first-run setup. Three screens, then `POST /api/onboarding/setup`
 * which atomically saves LLM + STT + TTS + flips the completion flag. Daemon
 * hot-reloads providers; gate refetches status; we fall through to the
 * normal AppShell (or to Phase B once that's built).
 *
 * Deliberately self-contained — no Settings Room hook reuse — because
 * setup runs BEFORE the daemon has any LLM/STT/TTS state to read, and the
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
  | "nvidia"
  | "openai_compatible";

const PROVIDERS: ReadonlyArray<{
  id: LLMProviderId;
  label: string;
  /** True when the provider needs an API key (false for local Ollama). */
  needsKey: boolean;
  /** True when the provider needs a base URL (Ollama, OpenAI-compatible). */
  needsBaseUrl?: boolean;
  /** True when the API key is optional (OpenAI-compatible local servers). */
  optionalKey?: boolean;
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
    needsBaseUrl: true,
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
    // NVIDIA's catalog rotates often, so the live list from
    // GET /api/config/llm/nvidia/models replaces this fallback once it
    // arrives. These entries are only the offline safety net.
    id: "nvidia",
    label: "NVIDIA NIM",
    needsKey: true,
    models: ["meta/llama-3.3-70b-instruct", "meta/llama-3.1-8b-instruct", "google/gemma-2-2b-it"],
    defaultModel: "meta/llama-3.3-70b-instruct",
  },
  {
    // Generic /v1/chat/completions endpoint: llama.cpp, vLLM, LM Studio,
    // TGI, Together, Anyscale, etc. The model id is entirely user-defined
    // so we leave the list empty and let the "Custom..." path handle it.
    id: "openai_compatible",
    label: "OpenAI-compatible",
    needsKey: false,
    needsBaseUrl: true,
    optionalKey: true,
    models: [],
    defaultModel: "",
  },
];

type STTChoice = "skip" | "openai" | "groq" | "local";

type LocalSTTServer = "whisper_cpp" | "openai_compatible";

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
  const [screen, setScreen] = useState<"llm" | "stt" | "tts">("llm");

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

  // NVIDIA's catalog rotates, so we fetch live IDs. Falls back to the
  // hardcoded `provider.models` if the call fails (offline, daemon down).
  // The list mixes chat / embedding / vision models — there's no type
  // field to filter on, so the connection test is the final guard.
  const [nvidiaModels, setNvidiaModels] = useState<string[] | null>(null);
  const [nvidiaFilter, setNvidiaFilter] = useState("");
  const [nvidiaLoading, setNvidiaLoading] = useState(false);
  useEffect(() => {
    if (providerId !== "nvidia" || nvidiaModels !== null) return;
    let cancelled = false;
    setNvidiaLoading(true);
    fetch("/api/config/llm/nvidia/models")
      .then((r) => r.json())
      .then((d: { ok: boolean; models?: string[] }) => {
        if (cancelled) return;
        if (d.ok && d.models && d.models.length > 0) {
          setNvidiaModels(d.models);
        } else {
          setNvidiaModels([]);
        }
      })
      .catch(() => {
        if (!cancelled) setNvidiaModels([]);
      })
      .finally(() => {
        if (!cancelled) setNvidiaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, nvidiaModels]);

  // When the NVIDIA list arrives and the user is still on the default
  // fallback model, snap to the first live id so the test button works
  // even if NVIDIA has dropped our hardcoded default from the catalog.
  useEffect(() => {
    if (providerId !== "nvidia") return;
    if (!nvidiaModels || nvidiaModels.length === 0) return;
    if (!nvidiaModels.includes(model)) {
      const preferred =
        nvidiaModels.find((m) => m === "meta/llama-3.3-70b-instruct") ??
        nvidiaModels[0]!;
      setModel(preferred);
    }
  }, [nvidiaModels, providerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── STT screen state ───────────────────────────────────────────────
  // Default to "skip" so users who only want text chat aren't forced to
  // hand over a Whisper key on first run. They can wire STT later from
  // Settings → Channels.
  const [sttChoice, setSttChoice] = useState<STTChoice>("skip");
  const [sttKey, setSttKey] = useState("");
  // Matches LocalWhisperSTT's constructor default in src/comms/voice.ts so
  // a user who accepts the suggested endpoint hits a working whisper.cpp
  // server out of the box. Keep these in sync if either changes.
  const [sttLocalEndpoint, setSttLocalEndpoint] = useState("http://localhost:8080");
  const [sttLocalServer, setSttLocalServer] = useState<LocalSTTServer>("whisper_cpp");

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
    // Switch the base URL placeholder per provider so the user doesn't
    // submit an Ollama URL into an OpenAI-compatible setup and vice versa.
    if (id === "ollama") {
      setBaseUrl("http://localhost:11434");
    } else if (id === "openai_compatible") {
      setBaseUrl("");
    }
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
      }
      if (provider.needsBaseUrl) {
        if (!baseUrl.trim()) {
          setTestResult({ ok: false, error: "Enter a base URL first." });
          return;
        }
        body.base_url = baseUrl.trim();
      }
      // openai_compatible: forward the typed key when present (optional).
      if (providerId === "openai_compatible" && apiKey) {
        body.api_key = apiKey;
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

  // Gate the STT Continue button so we never persist a cloud provider with
  // no key (which fails at first transcription) or a local endpoint of "".
  // Skip is always ready — it just omits the stt block from the payload.
  const sttReady =
    sttChoice === "skip"
      ? true
      : sttChoice === "local"
        ? sttLocalEndpoint.trim() !== ""
        : sttKey.trim() !== "";

  const handleFinish = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Build the LLM payload — omit api_key if local provider.
      const llmBlock: Record<string, unknown> = { primary: providerId };
      const provBlock: Record<string, unknown> = { model };
      if (provider.needsKey && apiKey) provBlock.api_key = apiKey;
      // openai_compatible: api_key is optional, forward when provided.
      if (provider.optionalKey && apiKey) provBlock.api_key = apiKey;
      if (provider.needsBaseUrl) provBlock.base_url = baseUrl.trim();
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

      // Build the STT payload — omitted entirely when the user skipped so
      // the backend leaves the default config untouched. The backend
      // mirrors /api/config/stt POST semantics (preserves existing keys
      // when a sub-block omits api_key).
      const payload: Record<string, unknown> = { llm: llmBlock, tts: ttsBlock };
      if (sttChoice !== "skip") {
        const sttBlock: Record<string, unknown> = { provider: sttChoice };
        if (sttChoice === "openai" || sttChoice === "groq") {
          if (sttKey) sttBlock[sttChoice] = { api_key: sttKey };
        } else if (sttChoice === "local") {
          sttBlock.local = {
            endpoint: sttLocalEndpoint.trim(),
            server_type: sttLocalServer,
          };
        }
        payload.stt = sttBlock;
      }

      const r = await fetch("/api/onboarding/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
              data-active={screen === "stt"}
              data-done={screen === "tts"}
            >
              2 · Voice In
            </div>
            <div className="v2-setup__progress-sep">·</div>
            <div
              className="v2-setup__progress-step"
              data-active={screen === "tts"}
            >
              3 · Voice Out
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
                      {p.id === "openai_compatible"
                        ? "self-hosted"
                        : p.needsKey
                          ? "API key"
                          : "local"}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {provider.needsBaseUrl && (
              <div className="v2-setup__field">
                <label className="v2-setup__label" htmlFor="setup-baseurl">
                  {providerId === "ollama" ? "Ollama base URL" : "Base URL"}
                </label>
                <input
                  id="setup-baseurl"
                  className="v2-setup__input"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder={
                    providerId === "ollama"
                      ? "http://localhost:11434"
                      : "http://localhost:8080/v1"
                  }
                />
                {providerId === "openai_compatible" && (
                  <p
                    className="v2-setup__hint"
                    style={{ color: "var(--ink-3)", marginTop: "var(--s-1)" }}
                  >
                    Any server that speaks /v1/chat/completions: llama.cpp,
                    vLLM, LM Studio, TGI, Together, Anyscale. Include the
                    /v1 suffix.
                  </p>
                )}
              </div>
            )}

            {(provider.needsKey || provider.optionalKey) && (
              <div className="v2-setup__field">
                <label className="v2-setup__label" htmlFor="setup-key">
                  API key{provider.optionalKey ? " (optional)" : ""}
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
                  placeholder={
                    provider.optionalKey
                      ? "leave empty if your server skips auth"
                      : "paste your key"
                  }
                  autoComplete="off"
                />
              </div>
            )}

            {providerId === "nvidia" ? (
              (() => {
                const liveModels = nvidiaModels && nvidiaModels.length > 0
                  ? nvidiaModels
                  : provider.models;
                const filter = nvidiaFilter.trim().toLowerCase();
                const filtered = filter
                  ? liveModels.filter((m) => m.toLowerCase().includes(filter))
                  : liveModels;
                const selectValue = filtered.includes(model)
                  ? model
                  : liveModels.includes(model)
                    ? "__hidden_by_filter"
                    : "custom";
                return (
                  <div className="v2-setup__field">
                    <label className="v2-setup__label" htmlFor="setup-model">
                      Model
                    </label>
                    <input
                      className="v2-setup__input"
                      value={nvidiaFilter}
                      onChange={(e) => setNvidiaFilter(e.target.value)}
                      placeholder={
                        nvidiaLoading
                          ? "Loading model catalog…"
                          : `Filter ${liveModels.length} models (e.g. llama, mistral, gemma)`
                      }
                      autoComplete="off"
                      style={{ marginBottom: "var(--s-2)" }}
                    />
                    <select
                      id="setup-model"
                      className="v2-setup__select"
                      value={selectValue}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "__hidden_by_filter") return;
                        setModel(v === "custom" ? "" : v);
                        setTestResult(null);
                      }}
                    >
                      {selectValue === "__hidden_by_filter" && (
                        <option value="__hidden_by_filter" disabled>
                          {model} (hidden by filter)
                        </option>
                      )}
                      {filtered.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      {filtered.length === 0 && (
                        <option value="" disabled>
                          No models match "{nvidiaFilter}"
                        </option>
                      )}
                      <option value="custom">Custom…</option>
                    </select>
                    {selectValue === "custom" && (
                      <input
                        className="v2-setup__input"
                        value={model}
                        onChange={(e) => {
                          setModel(e.target.value);
                          setTestResult(null);
                        }}
                        placeholder="model id (e.g. meta/llama-3.3-70b-instruct)"
                        autoComplete="off"
                        style={{ marginTop: "var(--s-2)" }}
                      />
                    )}
                    <p className="v2-setup__hint">
                      The catalog includes chat, embedding and vision models.
                      Test connection confirms the model speaks chat.
                    </p>
                  </div>
                );
              })()
            ) : (
              <div className="v2-setup__field">
                <label className="v2-setup__label" htmlFor="setup-model">
                  Model
                </label>
                {provider.models.length > 0 && (
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
                )}
                {!provider.models.includes(model) && (
                  <input
                    className="v2-setup__input"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setTestResult(null);
                    }}
                    placeholder={
                      providerId === "openai_compatible"
                        ? "model id (whatever your server exposes)"
                        : "model id (e.g. your local Ollama model name)"
                    }
                    autoComplete="off"
                    style={{
                      marginTop: provider.models.length > 0 ? "var(--s-2)" : 0,
                    }}
                  />
                )}
              </div>
            )}

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
                onClick={() => setScreen("stt")}
                disabled={!llmReady}
              >
                Continue
                <Icon icon={ArrowRight} size="sm" />
              </Button>
            </div>
          </section>
        ) : screen === "stt" ? (
          <section className="v2-setup__screen">
            <h1 className="v2-setup__title">How should Jarvis hear you?</h1>
            <p className="v2-setup__sub">
              Speech-to-text powers voice messages and the mic button. Skip
              for now if you only plan to type — you can wire this up later
              in Settings → Channels.
            </p>

            <div className="v2-setup__tts-grid" role="radiogroup">
              <ChoiceCard
                id="skip"
                active={sttChoice === "skip"}
                onClick={() => setSttChoice("skip")}
                icon={MicOff}
                title="Skip for now"
                body="Text only. Wire up STT later from Settings."
              />
              <ChoiceCard
                id="openai"
                active={sttChoice === "openai"}
                onClick={() => setSttChoice("openai")}
                icon={Mic}
                title="OpenAI Whisper"
                body="Cloud Whisper. Accurate, needs an OpenAI API key."
              />
              <ChoiceCard
                id="groq"
                active={sttChoice === "groq"}
                onClick={() => setSttChoice("groq")}
                icon={Mic}
                title="Groq Whisper"
                body="Fastest hosted Whisper. Needs a Groq API key."
              />
              <ChoiceCard
                id="local"
                active={sttChoice === "local"}
                onClick={() => setSttChoice("local")}
                icon={Mic}
                title="Local Whisper.cpp"
                body="Self-hosted on your machine. No API key needed."
              />
            </div>

            {(sttChoice === "openai" || sttChoice === "groq") && (
              <div className="v2-setup__field">
                <label className="v2-setup__label" htmlFor="setup-stt-key">
                  {sttChoice === "openai" ? "OpenAI" : "Groq"} API key
                </label>
                <input
                  id="setup-stt-key"
                  className="v2-setup__input"
                  type="password"
                  value={sttKey}
                  onChange={(e) => setSttKey(e.target.value)}
                  placeholder="paste your key"
                  autoComplete="off"
                />
                <p className="v2-setup__hint">
                  Stored locally in your JARVIS config — never sent anywhere
                  except {sttChoice === "openai" ? "OpenAI" : "Groq"}.
                </p>
              </div>
            )}

            {sttChoice === "local" && (
              <>
                <div className="v2-setup__field">
                  <label className="v2-setup__label" htmlFor="setup-stt-endpoint">
                    Whisper endpoint
                  </label>
                  <input
                    id="setup-stt-endpoint"
                    className="v2-setup__input"
                    value={sttLocalEndpoint}
                    onChange={(e) => setSttLocalEndpoint(e.target.value)}
                    placeholder="http://localhost:8080"
                    autoComplete="off"
                  />
                </div>
                <div className="v2-setup__field">
                  <label className="v2-setup__label" htmlFor="setup-stt-server">
                    Server type
                  </label>
                  <select
                    id="setup-stt-server"
                    className="v2-setup__select"
                    value={sttLocalServer}
                    onChange={(e) => setSttLocalServer(e.target.value as LocalSTTServer)}
                  >
                    <option value="whisper_cpp">whisper.cpp</option>
                    <option value="openai_compatible">OpenAI-compatible</option>
                  </select>
                </div>
              </>
            )}

            <div className="v2-setup__cta-row">
              <Button
                variant="ghost"
                size="md"
                onClick={() => setScreen("llm")}
              >
                ← Back
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={() => setScreen("tts")}
                disabled={!sttReady}
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
              <ChoiceCard
                id="off"
                active={ttsChoice === "off"}
                onClick={() => setTtsChoice("off")}
                icon={VolumeX}
                title="No voice"
                body="Text replies only. Lightest option."
              />
              <ChoiceCard
                id="edge"
                active={ttsChoice === "edge"}
                onClick={() => setTtsChoice("edge")}
                icon={Volume2}
                title="Edge TTS"
                body="Free, clean, ships with Jarvis. Pick a voice below."
              />
              <ChoiceCard
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
                onClick={() => setScreen("stt")}
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

function ChoiceCard({
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

