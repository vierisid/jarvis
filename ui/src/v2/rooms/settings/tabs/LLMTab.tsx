import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { confirmDialog } from "../../../ui/ConfirmDialog";
import { Icon } from "../../../ui";
import {
  KEY_BASED_KINDS,
  LLM_PROVIDER_KIND_LABELS,
  LLM_PROVIDER_KINDS,
  OPTIONAL_KEY_KINDS,
  OPTIONAL_BASE_URL_KINDS,
  URL_BASED_KINDS,
  type LLMConfigProviderView,
  type LLMProviderKind,
  type LLMTier,
  type SettingsHook,
  parseModelRef,
} from "../useSettingsData";

/**
 * Curated model lists per provider class. Each key is a kind (not a name)
 * so multiple instances of the same kind share the same dropdown. Empty
 * arrays mean "type any model id" (OpenAI-compatible gateways). OmniRoute's
 * routes are loaded live because its catalog includes user-defined combos.
 */
const MODELS_BY_KIND: Record<LLMProviderKind, string[]> = {
  anthropic: [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    // API model ids ONLY — not ChatGPT product labels. Reasoning ("thinking")
    // is a request param (reasoning.effort), not a separate "-thinking" model,
    // so ids like "gpt-5.4-thinking"/"gpt-5.3-instant" 404 as model_not_found.
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5-mini",
    "gpt-5-nano",
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
    "openai/gpt-5.4",
    "openai/o3",
    "google/gemini-2.5-pro",
    "deepseek/deepseek-r1",
    "meta-llama/llama-4-maverick",
    "mistralai/mistral-large",
  ],
  nvidia: [
    "meta/llama-3.3-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "google/gemma-2-2b-it",
  ],
  openai_compatible: [],
  litellm: [],
  omniroute: [],
};

const DEFAULT_BASE_URLS: Partial<Record<LLMProviderKind, string>> = {
  ollama: "http://localhost:11434",
  openai_compatible: "http://localhost:8080/v1",
  litellm: "http://localhost:4000/v1",
  omniroute: "http://localhost:20128/v1",
};

/**
 * Two ways the system can be configured:
 *  - "single"     : one model handles everything. `llm.default` set, no tier
 *                   entries. The classic orchestrator runs.
 *  - "multi-tier" : a thin conv LLM owns dialogue and delegates work to
 *                   heavier task models (low/medium/high). Router-first
 *                   architecture; activated by any tier being set.
 *
 * The mode is a persisted choice (`llm.mode`), NOT inferred from tier
 * presence. Storing it explicitly is what lets the selection survive a tab
 * switch / reload before any tier model is picked, and lets the user flip
 * back to single at any time. Switching multi -> single also clears every
 * tier atomically so router-first stays off and no stale tier config lingers;
 * the `default` model stays put as the fall-up fallback. Runtime routing
 * still activates router-first only when tiers.conversation is set, so this
 * UI choice never silently changes behaviour on its own.
 */
type Mode = "single" | "multi-tier";

export function LLMTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const llm = data.llm;
  const [switching, setSwitching] = useState(false);

  // Read the installed Ollama models once for the whole tab. Every
  // ModelSelector below (single mode, four tiers, fallback) shares this
  // one fetch instead of each firing its own.
  const ollamaModels = useOllamaModels(
    Object.values(llm?.providers ?? {}).some((p) => p.kind === "ollama"),
  );
  const providerCatalogs = useLiveProviderCatalogs(llm?.providers ?? {});

  if (!llm) return <div className="v2-set__empty">Loading LLM config...</div>;

  // The mode comes straight from the backend (persisted), so it's the single
  // source of truth for which section renders. No local mirror state.
  const mode: Mode = llm.mode;

  const switchMode = async (next: Mode) => {
    if (mode === next || switching) return;
    setSwitching(true);
    try {
      const r = await data.setLLMMode(next);
      onToast(r.message, r.ok ? "ok" : "warn");
    } finally {
      setSwitching(false);
    }
  };
  const switchToSingle = () => switchMode("single");
  const switchToMulti = () => switchMode("multi-tier");

  return (
    <div>
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">How should Jarvis think?</h3>
            <div className="v2-set__section-sub">
              Pick the architecture that drives chat and background work.
              You can switch any time.
            </div>
          </div>
        </div>
        <ModeChooser
          mode={mode}
          switching={switching}
          onSingle={switchToSingle}
          onMulti={switchToMulti}
        />
      </section>

      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Providers</h3>
            <div className="v2-set__section-sub">
              Configure credentials once per provider. Models are picked below.
            </div>
          </div>
        </div>
        <ProvidersList data={data} onToast={onToast} />
      </section>

      {mode === "single" ? (
        <SingleModelSection data={data} onToast={onToast} ollamaModels={ollamaModels} providerCatalogs={providerCatalogs} />
      ) : (
        <MultiTierSection data={data} onToast={onToast} ollamaModels={ollamaModels} providerCatalogs={providerCatalogs} />
      )}
    </div>
  );
}

function ModeChooser({
  mode,
  switching,
  onSingle,
  onMulti,
}: {
  mode: Mode;
  switching: boolean;
  onSingle: () => void;
  onMulti: () => void;
}) {
  return (
    <div className="v2-set__mode" role="radiogroup" aria-label="LLM mode">
      <button
        type="button"
        role="radio"
        aria-checked={mode === "single"}
        className="v2-set__mode-card"
        data-active={mode === "single"}
        onClick={onSingle}
        disabled={switching}
      >
        <div className="v2-set__mode-title">Single LLM</div>
        <div className="v2-set__mode-sub">
          One model handles user chat AND background work. Simplest, cheapest
          to wire, fewer moving parts. Recommended default.
        </div>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "multi-tier"}
        className="v2-set__mode-card"
        data-active={mode === "multi-tier"}
        onClick={onMulti}
        disabled={switching}
      >
        <div className="v2-set__mode-title">Multi-tier (router-first)</div>
        <div className="v2-set__mode-sub">
          A small fast model owns dialogue and delegates work to heavier
          task models in the background. Better at long-running tasks; needs
          more setup.
        </div>
      </button>
    </div>
  );
}

// ─── Providers list ────────────────────────────────────────────────────────

function ProvidersList({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const llm = data.llm!;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);

  const names = Object.keys(llm.providers).sort();

  return (
    <div>
      {names.length === 0 && !adding && (
        <div className="v2-set__empty">No providers configured yet.</div>
      )}

      {names.map((name) => (
        <ProviderRow
          key={name}
          name={name}
          entry={llm.providers[name]!}
          data={data}
          onToast={onToast}
          expanded={!!expanded[name]}
          onToggleExpanded={() =>
            setExpanded((s) => ({ ...s, [name]: !s[name] }))
          }
        />
      ))}

      {adding ? (
        <NewProviderRow
          existing={names}
          data={data}
          onToast={onToast}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          className="v2-set__btn"
          style={{ marginTop: "var(--s-3)" }}
          onClick={() => setAdding(true)}
        >
          <Icon icon={Plus} size={14} /> Add provider
        </button>
      )}
    </div>
  );
}

/** Match the daemon's base_url comparison: trim plus trailing-slash strip. */
const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

function ProviderRow({
  name,
  entry,
  data,
  onToast,
  expanded,
  onToggleExpanded,
}: {
  name: string;
  entry: LLMConfigProviderView;
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const usesUrl = URL_BASED_KINDS.has(entry.kind);
  const optionalUrl = OPTIONAL_BASE_URL_KINDS.has(entry.kind);
  const usesKey = KEY_BASED_KINDS.has(entry.kind);
  const needsKey = usesKey && !OPTIONAL_KEY_KINDS.has(entry.kind);
  const configured = (!usesUrl || !!entry.base_url?.trim()) && (!needsKey || entry.has_api_key);

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(entry.base_url ?? "");
  const [customEndpoint, setCustomEndpoint] = useState(optionalUrl && Boolean(entry.base_url));
  const supportsUrl = usesUrl || (optionalUrl && customEndpoint);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; models?: string[] } | null>(null);
  // The daemon scopes a stored credential to its saved endpoint and refuses
  // any base_url move without the credential re-entered — including a revert
  // to the official endpoint. Mirror that rule here so the user is told
  // before Test/Save bounce off it.
  const effectiveBaseUrl = supportsUrl ? normalizeBaseUrl(baseUrl) : "";
  const endpointChanged = (usesUrl || optionalUrl)
    && entry.has_api_key
    && effectiveBaseUrl !== normalizeBaseUrl(entry.base_url ?? "");

  useEffect(() => {
    setBaseUrl(entry.base_url ?? "");
    setCustomEndpoint(optionalUrl && Boolean(entry.base_url));
  }, [entry.base_url, optionalUrl]);

  // A test verdict describes the inputs it ran with — editing any of them
  // invalidates it (mirrors the onboarding wizard).
  useEffect(() => { setTestResult(null); }, [apiKey, baseUrl, customEndpoint]);

  return (
    <div className={"v2-set__provider-row " + (expanded ? "v2-set__provider-row--open" : "")}>
      <button
        type="button"
        className="v2-set__row-head"
        onClick={onToggleExpanded}
      >
        <span className="v2-set__row-name">
          {name}{" "}
          <span className="v2-set__chip" style={{ marginLeft: 6 }}>
            kind: {LLM_PROVIDER_KIND_LABELS[entry.kind]}
          </span>
        </span>
        <span className="v2-set__row-state">
          {configured ? (
            <span className="v2-set__chip v2-set__chip--ok">configured</span>
          ) : (
            <span className="v2-set__chip">not set</span>
          )}
          <Icon icon={ChevronRight} size={14} />
        </span>
      </button>

      {expanded && (
        <div className="v2-set__row-body">
          {usesKey && (
            <div className="v2-set__field">
              <label className="v2-set__field-label">
                {entry.kind === "anthropic" && customEndpoint ? "Auth token" : `API key${needsKey ? "" : " (optional)"}`}
              </label>
              <input
                type="password"
                className="v2-set__input"
                placeholder={entry.has_api_key ? "•••• stored ••••" : "paste key here"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          )}
          {optionalUrl && (
            <label className="v2-set__toggle-row">
              <button
                type="button"
                className="v2-set__toggle"
                data-checked={customEndpoint}
                aria-checked={customEndpoint}
                role="switch"
                onClick={() => {
                  setCustomEndpoint((enabled) => !enabled);
                  setBaseUrl("");
                  setTestResult(null);
                }}
              />
              <span>Use a custom Anthropic endpoint</span>
            </label>
          )}
          {supportsUrl && (
            <div className="v2-set__field">
              <label className="v2-set__field-label">
                {optionalUrl ? "Custom endpoint URL" : "Base URL"}
              </label>
              <input
                type="text"
                className="v2-set__input"
                placeholder={entry.kind === "anthropic" ? "https://gateway.example.com" : (DEFAULT_BASE_URLS[entry.kind] ?? "https://gateway.example/v1")}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              {entry.kind === "anthropic" && (
                <div className="v2-set__hint">
                  Jarvis appends /v1/messages and authenticates with the token above.
                </div>
              )}
            </div>
          )}

          <div className="v2-set__row-actions" style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
            <button
              type="button"
              className="v2-set__btn"
              disabled={testing
                || (customEndpoint && !baseUrl.trim())
                || (endpointChanged && !apiKey)}
              onClick={async () => {
                setTesting(true);
                setTestResult(null);
                const r = await data.testProvider(name, {
                  kind: entry.kind,
                  apiKey: apiKey || undefined,
                  baseUrl: optionalUrl
                    ? (customEndpoint ? baseUrl : "")
                    : (baseUrl || undefined),
                });
                setTestResult({ ok: r.ok, text: r.message, models: r.models });
                setTesting(false);
              }}
            >
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button
              type="button"
              className="v2-set__btn v2-set__btn--primary"
              disabled={saving
                || (customEndpoint && !baseUrl.trim())
                || (endpointChanged && !apiKey)
                || (!apiKey && baseUrl === (entry.base_url ?? ""))}
              onClick={async () => {
                setSaving(true);
                const input: { kind?: LLMProviderKind; api_key?: string; base_url?: string } = {};
                if (apiKey) input.api_key = apiKey;
                if (usesUrl || optionalUrl) input.base_url = supportsUrl ? baseUrl : "";
                const r = await data.upsertProvider(name, input);
                onToast(r.message, r.ok ? "ok" : "warn");
                if (r.ok) setApiKey("");
                setSaving(false);
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="v2-set__btn v2-set__btn--danger"
              style={{ marginLeft: "auto" }}
              onClick={async () => {
                if (!await confirmDialog(`Remove provider '${name}'? This deletes the stored API key.`)) return;
                const r = await data.removeProvider(name);
                onToast(r.message, r.ok ? "ok" : "warn");
              }}
            >
              <Icon icon={Trash2} size={14} /> Remove
            </button>
          </div>

          {endpointChanged && !apiKey && (
            <div className="v2-set__hint v2-set__hint--warn">
              Enter the API key or auth token again before testing or saving a changed endpoint URL.
            </div>
          )}

          {testResult && <ProviderTestResult result={testResult} />}
        </div>
      )}
    </div>
  );
}

function NewProviderRow({
  existing,
  data,
  onToast,
  onDone,
}: {
  existing: string[];
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LLMProviderKind>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [customEndpoint, setCustomEndpoint] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; models?: string[] } | null>(null);
  const [saving, setSaving] = useState(false);

  const usesUrl = URL_BASED_KINDS.has(kind);
  const optionalUrl = OPTIONAL_BASE_URL_KINDS.has(kind);
  const supportsUrl = usesUrl || (optionalUrl && customEndpoint);
  const usesKey = KEY_BASED_KINDS.has(kind);
  const needsKey = usesKey && !OPTIONAL_KEY_KINDS.has(kind);
  // Suggest name = kind unless user typed something
  const effectiveName = name.trim() || kind;
  const duplicate = existing.includes(effectiveName);

  return (
    <div className="v2-set__provider-row v2-set__provider-row--open">
      <div className="v2-set__row-body">
        <div className="v2-set__provider-grid">
          <div className="v2-set__field">
            <label className="v2-set__field-label">Provider kind</label>
            <select
              className="v2-set__select"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as LLMProviderKind);
                setBaseUrl("");
                setCustomEndpoint(false);
                setTestResult(null);
              }}
            >
              {LLM_PROVIDER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LLM_PROVIDER_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

        <div className="v2-set__field">
          <label className="v2-set__field-label">
            Name <span style={{ opacity: 0.6 }}>(how you reference this in model strings)</span>
          </label>
          <input
            type="text"
            className="v2-set__input"
            placeholder={kind}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {duplicate && (
            <div className="v2-set__hint v2-set__hint--warn">
              A provider named &quot;{effectiveName}&quot; already exists. Pick a different name.
            </div>
          )}
        </div>

        {optionalUrl && (
          <label className="v2-set__toggle-row v2-set__provider-grid-wide">
            <button
              type="button"
              className="v2-set__toggle"
              data-checked={customEndpoint}
              aria-checked={customEndpoint}
              role="switch"
              onClick={() => {
                setCustomEndpoint((enabled) => !enabled);
                setBaseUrl("");
                setTestResult(null);
              }}
            />
            <span>Use a custom Anthropic endpoint</span>
          </label>
        )}

        {usesKey && (
          <div className="v2-set__field">
            <label className="v2-set__field-label">
              {kind === "anthropic" && customEndpoint ? "Auth token" : `API key${needsKey ? "" : " (optional)"}`}
            </label>
            <input
              type="password"
              className="v2-set__input"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        )}
        {supportsUrl && (
          <div className="v2-set__field">
            <label className="v2-set__field-label">
              {optionalUrl ? "Custom endpoint URL" : "Base URL"}
            </label>
            <input
              type="text"
              className="v2-set__input"
              placeholder={kind === "anthropic" ? "https://gateway.example.com" : (DEFAULT_BASE_URLS[kind] ?? "https://gateway.example/v1")}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {kind === "anthropic" && (
              <div className="v2-set__hint">
                Jarvis appends /v1/messages and authenticates with the token above.
              </div>
            )}
          </div>
        )}
        </div>

        <div className="v2-set__row-actions" style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
          <button type="button" className="v2-set__btn" onClick={onDone}>
            Cancel
          </button>
          <button
            type="button"
            className="v2-set__btn"
            disabled={testing || duplicate || (usesKey && !apiKey) || (usesUrl && !baseUrl) || (customEndpoint && !baseUrl)}
            onClick={async () => {
              setTesting(true);
              setTestResult(null);
              const result = await data.testProvider(effectiveName, {
                kind,
                apiKey: apiKey || undefined,
                baseUrl: supportsUrl ? baseUrl || undefined : undefined,
              });
              setTestResult({ ok: result.ok, text: result.message, models: result.models });
              setTesting(false);
            }}
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            type="button"
            className="v2-set__btn v2-set__btn--primary"
            disabled={saving || duplicate || (needsKey && !apiKey) || (usesUrl && !baseUrl) || (customEndpoint && !baseUrl)}
            onClick={async () => {
              setSaving(true);
              const input: { kind: LLMProviderKind; api_key?: string; base_url?: string } = { kind };
              if (apiKey) input.api_key = apiKey;
              if (baseUrl) input.base_url = baseUrl;
              const r = await data.upsertProvider(effectiveName, input);
              onToast(r.message, r.ok ? "ok" : "warn");
              setSaving(false);
              if (r.ok) onDone();
            }}
          >
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
        {testResult && (
          <ProviderTestResult result={testResult} />
        )}
      </div>
    </div>
  );
}

function ProviderTestResult({
  result,
}: {
  result: { ok: boolean; text: string; models?: string[] };
}) {
  return (
    <div className={"v2-set__provider-test " + (result.ok ? "v2-set__provider-test--ok" : "v2-set__provider-test--warn")}>
      <div>{result.text}</div>
      {result.ok && result.models && result.models.length > 0 && (
        <div className="v2-set__provider-models" aria-label="Models discovered">
          {result.models.map((model) => (
            <span className="v2-set__chip" key={model}>{model}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// Single LLM mode: one model picker

function SingleModelSection({
  data,
  onToast,
  ollamaModels,
  providerCatalogs,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  ollamaModels: string[] | null;
  providerCatalogs: Record<string, string[]>;
}) {
  const llm = data.llm!;

  return (
    <section className="v2-set__section">
      <div className="v2-set__section-head">
        <div>
          <h3 className="v2-set__section-title">Model</h3>
          <div className="v2-set__section-sub">
            Pick one model. The system uses it for everything.
          </div>
        </div>
      </div>

      <ModelSelector
        label="Default model"
        value={llm.default}
        providers={llm.providers}
        ollamaModels={ollamaModels}
        providerCatalogs={providerCatalogs}
        onChange={async (ref) => {
          const r = await data.setDefaultModel(ref);
          onToast(r.message, r.ok ? "ok" : "warn");
        }}
      />
    </section>
  );
}

// Multi-tier mode: per-tier model pickers + a fallback default.

function MultiTierSection({
  data,
  onToast,
  ollamaModels,
  providerCatalogs,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  ollamaModels: string[] | null;
  providerCatalogs: Record<string, string[]>;
}) {
  const llm = data.llm!;

  const TIERS: Array<{ id: LLMTier; label: string; sub: string }> = [
    {
      id: "conversation",
      label: "Conversation",
      sub: "Thin LLM that owns dialogue and routes work to the task tiers.",
    },
    {
      id: "high",
      label: "High intelligence",
      sub: "Complex reasoning, planning, deep code work.",
    },
    {
      id: "medium",
      label: "Medium intelligence",
      sub: "General tool use, workflow orchestration, structured tasks.",
    },
    {
      id: "low",
      label: "Low intelligence",
      sub: "Classification, summarization, fast cheap calls (voice intent, extractor).",
    },
  ];

  return (
    <section className="v2-set__section">
      <div className="v2-set__section-head">
        <div>
          <h3 className="v2-set__section-title">Per-tier models</h3>
          <div className="v2-set__section-sub">
            Different models for different jobs. Tiers without an explicit
            model fall up: low -&gt; medium -&gt; high. The default below acts
            as the fallback when no tier matches.
          </div>
        </div>
      </div>

      {TIERS.map((t) => (
        <div key={t.id} className="v2-set__field">
          <ModelSelector
            label={t.label}
            sub={t.sub}
            value={llm.tiers[t.id]}
            providers={llm.providers}
            ollamaModels={ollamaModels}
            providerCatalogs={providerCatalogs}
            allowClear
            onChange={async (ref) => {
              const r = await data.setTierModel(t.id, ref);
              onToast(r.message, r.ok ? "ok" : "warn");
            }}
          />
        </div>
      ))}

      <div className="v2-set__field" style={{ marginTop: "var(--s-4)" }}>
        <h4 className="v2-set__section-title">Default (fallback)</h4>
        <div className="v2-set__section-sub" style={{ marginBottom: "var(--s-2)" }}>
          Used when a tier has no explicit model and the fall-up chain has nothing either.
        </div>
        <ModelSelector
          label=""
          value={llm.default}
          providers={llm.providers}
          ollamaModels={ollamaModels}
          providerCatalogs={providerCatalogs}
          allowClear
          onChange={async (ref) => {
            const r = await data.setDefaultModel(ref);
            onToast(r.message, r.ok ? "ok" : "warn");
          }}
        />
      </div>
    </section>
  );
}

// ─── Model selector (provider + model dropdowns) ───────────────────────────

function ModelSelector({
  label,
  sub,
  value,
  providers,
  ollamaModels,
  providerCatalogs,
  allowClear,
  onChange,
}: {
  label: string;
  sub?: string;
  value: string | null;
  providers: Record<string, LLMConfigProviderView>;
  /** Installed Ollama models, fetched once by LLMTab and shared here. */
  ollamaModels: string[] | null;
  /** Live model/route catalogs keyed by configured provider name. */
  providerCatalogs: Record<string, string[]>;
  allowClear?: boolean;
  onChange: (ref: string | null) => void;
}) {
  const parsed = useMemo(() => parseModelRef(value), [value]);
  const providerNames = Object.keys(providers).sort();

  const [selectedProvider, setSelectedProvider] = useState<string>(
    parsed?.provider ?? providerNames[0] ?? "",
  );
  const [selectedModel, setSelectedModel] = useState<string>(parsed?.model ?? "");
  const [customModel, setCustomModel] = useState<string>(
    parsed?.model && !providerModels(providers, parsed.provider, ollamaModels, providerCatalogs).includes(parsed.model)
      ? parsed.model
      : "",
  );

  // Sync local state when the backing config changes (e.g. after a save).
  useEffect(() => {
    if (parsed) {
      setSelectedProvider(parsed.provider);
      const known = providerModels(providers, parsed.provider, ollamaModels, providerCatalogs);
      if (known.includes(parsed.model)) {
        setSelectedModel(parsed.model);
        setCustomModel("");
      } else {
        setSelectedModel("__custom__");
        setCustomModel(parsed.model);
      }
    } else {
      // Value cleared (e.g. allowClear button). Reset the model selection
      // so the UI doesn't keep showing a stale picked model after the
      // backing config returns null.
      setSelectedModel("");
      setCustomModel("");
    }
    // `ollamaModels` participates: until the live catalog lands, a tagged id
    // looks unknown and would be parked in the custom field. Re-run when it
    // arrives so the dropdown snaps to the real entry.
  }, [value, ollamaModels, providerCatalogs]);

  const models = providerModels(providers, selectedProvider, ollamaModels, providerCatalogs);
  const usesCustomOnly = models.length === 0;
  const effectiveModel = selectedModel === "__custom__" ? customModel.trim() : selectedModel;

  const commit = (provider: string, model: string) => {
    if (!provider || !model) return;
    onChange(`${provider}:${model}`);
  };

  if (providerNames.length === 0) {
    return (
      <div>
        {label && <label className="v2-set__field-label">{label}</label>}
        {sub && <div className="v2-set__section-sub">{sub}</div>}
        <div className="v2-set__hint v2-set__hint--warn">
          No providers configured. Add one above first.
        </div>
      </div>
    );
  }

  return (
    <div>
      {label && <label className="v2-set__field-label">{label}</label>}
      {sub && <div className="v2-set__section-sub" style={{ marginBottom: "var(--s-2)" }}>{sub}</div>}
      <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
        <select
          className="v2-set__select"
          value={selectedProvider}
          onChange={(e) => {
            const next = e.target.value;
            setSelectedProvider(next);
            // Reset model when provider changes - the model list is now different.
            const nextModels = providerModels(providers, next, ollamaModels, providerCatalogs);
            const defaultModel = nextModels[0] ?? "__custom__";
            setSelectedModel(defaultModel);
            setCustomModel("");
            if (defaultModel !== "__custom__") {
              commit(next, defaultModel);
            }
          }}
          style={{ flex: "0 0 auto", minWidth: 140 }}
        >
          {providerNames.map((n) => (
            <option key={n} value={n}>
              {n} ({LLM_PROVIDER_KIND_LABELS[providers[n]!.kind]})
            </option>
          ))}
        </select>

        {usesCustomOnly ? (
          <input
            type="text"
            className="v2-set__input"
            placeholder="model id"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onBlur={() => customModel && commit(selectedProvider, customModel.trim())}
            style={{ flex: "1 1 200px" }}
          />
        ) : (
          <select
            className="v2-set__select"
            value={selectedModel || models[0] || "__custom__"}
            onChange={(e) => {
              const next = e.target.value;
              setSelectedModel(next);
              if (next !== "__custom__") {
                commit(selectedProvider, next);
              }
            }}
            style={{ flex: "1 1 200px" }}
          >
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            <option value="__custom__">Custom…</option>
          </select>
        )}

        {selectedModel === "__custom__" && !usesCustomOnly && (
          <input
            type="text"
            className="v2-set__input"
            placeholder="model id"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onBlur={() => customModel && commit(selectedProvider, customModel.trim())}
            style={{ flex: "1 1 200px" }}
          />
        )}

        {allowClear && value && (
          <button
            type="button"
            className="v2-set__btn"
            onClick={() => onChange(null)}
          >
            Clear
          </button>
        )}
      </div>
      {effectiveModel && (
        <div className="v2-set__hint" style={{ marginTop: "var(--s-2)" }}>
          Saved as <code>{selectedProvider}:{effectiveModel}</code>
        </div>
      )}
    </div>
  );
}

function providerModels(
  providers: Record<string, LLMConfigProviderView>,
  name: string,
  live?: string[] | null,
  providerCatalogs: Record<string, string[]> = {},
): string[] {
  const entry = providers[name];
  if (!entry) return [];
  // Ollama only serves what the operator pulled, and every id carries a tag.
  // The curated list is untagged guesswork, so prefer the real catalog when
  // the daemon could read it; fall back to the guesses when it could not.
  if (entry.kind === "ollama" && live && live.length > 0) return live;
  if (entry.kind === "omniroute" && providerCatalogs[name]?.length) {
    return providerCatalogs[name]!;
  }
  return MODELS_BY_KIND[entry.kind] ?? [];
}

/**
 * Installed Ollama models, read from the daemon once per mount. `null` while
 * in flight or when the provider isn't Ollama; `[]` when Ollama was
 * unreachable (callers then fall back to the curated list).
 */
function useOllamaModels(enabled: boolean): string[] | null {
  const [models, setModels] = useState<string[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/config/llm/ollama/models")
      .then((r) => r.json())
      .then((d: { ok: boolean; models?: string[] }) => {
        if (!cancelled) setModels(d.ok && d.models ? d.models : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return models;
}

/** Load volatile catalogs for gateways/providers whose IDs change frequently. */
function useLiveProviderCatalogs(
  providers: Record<string, LLMConfigProviderView>,
): Record<string, string[]> {
  const targets = Object.entries(providers)
    .filter(([, entry]) => entry.kind === "omniroute")
    .map(([name, entry]) => ({
      name,
      baseUrl: entry.base_url?.trim() || "http://localhost:20128/v1",
      hasApiKey: entry.has_api_key,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const signature = JSON.stringify(targets);
  const names = targets.map((target) => target.name);
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (names.length === 0) {
      setCatalogs({});
      return;
    }
    let cancelled = false;
    Promise.all(names.map(async (name) => {
      try {
        const response = await fetch('/api/config/llm/omniroute/models', {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await response.json() as { ok: boolean; models?: string[] };
        return [name, data.ok && data.models ? data.models : []] as const;
      } catch {
        return [name, []] as const;
      }
    })).then((entries) => {
      if (!cancelled) setCatalogs(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [signature]); // names are represented by the stable signature

  return catalogs;
}
