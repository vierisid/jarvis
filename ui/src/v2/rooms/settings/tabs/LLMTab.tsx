import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Plus, RotateCcw, Trash2 } from "lucide-react";
import { confirmDialog } from "../../../ui/ConfirmDialog";
import { Icon } from "../../../ui";
import {
  KEY_BASED_KINDS,
  LLM_PROVIDER_KIND_LABELS,
  LLM_PROVIDER_KINDS,
  OPTIONAL_KEY_KINDS,
  OPTIONAL_BASE_URL_KINDS,
  URL_BASED_KINDS,
  sendsAuthHeader,
  type LLMConfig,
  type LLMConfigProviderView,
  type LLMProviderKind,
  type LLMTier,
  type SettingsHook,
  parseModelRef,
} from "../useSettingsData";

/** Reserved hosted provider name (mirrors the daemon's usejarvis_ai carve-out). */
const USEJARVIS_NAME = "usejarvis_ai";
/** The hosted provider's KIND (mirrors the daemon's USEJARVIS_KIND). Same
 * literal as the name today, but a distinct constant: gates asking "is this
 * entry the hosted provider" compare kinds against this, never kind-vs-name —
 * the two coinciding is an implementation detail, not a contract. */
const USEJARVIS_KIND = "usejarvis_ai";
/** Hosted aliases that ARE chat models — an ALLOWLIST, mirroring the
 * platform's SLOTS_BY_MODALITY.chat. A denylist fails OPEN: the platform's
 * slots are data (a new alias ships without any jarvis release), and
 * `providerModels()[0]` is auto-committed when the provider dropdown changes,
 * so an unknown `uj-*` sorting before `uj-chat` would silently become someone's
 * conversation model. Missing a future CHAT tier here is harmless by
 * comparison — it is simply absent until the next release. */
export const USEJARVIS_TIER_ALIASES: Record<LLMTier, string> = {
  conversation: "uj-chat",
  high: "uj-high",
  medium: "uj-medium",
  low: "uj-low",
};
/** Derived from the tier map so the two cannot drift: every alias a tier can
 * be seeded with is, by construction, an alias the picker offers. */
const CHAT_USEJARVIS_ALIASES = new Set(Object.values(USEJARVIS_TIER_ALIASES));

/**
 * Which model to auto-commit when the provider dropdown changes.
 *
 * Prefers the slot's own alias when the new provider offers it, else the
 * first entry. Extracted so the choice is testable: the hosted catalog sorts
 * alphabetically, so a bare `models[0]` seeds `uj-chat` into EVERY tier and
 * deep reasoning silently runs on the thin conversation model.
 */
export function seedModelForProvider(models: string[], preferredModel?: string): string {
  return (preferredModel && models.includes(preferredModel) ? preferredModel : models[0]) ?? "__custom__";
}

/**
 * Providers offered by the model pickers: the user's editable entries plus,
 * on hosted installs, the system-owned Usejarvis AI provider. The backend
 * hides it from `llm.providers` (its base_url must never reach the client),
 * so the pickers synthesize a credential-free view here — refs like
 * `usejarvis_ai:uj-high` stay selectable.
 */
function pickerProviders(llm: LLMConfig): Record<string, LLMConfigProviderView> {
  if (!llm.hosted_llm) return llm.providers;
  return {
    [USEJARVIS_NAME]: { kind: USEJARVIS_KIND, has_api_key: true },
    ...llm.providers,
  };
}

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
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
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
  // Hosted proxy: the uj-* aliases are key-scoped (per plan), so the real
  // list always comes from the live catalog endpoint.
  usejarvis_ai: [],
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
  // The pickers see the editable providers PLUS the managed hosted one; the
  // live-catalog hook fetches for both (OmniRoute routes, uj-* aliases).
  const allProviders = useMemo(() => (llm ? pickerProviders(llm) : {}), [llm]);
  const catalogState = useLiveProviderCatalogs(allProviders);
  const providerCatalogs = catalogState.catalogs;

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
        <SingleModelSection data={data} onToast={onToast} providers={allProviders} ollamaModels={ollamaModels} providerCatalogs={providerCatalogs} catalogState={catalogState} />
      ) : (
        <MultiTierSection data={data} onToast={onToast} providers={allProviders} ollamaModels={ollamaModels} providerCatalogs={providerCatalogs} catalogState={catalogState} />
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
      {llm.hosted_llm && <ManagedUsejarvisRow />}

      {names.length === 0 && !adding && !llm.hosted_llm && (
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
/**
 * Read-only card for the system-owned hosted provider. Deliberately inert:
 * no key field, no base-url field, no expand, no delete — its config lives
 * in the platform's config.yaml carve-out, which the dashboard can neither
 * see nor change, and nothing from this card ever enters a save POST (the
 * daemon would refuse the reserved name anyway).
 */
function ManagedUsejarvisRow() {
  return (
    <div className="v2-set__row">
      <div className="v2-set__row-head" style={{ cursor: "default" }}>
        <span className="v2-set__row-name">
          {LLM_PROVIDER_KIND_LABELS.usejarvis_ai}{" "}
          <span className="v2-set__chip" style={{ marginLeft: 6 }}>
            included with your plan
          </span>
        </span>
        <span className="v2-set__row-state">
          <span className="v2-set__chip v2-set__chip--ok">managed</span>
        </span>
      </div>
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
  const optionalUrl = OPTIONAL_BASE_URL_KINDS.has(entry.kind);
  const usesKey = KEY_BASED_KINDS.has(entry.kind);
  const needsKey = usesKey && !OPTIONAL_KEY_KINDS.has(entry.kind);
  const configured = (!usesUrl || !!entry.base_url?.trim()) && (!needsKey || entry.has_api_key);

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(entry.base_url ?? "");
  const [authHeader, setAuthHeader] = useState(entry.auth_header ?? "Authorization");
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
  // The header choice only exists for a keyed provider on a custom endpoint.
  // Everywhere else the provider picks its own header, and sending one anyway
  // would override that — so Test and Save must agree on this single gate.
  const sendsHeader = sendsAuthHeader(entry.kind, supportsUrl);
  const authHeaderChanged = sendsHeader
    && authHeader !== (entry.auth_header ?? "Authorization");

  useEffect(() => {
    setBaseUrl(entry.base_url ?? "");
    setCustomEndpoint(optionalUrl && Boolean(entry.base_url));
  }, [entry.base_url, optionalUrl]);

  useEffect(() => {
    setAuthHeader(entry.auth_header ?? "Authorization");
  }, [entry.auth_header]);

  // A test verdict describes the inputs it ran with — editing any of them
  // invalidates it (mirrors the onboarding wizard).
  useEffect(() => { setTestResult(null); }, [apiKey, baseUrl, customEndpoint, authHeader]);

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
          {sendsHeader && (
            <div className="v2-set__field">
              <label className="v2-set__field-label">Authentication header</label>
              <select className="v2-set__select" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)}>
                <option value="Authorization">Authorization: Bearer</option>
                <option value="x-api-key">x-api-key</option>
              </select>
            </div>
          )}

          <div className="v2-set__row-actions">
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
                  ...(sendsHeader ? { authHeader } : {}),
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
                || (!apiKey && baseUrl === (entry.base_url ?? "") && !authHeaderChanged)}
              onClick={async () => {
                setSaving(true);
                const input: { kind?: LLMProviderKind; api_key?: string; base_url?: string; auth_header?: string } = {};
                if (apiKey) input.api_key = apiKey;
                if (usesUrl || optionalUrl) input.base_url = supportsUrl ? baseUrl : "";
                if (sendsHeader) input.auth_header = authHeader;
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
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [customEndpoint, setCustomEndpoint] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; models?: string[] } | null>(null);
  const [saving, setSaving] = useState(false);

  const usesUrl = URL_BASED_KINDS.has(kind);
  const optionalUrl = OPTIONAL_BASE_URL_KINDS.has(kind);
  const supportsUrl = usesUrl || (optionalUrl && customEndpoint);
  const usesKey = KEY_BASED_KINDS.has(kind);
  const needsKey = usesKey && !OPTIONAL_KEY_KINDS.has(kind);
  // Same gate as ProviderRow: only override the provider's own header choice
  // when the user actually had a dropdown to make that choice with.
  const sendsHeader = sendsAuthHeader(kind, supportsUrl);
  // Suggest name = kind unless user typed something
  const effectiveName = name.trim() || kind;
  // The reserved hosted name is blocked like a duplicate: the daemon silently
  // refuses to persist it, so accepting it here would toast a success for a no-op.
  const reserved = effectiveName === USEJARVIS_NAME;
  const duplicate = existing.includes(effectiveName) || reserved;

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
              {reserved
                ? <>&quot;{USEJARVIS_NAME}&quot; is reserved for the hosted provider. Pick a different name.</>
                : <>A provider named &quot;{effectiveName}&quot; already exists. Pick a different name.</>}
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
        {sendsHeader && (
          <div className="v2-set__field">
            <label className="v2-set__field-label">Authentication header</label>
            <select className="v2-set__select" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)}>
              <option value="Authorization">Authorization: Bearer</option>
              <option value="x-api-key">x-api-key</option>
            </select>
          </div>
        )}
        </div>

        <div className="v2-set__row-actions">
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
                ...(sendsHeader ? { authHeader } : {}),
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
              const input: { kind: LLMProviderKind; api_key?: string; base_url?: string; auth_header?: string } = { kind };
              if (apiKey) input.api_key = apiKey;
              if (baseUrl) input.base_url = baseUrl;
              if (sendsHeader) input.auth_header = authHeader;
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
  providers,
  ollamaModels,
  providerCatalogs,
  catalogState,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  providers: Record<string, LLMConfigProviderView>;
  ollamaModels: string[] | null;
  providerCatalogs: Record<string, string[]>;
  catalogState: LiveCatalogState;
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
        providers={providers}
        ollamaModels={ollamaModels}
        providerCatalogs={providerCatalogs}
        catalogState={catalogState}
        allowClear
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
  providers,
  ollamaModels,
  providerCatalogs,
  catalogState,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
  providers: Record<string, LLMConfigProviderView>;
  ollamaModels: string[] | null;
  providerCatalogs: Record<string, string[]>;
  catalogState: LiveCatalogState;
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
            providers={providers}
            ollamaModels={ollamaModels}
            providerCatalogs={providerCatalogs}
            catalogState={catalogState}
            allowClear
            preferredModel={USEJARVIS_TIER_ALIASES[t.id]}
            effectiveHint={llm.effective?.tiers[t.id]}
            clearHint={
              llm.default
                ? { ref: llm.default, source: "default" }
                : llm.hosted_llm
                  ? { ref: `usejarvis_ai:${USEJARVIS_TIER_ALIASES[t.id]}`, source: "plan" }
                  : undefined
            }
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
          {llm.hosted_llm ? (
            <>Fills any tier you leave empty — it takes that slot over your
            plan&apos;s tier default. Clear it to give empty tiers back to the
            plan defaults. Tiers you set explicitly always win.</>
          ) : (
            <>Used when a tier has no explicit model and the fall-up chain has
            nothing either.</>
          )}
        </div>
        <ModelSelector
          label=""
          value={llm.default}
          providers={providers}
          ollamaModels={ollamaModels}
          providerCatalogs={providerCatalogs}
          catalogState={catalogState}
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
  catalogState,
  allowClear,
  preferredModel,
  effectiveHint,
  clearHint,
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
  /** Load state of the live catalogs plus the retry affordance. */
  catalogState?: LiveCatalogState;
  allowClear?: boolean;
  /** Model to seed when the provider changes, if the new provider offers it.
   * Without this the seed is `catalog[0]`, and the hosted catalog sorts
   * alphabetically — so every tier would auto-commit `uj-chat`, silently
   * running deep reasoning on the thin conversation model. */
  preferredModel?: string;
  /** What the daemon actually routes this slot to (from llm.effective) —
   * rendered when no explicit ref is set, so an unset slot shows routing
   * truth instead of a never-persisted `models[0]` (review pr3#7). Also
   * drives the plan-default hint + reset affordance: `source === 'plan'` is
   * the only state where "using your plan's default" is truthful (pr7#2). */
  effectiveHint?: { ref: string | null; source: "choice" | "default" | "plan" | null };
  /** What clearing this slot resolves to (computed by the parent from
   * llm.default / the plan alias), so the reset button's label states the
   * actual post-clear routing instead of an unconditional "plan default"
   * claim (review pr7#2). */
  clearHint?: { ref: string; source: "default" | "plan" };
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
      const hostedRef = providers[parsed.provider]?.kind === USEJARVIS_KIND;
      if (known.includes(parsed.model) || hostedRef) {
        // Hosted refs are never parked in the custom field: free-text entry is
        // suppressed for the managed provider, and a saved plan alias missing
        // from a degraded fallback catalog is still the saved truth — it
        // renders as itself (an extra option) rather than as "Custom…".
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
  // The hosted provider is opaque BY DESIGN: its aliases are the only valid
  // refs. saveLLMSettings enforces the allowlist server-side (the real gate);
  // hiding free-text entry here keeps the UI honest about it — a "Custom…"
  // escape hatch or a fallback text box while the catalog loads would offer a
  // control whose every input the server rejects (review pr3#1/#2).
  const isHosted = providers[selectedProvider]?.kind === USEJARVIS_KIND;
  const usesCustomOnly = models.length === 0 && !isHosted;
  const catalogStatus: CatalogStatus | undefined = catalogState?.status[selectedProvider];
  const hostedCatalogPending = isHosted && models.length === 0 && catalogStatus !== "failed";
  const hostedCatalogFailed = isHosted && (catalogStatus === "failed" || catalogStatus === "degraded");
  const effectiveModel = selectedModel === "__custom__" ? customModel.trim() : selectedModel;
  // Routing truth for an unset slot: what the daemon binds (plan alias or the
  // default), shown as a placeholder — never presented as a saved choice.
  const unsetPlaceholder = value ? "Select a model…" : unsetSlotPlaceholder(effectiveHint);

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
            const defaultModel = seedModelForProvider(nextModels, preferredModel);
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

        {isHosted && models.length === 0 && !selectedModel ? (
          <select className="v2-set__select" disabled value="" style={{ flex: "1 1 200px" }}>
            <option value="">
              {hostedCatalogPending ? "Loading your plan’s models…" : "Plan catalog unavailable"}
            </option>
          </select>
        ) : usesCustomOnly ? (
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
            value={selectedModel || ""}
            onChange={(e) => {
              const next = e.target.value;
              if (!next) return;
              setSelectedModel(next);
              if (next !== "__custom__") {
                commit(selectedProvider, next);
              }
            }}
            style={{ flex: "1 1 200px" }}
          >
            {/* An unset slot shows routing truth as an inert placeholder — a
                pre-selected models[0] here read as a saved choice and invited
                the user to "confirm" a downgrade (review pr3#7). */}
            {!selectedModel && <option value="" disabled>{unsetPlaceholder}</option>}
            {selectedModel && selectedModel !== "__custom__" && !models.includes(selectedModel) && (
              <option value={selectedModel}>{selectedModel}</option>
            )}
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!isHosted && <option value="__custom__">Custom…</option>}
          </select>
        )}

        {selectedModel === "__custom__" && !usesCustomOnly && !isHosted && (
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

        {hostedCatalogFailed && catalogState && (
          <button
            type="button"
            className="v2-set__btn"
            onClick={() => catalogState.retry()}
          >
            Retry
          </button>
        )}

        {allowClear && value && (
          <button
            type="button"
            className="v2-set__btn v2-set__btn--icon"
            onClick={() => onChange(null)}
            title={clearHint
              ? `Reset — this slot returns to ${clearHint.source === "plan" ? "your plan's default" : "the fallback default"} (${clearHint.ref})`
              : "Clear this model"}
            aria-label={clearHint
              ? `Reset to ${clearHint.source === "plan" ? "your plan's default" : "the fallback default"}, ${clearHint.ref}`
              : "Clear this model"}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {hostedCatalogFailed && (
        <div className="v2-set__hint v2-set__hint--warn" style={{ marginTop: "var(--s-2)" }}>
          {catalogStatus === "degraded"
            ? "Showing the standard aliases — your plan’s model catalog is unreachable."
            : "Your plan’s model catalog could not be loaded."}
        </div>
      )}
      {effectiveModel && effectiveModel !== "__custom__" && (
        <div className="v2-set__hint" style={{ marginTop: "var(--s-2)" }}>
          Saved as <code>{selectedProvider}:{effectiveModel}</code>
        </div>
      )}
      {!value && effectiveHint?.ref && effectiveHint.source !== "choice" && (
        <div className="v2-set__hint" style={{ marginTop: "var(--s-2)" }}>
          No explicit choice — currently running on{" "}
          {effectiveHint.source === "plan" ? "your plan’s default" : "the fallback default"}{" "}
          <code>{effectiveHint.ref}</code>.
        </div>
      )}
    </div>
  );
}

/**
 * Placeholder text for a tier slot with no explicit ref: routing truth from
 * `llm.effective` (plan alias or the fallback default), or a neutral prompt
 * when the daemon reports nothing bound. Extracted so the "never display a
 * never-persisted models[0] as if it were saved" rule is pinned by tests.
 */
export function unsetSlotPlaceholder(
  effectiveHint?: { ref: string | null; source: "choice" | "default" | "plan" | null },
): string {
  if (!effectiveHint?.ref || effectiveHint.source === "choice") return "Select a model…";
  const model = parseModelRef(effectiveHint.ref)?.model ?? effectiveHint.ref;
  return `${effectiveHint.source === "plan" ? "Plan default" : "Default"}: ${model}`;
}

export function providerModels(
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
  // Live-only catalogs: OmniRoute routes include user-defined combos, Groq's
  // list is account-scoped, and the hosted uj-* aliases are key-scoped — a
  // curated list cannot know any of them.
  if (
    (entry.kind === "omniroute" || entry.kind === "groq" || entry.kind === "usejarvis_ai")
    && providerCatalogs[name]?.length
  ) {
    const catalog = providerCatalogs[name]!;
    // The hosted catalog is key-scoped across ALL modalities, so it also
    // carries the voice aliases. These pickers choose CHAT tiers (and the
    // single-model default) — selecting uj-stt/uj-tts/uj-realtime there would
    // point the conversation at a transcription or speech endpoint and break
    // chat outright. Voice slots are chosen in Channels/Voice, not here.
    return entry.kind === "usejarvis_ai"
      ? catalog.filter((id) => CHAT_USEJARVIS_ALIASES.has(id))
      : catalog;
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

/** Load volatile catalogs for gateways/providers whose IDs change frequently:
 * OmniRoute (user-defined routes/combos) and the hosted Usejarvis AI proxy
 * (key-scoped uj-* aliases). */
export type CatalogStatus = "loading" | "ok" | "degraded" | "failed";

export interface LiveCatalogState {
  catalogs: Record<string, string[]>;
  /** Per provider name; absent = that provider has no live catalog to fetch. */
  status: Record<string, CatalogStatus>;
  /** Re-fetch every live catalog on demand (the "Retry" affordance). */
  retry: () => void;
}

function useLiveProviderCatalogs(
  providers: Record<string, LLMConfigProviderView>,
): LiveCatalogState {
  const targets = Object.entries(providers)
    .filter(([, entry]) =>
      entry.kind === "omniroute"
      || entry.kind === USEJARVIS_KIND
      || (entry.kind === "groq" && entry.has_api_key))
    .map(([name, entry]) => ({
      name,
      kind: entry.kind,
      baseUrl: entry.base_url?.trim() || "http://localhost:20128/v1",
      hasApiKey: entry.has_api_key,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const signature = JSON.stringify(targets);
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState<Record<string, CatalogStatus>>({});
  // Bumping the attempt re-runs the effect with the same signature — a
  // permanent "Loading…" with no way out was review finding pr3#5.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (targets.length === 0) {
      setCatalogs({});
      setStatus({});
      return;
    }
    let cancelled = false;
    setStatus(Object.fromEntries(targets.map(({ name }) => [name, "loading" as const])));
    Promise.all(targets.map(async ({ name, kind }) => {
      try {
        // The hosted catalog needs no inputs (the daemon holds the system
        // credentials); Groq and OmniRoute are looked up by saved provider name.
        const response = kind === USEJARVIS_KIND
          ? await fetch("/api/config/llm/usejarvis/models")
          : await fetch(
              kind === "groq"
                ? "/api/config/llm/groq/models"
                : "/api/config/llm/omniroute/models",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
              },
            );
        const data = await response.json() as { ok: boolean; models?: string[]; degraded?: boolean };
        if (!data.ok || !data.models) return [name, [] as string[], "failed"] as const;
        // Degraded = the daemon served fallback aliases because the plan
        // catalog was unreachable. The picker stays usable, but the state is
        // surfaced (with Retry) instead of presented as the plan's truth.
        return [name, data.models, data.degraded ? "degraded" : "ok"] as const;
      } catch {
        return [name, [] as string[], "failed"] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setCatalogs(Object.fromEntries(entries.map(([name, models]) => [name, models])));
      setStatus(Object.fromEntries(entries.map(([name, , state]) => [name, state])));
    });
    return () => { cancelled = true; };
  }, [signature, attempt]); // targets are represented by the stable signature

  return { catalogs, status, retry };
}
