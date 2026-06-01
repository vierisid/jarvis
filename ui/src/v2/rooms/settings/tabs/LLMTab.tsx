import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Plus, Trash2, ChevronLeft } from "lucide-react";
import { Icon } from "../../../ui";
import {
  KEY_BASED_KINDS,
  LLM_PROVIDER_KIND_LABELS,
  LLM_PROVIDER_KINDS,
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
 * arrays mean "type any model id" (openai_compatible / litellm proxies).
 */
const MODELS_BY_KIND: Record<LLMProviderKind, string[]> = {
  anthropic: [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-thinking",
    "gpt-5.4-pro",
    "gpt-5.3-instant",
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
};

type Mode = "basic" | "advanced";

export function LLMTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const llm = data.llm;
  const [mode, setMode] = useState<Mode>("basic");

  // Auto-switch to advanced when ANY tier is configured. Users in classic
  // single-LLM mode (just `default` set) start in basic.
  useEffect(() => {
    if (!llm) return;
    const anyTier =
      llm.tiers.conversation ||
      llm.tiers.high ||
      llm.tiers.medium ||
      llm.tiers.low;
    if (anyTier) setMode("advanced");
  }, [llm?.tiers.conversation, llm?.tiers.high, llm?.tiers.medium, llm?.tiers.low]);

  if (!llm) return <div className="v2-set__empty">Loading LLM config…</div>;

  return (
    <div>
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

      {mode === "basic" ? (
        <BasicModelSection data={data} onToast={onToast} onAdvanced={() => setMode("advanced")} />
      ) : (
        <AdvancedTiersSection data={data} onToast={onToast} onBack={() => setMode("basic")} />
      )}
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
  const usesKey = KEY_BASED_KINDS.has(entry.kind);
  const configured = usesUrl ? !!entry.base_url : entry.has_api_key;

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(entry.base_url ?? "");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setBaseUrl(entry.base_url ?? "");
  }, [entry.base_url]);

  return (
    <div className={"v2-set__row " + (expanded ? "v2-set__row--open" : "")}>
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
              <label className="v2-set__field-label">API key</label>
              <input
                type="password"
                className="v2-set__input"
                placeholder={entry.has_api_key ? "•••• stored ••••" : "paste key here"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          )}
          {usesUrl && (
            <div className="v2-set__field">
              <label className="v2-set__field-label">Base URL</label>
              <input
                type="text"
                className="v2-set__input"
                placeholder="http://localhost:11434"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
          )}

          <div className="v2-set__row-actions" style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
            <button
              type="button"
              className="v2-set__btn"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                setTestResult(null);
                const r = await data.testProvider(name, {
                  kind: entry.kind,
                  apiKey: apiKey || undefined,
                  baseUrl: baseUrl || undefined,
                });
                setTestResult({ ok: r.ok, text: r.message });
                setTesting(false);
              }}
            >
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button
              type="button"
              className="v2-set__btn v2-set__btn--primary"
              disabled={saving || (!apiKey && baseUrl === (entry.base_url ?? ""))}
              onClick={async () => {
                setSaving(true);
                const input: { kind?: LLMProviderKind; api_key?: string; base_url?: string } = {};
                if (apiKey) input.api_key = apiKey;
                if (usesUrl) input.base_url = baseUrl;
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
                if (!confirm(`Remove provider '${name}'? This deletes the stored API key.`)) return;
                const r = await data.removeProvider(name);
                onToast(r.message, r.ok ? "ok" : "warn");
              }}
            >
              <Icon icon={Trash2} size={14} /> Remove
            </button>
          </div>

          {testResult && (
            <div className={"v2-set__hint " + (testResult.ok ? "v2-set__hint--ok" : "v2-set__hint--warn")}>
              {testResult.text}
            </div>
          )}
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
  const [saving, setSaving] = useState(false);

  const usesUrl = URL_BASED_KINDS.has(kind);
  const usesKey = KEY_BASED_KINDS.has(kind);
  // Suggest name = kind unless user typed something
  const effectiveName = name.trim() || kind;
  const duplicate = existing.includes(effectiveName);

  return (
    <div className="v2-set__row v2-set__row--open">
      <div className="v2-set__row-body">
        <div className="v2-set__field">
          <label className="v2-set__field-label">Provider kind</label>
          <select
            className="v2-set__select"
            value={kind}
            onChange={(e) => setKind(e.target.value as LLMProviderKind)}
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

        {usesKey && (
          <div className="v2-set__field">
            <label className="v2-set__field-label">API key</label>
            <input
              type="password"
              className="v2-set__input"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        )}
        {usesUrl && (
          <div className="v2-set__field">
            <label className="v2-set__field-label">Base URL</label>
            <input
              type="text"
              className="v2-set__input"
              placeholder="http://localhost:11434"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
        )}

        <div className="v2-set__row-actions" style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
          <button type="button" className="v2-set__btn" onClick={onDone}>
            Cancel
          </button>
          <button
            type="button"
            className="v2-set__btn v2-set__btn--primary"
            disabled={saving || duplicate || (usesKey && !apiKey) || (usesUrl && !baseUrl)}
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
      </div>
    </div>
  );
}

// ─── Basic mode: single model picker ───────────────────────────────────────

function BasicModelSection({
  data,
  onToast,
  onAdvanced,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  onAdvanced: () => void;
}) {
  const llm = data.llm!;

  return (
    <section className="v2-set__section">
      <div className="v2-set__section-head">
        <div>
          <h3 className="v2-set__section-title">Model</h3>
          <div className="v2-set__section-sub">
            Pick one model. The system uses it for all work (single-LLM mode).
          </div>
        </div>
      </div>

      <ModelSelector
        label="Default model"
        value={llm.default}
        providers={llm.providers}
        onChange={async (ref) => {
          const r = await data.setDefaultModel(ref);
          onToast(r.message, r.ok ? "ok" : "warn");
        }}
      />

      <button
        type="button"
        className="v2-set__btn"
        style={{ marginTop: "var(--s-3)" }}
        onClick={onAdvanced}
      >
        <Icon icon={ChevronRight} size={14} /> Advanced settings (per-tier models)
      </button>
    </section>
  );
}

// ─── Advanced mode: tier model pickers ─────────────────────────────────────

function AdvancedTiersSection({
  data,
  onToast,
  onBack,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  onBack: () => void;
}) {
  const llm = data.llm!;

  const TIERS: Array<{ id: LLMTier; label: string; sub: string }> = [
    {
      id: "conversation",
      label: "Conversation",
      sub: "Thin LLM that owns dialogue and routes work to the task tiers. Setting this activates router-first mode.",
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
          <h3 className="v2-set__section-title">Advanced — per-tier models</h3>
          <div className="v2-set__section-sub">
            Different models for different jobs. Tiers without an explicit
            model fall up: low → medium → high. The basic default below acts
            as the fallback when no tier is set.
          </div>
        </div>
        <button type="button" className="v2-set__btn" onClick={onBack}>
          <Icon icon={ChevronLeft} size={14} /> Back to basic
        </button>
      </div>

      {TIERS.map((t) => (
        <div key={t.id} className="v2-set__field">
          <ModelSelector
            label={t.label}
            sub={t.sub}
            value={llm.tiers[t.id]}
            providers={llm.providers}
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
  allowClear,
  onChange,
}: {
  label: string;
  sub?: string;
  value: string | null;
  providers: Record<string, LLMConfigProviderView>;
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
    parsed?.model && !providerModels(providers, parsed.provider).includes(parsed.model)
      ? parsed.model
      : "",
  );

  // Sync local state when the backing config changes (e.g. after a save).
  useEffect(() => {
    if (parsed) {
      setSelectedProvider(parsed.provider);
      const known = providerModels(providers, parsed.provider);
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
  }, [value]);

  const models = providerModels(providers, selectedProvider);
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
            const nextModels = providerModels(providers, next);
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
): string[] {
  const entry = providers[name];
  if (!entry) return [];
  return MODELS_BY_KIND[entry.kind] ?? [];
}
