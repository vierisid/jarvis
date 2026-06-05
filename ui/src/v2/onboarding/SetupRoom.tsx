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
  | "openai_compatible"
  | "litellm";

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
  {
    // LiteLLM proxy. OpenAI-compatible, but distinct row so users searching
    // for "LiteLLM" find it and get the right defaults. Models depend on
    // the aliases configured on the user's proxy, so the list stays empty.
    id: "litellm",
    label: "LiteLLM",
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

  // Advanced setup: assign separate models per tier so the router-first
  // architecture is on from first boot. All four tiers reuse the picked
  // provider + key (cross-provider setups happen in Settings later). When
  // the user toggles advanced on, we seed tier slots from `model` so they
  // start with sensible values instead of empty dropdowns.
  type LlmSetupMode = "single" | "multi-tier";
  const [llmMode, setLlmMode] = useState<LlmSetupMode>("single");
  const [tierConversation, setTierConversation] = useState("");
  const [tierHigh, setTierHigh] = useState("");
  const [tierMedium, setTierMedium] = useState("");
  const [tierLow, setTierLow] = useState("");
  const enterAdvanced = () => {
    // Seed any unset tier from the basic model so the user has working
    // defaults to refine rather than four empty pickers.
    if (!tierConversation) setTierConversation(model);
    if (!tierHigh) setTierHigh(model);
    if (!tierMedium) setTierMedium(model);
    if (!tierLow) setTierLow(model);
    setLlmMode("multi-tier");
  };

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
    } else if (id === "litellm") {
      setBaseUrl("http://localhost:4000/v1");
    } else if (id === "openai_compatible") {
      setBaseUrl("");
    }
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // In multi-tier mode test the high-tier model: it's the most
      // important one (never falls up, drives complex reasoning). If high
      // is empty fall through to medium / conversation / basic model so
      // the button always has something to validate.
      const testModel = llmMode === "multi-tier"
        ? (tierHigh || tierMedium || tierConversation || model)
        : model;
      const body: Record<string, unknown> = { provider: providerId, model: testModel };
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
      // openai_compatible / litellm: forward the typed key when present (optional).
      if ((providerId === "openai_compatible" || providerId === "litellm") && apiKey) {
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

  // Multi-tier requires at least one of medium/high to be assigned -
  // task tiers fall up to those, so without one the manager would refuse
  // to resolve any task call. (validateTierMap on the backend enforces
  // this too; we gate the Continue button here so the user gets a clear
  // signal in-form instead of a 400 from the setup POST.)
  const advancedTiersReady =
    llmMode === "single" ||
    Boolean((tierMedium && tierMedium.trim()) || (tierHigh && tierHigh.trim()));
  const llmReady = testResult?.ok === true && advancedTiersReady;

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
      // Build the LLM payload in the new (provider-name + model-ref) shape:
      //   { providers: { <name>: { kind, api_key?, base_url? } }, default: "name:model" }
      // The provider name defaults to the kind id for first-time setup
      // (e.g. "anthropic"). Users with custom names use the dashboard.
      const providerEntry: Record<string, unknown> = { kind: providerId };
      if (provider.needsKey && apiKey) providerEntry.api_key = apiKey;
      if (provider.optionalKey && apiKey) providerEntry.api_key = apiKey;
      if (provider.needsBaseUrl) providerEntry.base_url = baseUrl.trim();

      const llmBlock: Record<string, unknown> = {
        providers: { [providerId]: providerEntry },
      };
      if (llmMode === "multi-tier") {
        // Send only the tiers the user filled; the backend deletes any
        // slot we send with a null/empty value, but a brand-new config
        // already has them all unset so we just omit the empties.
        const tiers: Record<string, string | null> = {};
        const ref = (m: string) => `${providerId}:${m.trim()}`;
        if (tierConversation.trim()) tiers.conversation = ref(tierConversation);
        if (tierHigh.trim()) tiers.high = ref(tierHigh);
        if (tierMedium.trim()) tiers.medium = ref(tierMedium);
        if (tierLow.trim()) tiers.low = ref(tierLow);
        llmBlock.tiers = tiers;
        // Also set a basic `default` as the fall-up safety net (matches
        // the way the in-app LLM tab keeps `default` as fallback even in
        // multi-tier mode).
        llmBlock.default = `${providerId}:${(tierHigh || tierMedium || tierConversation || model).trim()}`;
      } else {
        llmBlock.default = `${providerId}:${model}`;
      }

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
                        : p.id === "litellm"
                          ? "proxy"
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
                  {providerId === "ollama"
                    ? "Ollama base URL"
                    : providerId === "litellm"
                      ? "LiteLLM proxy URL"
                      : "Base URL"}
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
                      : providerId === "litellm"
                        ? "http://localhost:4000/v1"
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
                {providerId === "litellm" && (
                  <p
                    className="v2-setup__hint"
                    style={{ color: "var(--ink-3)", marginTop: "var(--s-1)" }}
                  >
                    URL of your LiteLLM proxy (https://docs.litellm.ai/docs/).
                    The model below must match an alias defined on the proxy.
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

            {llmMode === "single" && (providerId === "nvidia" ? (
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
                        : providerId === "litellm"
                          ? "model alias from your LiteLLM proxy config"
                          : "model id (e.g. your local Ollama model name)"
                    }
                    autoComplete="off"
                    style={{
                      marginTop: provider.models.length > 0 ? "var(--s-2)" : 0,
                    }}
                  />
                )}
              </div>
            ))}

            {llmMode === "multi-tier" && (
              <AdvancedTierPickers
                provider={provider}
                providerId={providerId}
                nvidiaModels={nvidiaModels}
                tierConversation={tierConversation}
                setTierConversation={(m) => { setTierConversation(m); setTestResult(null); }}
                tierHigh={tierHigh}
                setTierHigh={(m) => { setTierHigh(m); setTestResult(null); }}
                tierMedium={tierMedium}
                setTierMedium={(m) => { setTierMedium(m); setTestResult(null); }}
                tierLow={tierLow}
                setTierLow={(m) => { setTierLow(m); setTestResult(null); }}
              />
            )}

            <div className="v2-setup__mode-toggle">
              {llmMode === "single" ? (
                <button
                  type="button"
                  className="v2-setup__link"
                  onClick={enterAdvanced}
                >
                  Advanced setup (per-tier models)
                </button>
              ) : (
                <button
                  type="button"
                  className="v2-setup__link"
                  onClick={() => { setLlmMode("single"); setTestResult(null); }}
                >
                  Back to single-model setup
                </button>
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



// Inline tier picker bank used by the onboarding LLM screen when the user
// flips on "Advanced setup". Reuses the same provider catalogue as the
// single-model picker (provider.models + the optional live NVIDIA catalog)
// so models match exactly. Cross-provider tiers are a settings-room
// concern; here every tier rides the same provider/key the user just
// configured above.
function AdvancedTierPickers({
  provider,
  providerId,
  nvidiaModels,
  tierConversation, setTierConversation,
  tierHigh, setTierHigh,
  tierMedium, setTierMedium,
  tierLow, setTierLow,
}: {
  provider: (typeof PROVIDERS)[number];
  providerId: LLMProviderId;
  nvidiaModels: string[] | null;
  tierConversation: string; setTierConversation: (m: string) => void;
  tierHigh: string; setTierHigh: (m: string) => void;
  tierMedium: string; setTierMedium: (m: string) => void;
  tierLow: string; setTierLow: (m: string) => void;
}) {
  const liveModels = providerId === "nvidia" && nvidiaModels && nvidiaModels.length > 0
    ? nvidiaModels
    : provider.models;

  const tiers: Array<{ id: string; label: string; sub: string; value: string; set: (m: string) => void }> = [
    { id: "conversation", label: "Conversation", sub: "Thin LLM that drives dialogue and routes work. Setting any tier activates router-first.", value: tierConversation, set: setTierConversation },
    { id: "high", label: "High intelligence", sub: "Complex reasoning, planning, deep code.", value: tierHigh, set: setTierHigh },
    { id: "medium", label: "Medium intelligence", sub: "General tool use, workflow orchestration.", value: tierMedium, set: setTierMedium },
    { id: "low", label: "Low intelligence", sub: "Classification, summarisation, fast cheap calls.", value: tierLow, set: setTierLow },
  ];

  return (
    <div className="v2-setup__field">
      <label className="v2-setup__label">Tier models</label>
      <p className="v2-setup__hint" style={{ marginBottom: "var(--s-2)" }}>
        Set at least the high or medium tier. Empty tiers fall up: low -&gt; medium -&gt; high.
        All tiers reuse the provider configured above; mix providers later from Settings &gt; LLM.
      </p>
      <div className="v2-setup__tiers">
        {tiers.map((t) => (
          <div key={t.id} className="v2-setup__tier-row">
            <div className="v2-setup__tier-meta">
              <div className="v2-setup__tier-label">{t.label}</div>
              <div className="v2-setup__tier-sub">{t.sub}</div>
            </div>
            <div className="v2-setup__tier-input">
              {liveModels.length > 0 && (
                <select
                  className="v2-setup__select"
                  value={liveModels.includes(t.value) ? t.value : (t.value ? "custom" : "")}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") t.set("");
                    else if (v === "custom") t.set(t.value || "");
                    else t.set(v);
                  }}
                >
                  <option value="">(unset, falls up)</option>
                  {liveModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  <option value="custom">Custom...</option>
                </select>
              )}
              {(liveModels.length === 0 || (t.value && !liveModels.includes(t.value))) && (
                <input
                  className="v2-setup__input"
                  value={t.value}
                  onChange={(e) => t.set(e.target.value)}
                  placeholder={liveModels.length === 0 ? "model id" : "custom model id"}
                  autoComplete="off"
                  style={{ marginTop: liveModels.length > 0 ? "var(--s-1)" : 0 }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
