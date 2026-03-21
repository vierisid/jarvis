import React, { useState, useEffect } from "react";
import { useApiData, api } from "../../hooks/useApi";

type LLMConfig = {
  primary: string;
  fallback: string[];
  anthropic: { model: string; has_api_key: boolean } | null;
  openai: { model: string; has_api_key: boolean } | null;
  gemini: { model: string; has_api_key: boolean } | null;
  ollama: { base_url: string; model: string } | null;
  openrouter: { model: string; has_api_key: boolean } | null;
};

type TestResult = { ok: boolean; model?: string; error?: string };

const ANTHROPIC_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
];

const OPENAI_MODELS = [
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
];

const GEMINI_MODELS = [
  "gemini-3.1-pro-preview",
  "gemini-3-deep-think",
  "gemini-3-flash-preview",
  "gemini-3-1-flash-lite-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

const OLLAMA_MODELS = [
  "llama3",
  "llama3.1",
  "llama3.2",
  "mistral",
  "mixtral",
  "codellama",
  "qwen2.5",
  "deepseek-coder-v2",
  "phi3",
];

const OPENROUTER_MODELS = [
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
];

const PROVIDERS = ["anthropic", "openai", "gemini", "ollama", "openrouter"] as const;

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  ollama: "Ollama",
  openrouter: "OpenRouter",
};

export function LLMPanel() {
  const { data: config, loading, refetch } = useApiData<LLMConfig>("/api/config/llm", []);

  // Form state
  const [primary, setPrimary] = useState("anthropic");
  const [fallback, setFallback] = useState<string[]>(["openai", "ollama"]);

  // Anthropic
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("claude-sonnet-4-5-20250929");
  const [anthropicCustomModel, setAnthropicCustomModel] = useState("");

  // OpenAI
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("gpt-5.4");
  const [openaiCustomModel, setOpenaiCustomModel] = useState("");

  // Gemini
  const [geminiKey, setGeminiKey] = useState("");
  const [geminiModel, setGeminiModel] = useState("gemini-3-flash-preview");
  const [geminiCustomModel, setGeminiCustomModel] = useState("");

  // Ollama
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("llama3");
  const [ollamaCustomModel, setOllamaCustomModel] = useState("");

  // OpenRouter
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("anthropic/claude-sonnet-4");
  const [openrouterCustomModel, setOpenrouterCustomModel] = useState("");

  // UI state
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "error" } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({});

  // Sync form state when config loads
  useEffect(() => {
    if (!config) return;
    setPrimary(config.primary);
    setFallback(config.fallback);

    if (config.anthropic) {
      const m = config.anthropic.model;
      if (ANTHROPIC_MODELS.includes(m)) {
        setAnthropicModel(m);
        setAnthropicCustomModel("");
      } else {
        setAnthropicModel("custom");
        setAnthropicCustomModel(m);
      }
    }
    if (config.openai) {
      const m = config.openai.model;
      if (OPENAI_MODELS.includes(m)) {
        setOpenaiModel(m);
        setOpenaiCustomModel("");
      } else {
        setOpenaiModel("custom");
        setOpenaiCustomModel(m);
      }
    }
    if (config.gemini) {
      const m = config.gemini.model;
      if (GEMINI_MODELS.includes(m)) {
        setGeminiModel(m);
        setGeminiCustomModel("");
      } else {
        setGeminiModel("custom");
        setGeminiCustomModel(m);
      }
    }
    if (config.ollama) {
      setOllamaBaseUrl(config.ollama.base_url);
      const m = config.ollama.model;
      if (OLLAMA_MODELS.includes(m)) {
        setOllamaModel(m);
        setOllamaCustomModel("");
      } else {
        setOllamaModel("custom");
        setOllamaCustomModel(m);
      }
    }
    if (config.openrouter) {
      const m = config.openrouter.model;
      if (OPENROUTER_MODELS.includes(m)) {
        setOpenrouterModel(m);
        setOpenrouterCustomModel("");
      } else {
        setOpenrouterModel("custom");
        setOpenrouterCustomModel(m);
      }
    }
  }, [config]);

  const resolveModel = (selected: string, custom: string) =>
    selected === "custom" ? custom : selected;

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        primary,
        fallback,
        anthropic: {
          model: resolveModel(anthropicModel, anthropicCustomModel),
          ...(anthropicKey ? { api_key: anthropicKey } : {}),
        },
        openai: {
          model: resolveModel(openaiModel, openaiCustomModel),
          ...(openaiKey ? { api_key: openaiKey } : {}),
        },
        gemini: {
          model: resolveModel(geminiModel, geminiCustomModel),
          ...(geminiKey ? { api_key: geminiKey } : {}),
        },
        ollama: {
          base_url: ollamaBaseUrl,
          model: resolveModel(ollamaModel, ollamaCustomModel),
        },
        openrouter: {
          model: resolveModel(openrouterModel, openrouterCustomModel),
          ...(openrouterKey ? { api_key: openrouterKey } : {}),
        },
      };
      const resp = await api<{ ok: boolean; message: string }>("/api/config/llm", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setMessage({ text: resp.message, type: "ok" });
      setAnthropicKey("");
      setOpenaiKey("");
      setGeminiKey("");
      setOpenrouterKey("");
      refetch();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Save failed", type: "error" });
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(null), 5000);
    }
  };

  const handleTest = async (provider: string) => {
    setTesting(provider);
    setTestResult((prev) => ({ ...prev, [provider]: undefined as any }));
    try {
      const body: Record<string, unknown> = { provider };
      if (provider === "anthropic") {
        body.api_key = anthropicKey || undefined;
        body.model = resolveModel(anthropicModel, anthropicCustomModel);
      } else if (provider === "openai") {
        body.api_key = openaiKey || undefined;
        body.model = resolveModel(openaiModel, openaiCustomModel);
      } else if (provider === "gemini") {
        body.api_key = geminiKey || undefined;
        body.model = resolveModel(geminiModel, geminiCustomModel);
      } else if (provider === "ollama") {
        body.base_url = ollamaBaseUrl;
        body.model = resolveModel(ollamaModel, ollamaCustomModel);
      } else if (provider === "openrouter") {
        body.api_key = openrouterKey || undefined;
        body.model = resolveModel(openrouterModel, openrouterCustomModel);
      }
      const result = await api<TestResult>("/api/config/llm/test", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTestResult((prev) => ({ ...prev, [provider]: result }));
    } catch (err) {
      setTestResult((prev) => ({
        ...prev,
        [provider]: { ok: false, error: err instanceof Error ? err.message : "Test failed" },
      }));
    } finally {
      setTesting(null);
    }
  };

  const toggleFallback = (name: string) => {
    setFallback((prev) => {
      if (prev.includes(name)) return prev.filter((n) => n !== name);
      return [...prev, name];
    });
  };

  if (loading || !config) {
    return (
      <div style={cardStyle}>
        <span style={{ color: "var(--j-text-muted)", fontSize: "13px" }}>Loading...</span>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h3 style={headerStyle}>LLM Configuration</h3>

      {/* Status message */}
      {message && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: "12px",
            borderRadius: "6px",
            fontSize: "12px",
            background: message.type === "ok" ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)",
            border: `1px solid ${message.type === "ok" ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
            color: message.type === "ok" ? "var(--j-success)" : "var(--j-error)",
          }}
        >
          {message.text}
        </div>
      )}

      {/* Primary provider */}
      <div style={{ marginBottom: "16px" }}>
        <div style={labelStyle}>Primary Provider</div>
        <select value={primary} onChange={(e) => setPrimary(e.target.value)} style={selectStyle}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p] ?? p}
            </option>
          ))}
        </select>
      </div>

      {/* Fallback chain */}
      <div style={{ marginBottom: "16px" }}>
        <div style={labelStyle}>Fallback Chain</div>
        <div style={{ display: "flex", gap: "8px" }}>
          {PROVIDERS.filter((p) => p !== primary).map((p) => (
            <label
              key={p}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "13px",
                color: "var(--j-text-dim)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={fallback.includes(p)}
                onChange={() => toggleFallback(p)}
                style={{ accentColor: "var(--j-accent)" }}
              />
              {PROVIDER_LABELS[p] ?? p}
            </label>
          ))}
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--j-border)", paddingTop: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Anthropic */}
        <ProviderSection
          name="Anthropic"
          provider="anthropic"
          isPrimary={primary === "anthropic"}
          hasKey={config.anthropic?.has_api_key ?? false}
          apiKey={anthropicKey}
          onApiKeyChange={setAnthropicKey}
          model={anthropicModel}
          customModel={anthropicCustomModel}
          onModelChange={setAnthropicModel}
          onCustomModelChange={setAnthropicCustomModel}
          models={ANTHROPIC_MODELS}
          testing={testing === "anthropic"}
          testResult={testResult.anthropic}
          onTest={() => handleTest("anthropic")}
        />

        {/* OpenAI */}
        <ProviderSection
          name="OpenAI"
          provider="openai"
          isPrimary={primary === "openai"}
          hasKey={config.openai?.has_api_key ?? false}
          apiKey={openaiKey}
          onApiKeyChange={setOpenaiKey}
          model={openaiModel}
          customModel={openaiCustomModel}
          onModelChange={setOpenaiModel}
          onCustomModelChange={setOpenaiCustomModel}
          models={OPENAI_MODELS}
          testing={testing === "openai"}
          testResult={testResult.openai}
          onTest={() => handleTest("openai")}
        />

        {/* Gemini */}
        <ProviderSection
          name="Gemini"
          provider="gemini"
          isPrimary={primary === "gemini"}
          hasKey={config.gemini?.has_api_key ?? false}
          apiKey={geminiKey}
          onApiKeyChange={setGeminiKey}
          model={geminiModel}
          customModel={geminiCustomModel}
          onModelChange={setGeminiModel}
          onCustomModelChange={setGeminiCustomModel}
          models={GEMINI_MODELS}
          testing={testing === "gemini"}
          testResult={testResult.gemini}
          onTest={() => handleTest("gemini")}
        />

        {/* OpenRouter */}
        <ProviderSection
          name="OpenRouter"
          provider="openrouter"
          isPrimary={primary === "openrouter"}
          hasKey={config.openrouter?.has_api_key ?? false}
          apiKey={openrouterKey}
          onApiKeyChange={setOpenrouterKey}
          model={openrouterModel}
          customModel={openrouterCustomModel}
          onModelChange={setOpenrouterModel}
          onCustomModelChange={setOpenrouterCustomModel}
          models={OPENROUTER_MODELS}
          testing={testing === "openrouter"}
          testResult={testResult.openrouter}
          onTest={() => handleTest("openrouter")}
        />

        {/* Ollama */}
        <div style={providerCardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
            <span style={dotStyle(!!config.ollama)} />
            <span style={{ fontWeight: 600, fontSize: "13px" }}>Ollama</span>
            {primary === "ollama" && <span style={primaryBadgeStyle}>PRIMARY</span>}
            <span style={{ fontSize: "11px", color: "var(--j-text-muted)", marginLeft: "auto" }}>No API key needed</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div>
              <div style={fieldLabelStyle}>Base URL</div>
              <input
                type="text"
                value={ollamaBaseUrl}
                onChange={(e) => setOllamaBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
                style={inputStyle}
              />
            </div>

            <div>
              <div style={fieldLabelStyle}>Model</div>
              <div style={{ display: "flex", gap: "6px" }}>
                <select value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                  {OLLAMA_MODELS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  <option value="custom">Custom...</option>
                </select>
                {ollamaModel === "custom" && (
                  <input
                    type="text"
                    value={ollamaCustomModel}
                    onChange={(e) => setOllamaCustomModel(e.target.value)}
                    placeholder="model name"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                )}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
              <button onClick={() => handleTest("ollama")} disabled={testing === "ollama"} style={testBtnStyle}>
                {testing === "ollama" ? "Testing..." : "Test Connection"}
              </button>
              {testResult.ollama && (
                <span style={{ fontSize: "11px", color: testResult.ollama.ok ? "var(--j-success)" : "var(--j-error)" }}>
                  {testResult.ollama.ok ? `Connected (${testResult.ollama.model})` : testResult.ollama.error}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Save */}
      <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
        <button onClick={handleSave} disabled={saving} style={saveBtnStyle}>
          {saving ? "Saving..." : "Save Configuration"}
        </button>
      </div>
    </div>
  );
}

// --- Provider Section Component ---

type ProviderSectionProps = {
  name: string;
  provider: string;
  isPrimary: boolean;
  hasKey: boolean;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  model: string;
  customModel: string;
  onModelChange: (v: string) => void;
  onCustomModelChange: (v: string) => void;
  models: string[];
  testing: boolean;
  testResult?: TestResult;
  onTest: () => void;
};

function ProviderSection({
  name, provider, isPrimary, hasKey,
  apiKey, onApiKeyChange,
  model, customModel, onModelChange, onCustomModelChange,
  models, testing, testResult, onTest,
}: ProviderSectionProps) {
  return (
    <div style={providerCardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
        <span style={dotStyle(hasKey)} />
        <span style={{ fontWeight: 600, fontSize: "13px" }}>{name}</span>
        {isPrimary && <span style={primaryBadgeStyle}>PRIMARY</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div>
          <div style={fieldLabelStyle}>API Key</div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={hasKey ? "Stored securely — leave empty to keep" : "Enter API key"}
            style={inputStyle}
          />
        </div>

        <div>
          <div style={fieldLabelStyle}>Model</div>
          <div style={{ display: "flex", gap: "6px" }}>
            <select value={model} onChange={(e) => onModelChange(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value="custom">Custom...</option>
            </select>
            {model === "custom" && (
              <input
                type="text"
                value={customModel}
                onChange={(e) => onCustomModelChange(e.target.value)}
                placeholder="model ID"
                style={{ ...inputStyle, flex: 1 }}
              />
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
          <button onClick={onTest} disabled={testing} style={testBtnStyle}>
            {testing ? "Testing..." : "Test Connection"}
          </button>
          {testResult && (
            <span style={{ fontSize: "11px", color: testResult.ok ? "var(--j-success)" : "var(--j-error)" }}>
              {testResult.ok ? `Connected (${testResult.model})` : testResult.error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Styles ---

const cardStyle: React.CSSProperties = {
  padding: "20px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "8px",
};

const headerStyle: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--j-text)",
  marginBottom: "16px",
};

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--j-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  marginBottom: "6px",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--j-text-muted)",
  marginBottom: "4px",
};

const providerCardStyle: React.CSSProperties = {
  padding: "12px",
  background: "var(--j-bg)",
  border: "1px solid var(--j-border)",
  borderRadius: "6px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "4px",
  color: "var(--j-text)",
  outline: "none",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "4px",
  color: "var(--j-text)",
  outline: "none",
  cursor: "pointer",
};

const testBtnStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: "11px",
  background: "rgba(0, 212, 255, 0.1)",
  border: "1px solid rgba(0, 212, 255, 0.3)",
  borderRadius: "4px",
  color: "var(--j-accent)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const saveBtnStyle: React.CSSProperties = {
  padding: "8px 20px",
  fontSize: "13px",
  fontWeight: 600,
  background: "rgba(0, 212, 255, 0.15)",
  border: "1px solid rgba(0, 212, 255, 0.4)",
  borderRadius: "6px",
  color: "var(--j-accent)",
  cursor: "pointer",
};

const primaryBadgeStyle: React.CSSProperties = {
  fontSize: "9px",
  fontWeight: 700,
  color: "var(--j-accent)",
  background: "rgba(0, 212, 255, 0.1)",
  padding: "1px 6px",
  borderRadius: "3px",
  letterSpacing: "0.5px",
};

function dotStyle(active: boolean): React.CSSProperties {
  return {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: active ? "var(--j-success)" : "var(--j-text-muted)",
    display: "inline-block",
    flexShrink: 0,
  };
}
