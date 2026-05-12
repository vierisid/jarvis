import React, { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Icon } from "../../../ui";
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_LABELS,
  type LLMProvider,
  type SettingsHook,
} from "../useSettingsData";

const MODELS: Record<LLMProvider, string[]> = {
  anthropic: [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    "gpt-5.4",
    "gpt-5.4-thinking",
    "gpt-5.4-pro",
    "gpt-5.3-instant",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.1-codex",
    "gpt-4.1",
    "o3",
    "o4-mini",
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "qwen/qwen3-32b",
    "deepseek-r1-distill-llama-70b",
  ],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-3-deep-think",
    "gemini-3-flash-preview",
    "gemini-3-1-flash-lite-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ],
  ollama: [
    "llama3",
    "llama3.1",
    "llama3.2",
    "mistral",
    "mixtral",
    "codellama",
    "qwen2.5",
    "deepseek-coder-v2",
    "phi3",
  ],
  openrouter: [
    "anthropic/claude-sonnet-4",
    "anthropic/claude-opus-4",
    "anthropic/claude-haiku-4",
    "openai/gpt-5.4",
    "openai/o3",
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
    "deepseek/deepseek-r1",
    "meta-llama/llama-4-maverick",
    "mistralai/mistral-large",
  ],
  // NVIDIA models are fetched live from /api/config/llm/nvidia/models when
  // the row is expanded. These entries are the offline fallback.
  nvidia: ["meta/llama-3.3-70b-instruct", "meta/llama-3.1-8b-instruct", "google/gemma-2-2b-it"],
};

export function LLMTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const llm = data.llm;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!llm) return <div className="v2-set__empty">Loading LLM config…</div>;

  return (
    <div>
      {/* Primary + fallback */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Routing</h3>
            <div className="v2-set__section-sub">
              Primary handles every request; fallbacks step in when it fails.
            </div>
          </div>
        </div>

        <div className="v2-set__field">
          <label className="v2-set__field-label">Primary provider</label>
          <select
            className="v2-set__select"
            value={llm.primary}
            onChange={async (e) => {
              const r = await data.setPrimaryLLM(e.target.value as LLMProvider);
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          >
            {LLM_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {LLM_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-set__field">
          <label className="v2-set__field-label">Fallback chain</label>
          <div className="v2-set__chip-row">
            {LLM_PROVIDERS.filter((p) => p !== llm.primary).map((p) => {
              const active = llm.fallback.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={"v2-set__btn " + (active ? "v2-set__btn--primary" : "")}
                  onClick={async () => {
                    const next = active
                      ? llm.fallback.filter((x) => x !== p)
                      : [...llm.fallback, p];
                    const r = await data.setFallbackLLM(next);
                    onToast(r.message, r.ok ? "ok" : "warn");
                  }}
                >
                  {LLM_PROVIDER_LABELS[p]}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Per-provider rows */}
      {LLM_PROVIDERS.map((p) => (
        <ProviderRow
          key={p}
          provider={p}
          data={data}
          onToast={onToast}
          isPrimary={llm.primary === p}
          isFallback={llm.fallback.includes(p)}
          expanded={!!expanded[p]}
          onToggleExpanded={() =>
            setExpanded((s) => ({ ...s, [p]: !s[p] }))
          }
        />
      ))}
    </div>
  );
}

function ProviderRow({
  provider,
  data,
  onToast,
  isPrimary,
  isFallback,
  expanded,
  onToggleExpanded,
}: {
  provider: LLMProvider;
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  isPrimary: boolean;
  isFallback: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const pCfg = data.llm ? (data.llm as any)[provider] : null;
  // For Ollama "configured" means the user actually set a base_url. The
  // default config now ships with an empty base_url (see PR 179) so a fresh
  // install no longer reports Ollama as ready when it isn't.
  const hasKey = provider === "ollama" ? !!pCfg?.base_url : !!pCfg?.has_api_key;
  const currentModel: string = pCfg?.model ?? "";
  const currentBaseUrl: string = pCfg?.base_url ?? "";

  // NVIDIA's catalog rotates often, so we fetch the live model list when the
  // row opens. Falls back to the hardcoded MODELS[provider] entries when the
  // call fails. The list mixes chat / embedding / vision models — the row's
  // "Test connection" button is the final guard against picking a non-chat
  // model.
  const [liveNvidiaModels, setLiveNvidiaModels] = useState<string[] | null>(null);
  const [nvidiaFilter, setNvidiaFilter] = useState("");
  useEffect(() => {
    if (provider !== "nvidia" || !expanded || liveNvidiaModels !== null) return;
    let cancelled = false;
    fetch("/api/config/llm/nvidia/models")
      .then((r) => r.json())
      .then((d: { ok: boolean; models?: string[] }) => {
        if (cancelled) return;
        setLiveNvidiaModels(d.ok && d.models && d.models.length > 0 ? d.models : []);
      })
      .catch(() => {
        if (!cancelled) setLiveNvidiaModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, expanded, liveNvidiaModels]);

  const knownModels =
    provider === "nvidia" && liveNvidiaModels && liveNvidiaModels.length > 0
      ? liveNvidiaModels
      : MODELS[provider];
  const isCustomModel = currentModel && !knownModels.includes(currentModel);
  const [modelChoice, setModelChoice] = useState<string>(
    isCustomModel ? "custom" : currentModel || knownModels[0]!,
  );
  const [customModel, setCustomModel] = useState<string>(isCustomModel ? currentModel : "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(currentBaseUrl);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setModelChoice(isCustomModel ? "custom" : currentModel || knownModels[0]!);
    setCustomModel(isCustomModel ? currentModel : "");
    setBaseUrl(currentBaseUrl);
  }, [currentModel, currentBaseUrl, isCustomModel, knownModels]);

  const filteredModels =
    provider === "nvidia" && nvidiaFilter.trim()
      ? knownModels.filter((m) =>
          m.toLowerCase().includes(nvidiaFilter.trim().toLowerCase()),
        )
      : knownModels;

  const resolveModel = () => (modelChoice === "custom" ? customModel : modelChoice);

  const handleSaveModel = async () => {
    const m = resolveModel();
    if (!m) return;
    setSaving(true);
    const r = await data.setLLMModel(provider, m);
    onToast(r.message, r.ok ? "ok" : "warn");
    setSaving(false);
  };

  const handleSaveKey = async () => {
    if (!apiKey) return;
    setSaving(true);
    const r = await data.setLLMApiKey(provider, apiKey);
    if (r.ok) setApiKey("");
    onToast(r.message, r.ok ? "ok" : "warn");
    setSaving(false);
  };

  const handleSaveBaseUrl = async () => {
    setSaving(true);
    const r = await data.setOllamaBaseUrl(baseUrl.trim());
    onToast(r.message, r.ok ? "ok" : "warn");
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await data.testProvider(provider);
    setTestResult({ ok: r.ok, text: r.message });
    setTesting(false);
  };

  return (
    <div className="v2-set__provider" data-primary={isPrimary}>
      <button type="button" className="v2-set__provider-head" onClick={onToggleExpanded}>
        <Icon
          icon={ChevronRight}
          size="sm"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform var(--dur-fast) var(--ease-out)",
            color: "var(--ink-3)",
          }}
        />
        <span className={"v2-set__dot " + (hasKey ? "v2-set__dot--ok" : "")} />
        <span className="v2-set__provider-name">{LLM_PROVIDER_LABELS[provider]}</span>
        {currentModel && (
          <span className="v2-set__chip">{currentModel}</span>
        )}
        {isPrimary && <span className="v2-set__chip v2-set__chip--accent">PRIMARY</span>}
        {isFallback && !isPrimary && <span className="v2-set__chip">FALLBACK</span>}
      </button>

      {expanded && (
        <div className="v2-set__provider-fields">
          {provider === "ollama" && (
            <div className="v2-set__field">
              <label className="v2-set__field-label">Base URL</label>
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <input
                  className="v2-set__input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                />
                <button
                  type="button"
                  className="v2-set__btn"
                  onClick={() => setBaseUrl("http://localhost:11434")}
                  disabled={saving}
                  title="Fill in the default localhost URL"
                >
                  Default
                </button>
                <button
                  type="button"
                  className="v2-set__btn"
                  onClick={handleSaveBaseUrl}
                  disabled={saving}
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {provider !== "ollama" && (
            <div className="v2-set__field">
              <label className="v2-set__field-label">API Key</label>
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <input
                  className="v2-set__input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={hasKey ? "Stored — leave empty to keep" : "Enter API key"}
                />
                <button
                  type="button"
                  className="v2-set__btn"
                  onClick={handleSaveKey}
                  disabled={saving || !apiKey}
                >
                  Save
                </button>
              </div>
              <p className="v2-set__hint">
                Keys are stored in the keychain and never echoed back. Voice never sets keys —
                use this field directly.
              </p>
            </div>
          )}

          {provider === "nvidia" && (
            <div className="v2-set__field">
              <label className="v2-set__field-label">
                Filter models
                <span style={{ color: "var(--ink-3)", marginLeft: "var(--s-2)" }}>
                  ({knownModels.length} from NVIDIA catalog)
                </span>
              </label>
              <input
                className="v2-set__input"
                value={nvidiaFilter}
                onChange={(e) => setNvidiaFilter(e.target.value)}
                placeholder="e.g. llama, mistral, gemma"
              />
              <p className="v2-set__hint">
                Catalog mixes chat, embedding and vision models. Use Test
                connection to confirm the chosen model supports chat.
              </p>
            </div>
          )}

          <div className="v2-set__field">
            <label className="v2-set__field-label">Model</label>
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              <select
                className="v2-set__select"
                value={modelChoice}
                onChange={(e) => setModelChoice(e.target.value)}
                style={{ flex: 1 }}
              >
                {filteredModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {provider === "nvidia" && filteredModels.length === 0 && (
                  <option value="" disabled>
                    No models match "{nvidiaFilter}"
                  </option>
                )}
                <option value="custom">Custom…</option>
              </select>
              {modelChoice === "custom" && (
                <input
                  className="v2-set__input"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="model id"
                  style={{ flex: 1 }}
                />
              )}
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                onClick={handleSaveModel}
                disabled={saving}
              >
                Save model
              </button>
            </div>
          </div>

          <div className="v2-set__provider-actions">
            <button
              type="button"
              className="v2-set__btn"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? "Testing…" : "Test connection"}
            </button>
            {testResult && (
              <span className="v2-set__test-result" data-ok={testResult.ok}>
                {testResult.text}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
