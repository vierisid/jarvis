import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const POLL_INTERVAL_MS = 10000;

export type LLMProvider =
  | "anthropic"
  | "openai"
  | "groq"
  | "gemini"
  | "ollama"
  | "openrouter"
  | "nvidia"
  | "openai_compatible";

export const LLM_PROVIDERS: readonly LLMProvider[] = [
  "anthropic",
  "openai",
  "groq",
  "gemini",
  "ollama",
  "openrouter",
  "nvidia",
  "openai_compatible",
] as const;

export const LLM_PROVIDER_LABELS: Record<LLMProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  groq: "Groq",
  gemini: "Gemini",
  ollama: "Ollama",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA NIM",
  openai_compatible: "OpenAI-compatible",
};

export type STTProvider = "openai" | "groq" | "sarvam" | "local";
export type TTSProvider = "edge" | "elevenlabs" | "sarvam";

export interface LLMConfig {
  primary: string;
  fallback: string[];
  anthropic?: { model: string; has_api_key: boolean } | null;
  openai?: { model: string; has_api_key: boolean } | null;
  groq?: { model: string; has_api_key: boolean } | null;
  gemini?: { model: string; has_api_key: boolean } | null;
  ollama?: { base_url: string; model: string } | null;
  openrouter?: { model: string; has_api_key: boolean } | null;
  nvidia?: { model: string; has_api_key: boolean } | null;
  openai_compatible?: { base_url: string; model: string; has_api_key: boolean } | null;
}

export interface ChannelStatus {
  channels: { telegram?: boolean; discord?: boolean };
  stt: string | null;
}

export interface ChannelConfig {
  telegram: { enabled: boolean; has_token: boolean; allowed_users: number[] };
  discord: {
    enabled: boolean;
    has_token: boolean;
    allowed_users: string[];
    guild_id: string | null;
  };
}

export interface STTConfig {
  provider: string;
  has_openai_key: boolean;
  has_groq_key: boolean;
  has_sarvam_key: boolean;
  local_endpoint: string | null;
  local_server_type: string;
}

export interface TTSConfig {
  enabled: boolean;
  provider: string;
  voice: string;
  rate: string;
  volume: string;
  elevenlabs?: {
    has_api_key: boolean;
    voice_id: string | null;
    model: string;
    stability: number;
    similarity_boost: number;
  } | null;
  sarvam?: {
    has_api_key: boolean;
    model: string;
    language: string;
    speaker: string;
    sampling_rate: number;
  } | null;
}

export interface AutostartStatus {
  platform: string;
  manager: string;
  installed: boolean;
  keepalive_supported: boolean;
  restart_supported: boolean;
}

export interface RootConfig {
  heartbeat?: {
    interval_minutes: number;
    active_hours: { start: number; end: number };
    aggressiveness: string;
  };
}

export interface PersonalityModel {
  core_traits: string[];
  learned_preferences: {
    verbosity: number;
    formality: number;
    humor_level: number;
    emoji_usage: boolean;
    preferred_format: string;
  };
  relationship: {
    first_interaction: number;
    message_count: number;
    trust_level: number;
    shared_references: string[];
  };
}

export interface RoleInfo {
  active_role: string;
  role: {
    id: string;
    name: string;
    authority_level: number;
    tools: string[];
    sub_roles: Array<{ role_id: string; name: string; description: string }>;
  } | null;
}

export interface GoogleStatus {
  status: "not_configured" | "credentials_saved" | "connected";
  has_credentials: boolean;
  is_authenticated: boolean;
  scopes: string[];
  token_expiry: number | null;
}

export interface SidecarInfo {
  id: string;
  name: string;
  enrolled_at: string;
  last_seen_at: string | null;
  status: string;
  connected: boolean;
  hostname?: string;
  os?: string;
  platform?: string;
  capabilities?: string[];
  unavailable_capabilities?: Array<{ name: string; reason: string }>;
}

export interface UserProfileQuestion {
  id: string;
  step: number;
  step_title: string;
  label: string;
  prompt: string;
  description: string;
  placeholder?: string;
  multiline?: boolean;
}

export interface UserProfileResponse {
  questions: UserProfileQuestion[];
  profile: {
    version: 1;
    answers: Record<string, string>;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
  } | null;
  answered_count: number;
  total_questions: number;
  has_profile: boolean;
}

export type ActionResult =
  | { ok: true; message: string; restartRequired?: boolean }
  | { ok: false; message: string };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function postJson<T>(
  url: string,
  body: unknown,
  method: "POST" | "PATCH" | "DELETE" = "POST",
): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

/**
 * Settings Room data hook.
 *
 * Polls the 8 read endpoints in parallel every 10s (paused while tab
 * hidden). Exposes lifecycle actions that all return ActionResult so the
 * UI can show a per-action toast and bubble up `restartRequired` to the
 * room-level restart banner.
 *
 * Voice actions land on the same lifecycle methods through the room
 * action bus, so behaviour is identical for clicks vs voice.
 */
export function useSettingsData() {
  const [llm, setLLM] = useState<LLMConfig | null>(null);
  const [channelStatus, setChannelStatus] = useState<ChannelStatus | null>(null);
  const [channelCfg, setChannelCfg] = useState<ChannelConfig | null>(null);
  const [sttCfg, setSTTCfg] = useState<STTConfig | null>(null);
  const [ttsCfg, setTTSCfg] = useState<TTSConfig | null>(null);
  const [autostart, setAutostart] = useState<AutostartStatus | null>(null);
  const [rootCfg, setRootCfg] = useState<RootConfig | null>(null);
  const [personality, setPersonality] = useState<PersonalityModel | null>(null);
  const [role, setRole] = useState<RoleInfo | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [sidecars, setSidecars] = useState<SidecarInfo[]>([]);
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const [
        llmR,
        chanStatusR,
        chanCfgR,
        sttR,
        ttsR,
        autoR,
        rootR,
        persR,
        roleR,
        gR,
        scR,
        profR,
      ] = await Promise.all([
        getJson<LLMConfig>("/api/config/llm"),
        getJson<ChannelStatus>("/api/channels/status"),
        getJson<ChannelConfig>("/api/config/channels"),
        getJson<STTConfig>("/api/config/stt"),
        getJson<TTSConfig>("/api/config/tts"),
        getJson<AutostartStatus>("/api/system/autostart"),
        getJson<RootConfig>("/api/config"),
        getJson<PersonalityModel>("/api/personality"),
        getJson<RoleInfo>("/api/roles"),
        getJson<GoogleStatus>("/api/auth/google/status"),
        getJson<SidecarInfo[]>("/api/sidecars"),
        getJson<UserProfileResponse>("/api/user-profile"),
      ]);
      if (llmR) setLLM(llmR);
      if (chanStatusR) setChannelStatus(chanStatusR);
      if (chanCfgR) setChannelCfg(chanCfgR);
      if (sttR) setSTTCfg(sttR);
      if (ttsR) setTTSCfg(ttsR);
      if (autoR) setAutostart(autoR);
      if (rootR) setRootCfg(rootR);
      if (persR) setPersonality(persR);
      if (roleR) setRole(roleR);
      if (gR) setGoogle(gR);
      if (scR) setSidecars(scR);
      if (profR) setProfile(profR);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // ── Stats ───────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    let providersWithKey = 0;
    if (llm) {
      for (const p of LLM_PROVIDERS) {
        const v = (llm as any)[p];
        if (!v) continue;
        // Ollama and OpenAI-compatible are "configured" by a base_url, not a key.
        if (p === "ollama" || p === "openai_compatible" || v.has_api_key) {
          providersWithKey++;
        }
      }
    }
    const channelsEnabled =
      (channelCfg?.telegram.enabled ? 1 : 0) +
      (channelCfg?.discord.enabled ? 1 : 0) +
      (ttsCfg?.enabled ? 1 : 0);
    const sidecarsConnected = sidecars.filter((s) => s.connected).length;
    return {
      providersWithKey,
      channelsEnabled,
      sidecarsConnected,
      sidecarsTotal: sidecars.length,
      restartPending,
    };
  }, [llm, channelCfg, ttsCfg, sidecars, restartPending]);

  // ── LLM actions (hot-reloaded) ──────────────────────────────────────
  const setPrimaryLLM = useCallback(
    async (provider: LLMProvider): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { primary: provider },
        );
        await refresh();
        return { ok: true, message: r.message || `Primary set to ${LLM_PROVIDER_LABELS[provider]}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const setFallbackLLM = useCallback(
    async (fallback: string[]): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { fallback },
        );
        await refresh();
        return { ok: true, message: r.message || `Fallback updated.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const setLLMModel = useCallback(
    async (provider: LLMProvider, model: string): Promise<ActionResult> => {
      try {
        const body: Record<string, unknown> = { [provider]: { model } };
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          body,
        );
        await refresh();
        return { ok: true, message: r.message || `${LLM_PROVIDER_LABELS[provider]} model set to ${model}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const setLLMApiKey = useCallback(
    async (provider: LLMProvider, apiKey: string): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { [provider]: { api_key: apiKey } },
        );
        await refresh();
        return { ok: true, message: r.message || `${LLM_PROVIDER_LABELS[provider]} key saved.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const setOllamaBaseUrl = useCallback(
    async (baseUrl: string): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { ollama: { base_url: baseUrl } },
        );
        await refresh();
        return { ok: true, message: r.message || `Ollama base URL updated.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const setOpenAICompatibleBaseUrl = useCallback(
    async (baseUrl: string): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { openai_compatible: { base_url: baseUrl } },
        );
        await refresh();
        return { ok: true, message: r.message || "OpenAI-compatible base URL updated." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  /**
   * Test a provider's connection. Accepts optional `model` / `baseUrl`
   * overrides so the UI can test what's currently in the textbox before
   * the user clicks Save. Without overrides the server falls back to the
   * stored config -- which would test the OLD model after the user typed
   * a new one but hadn't saved yet.
   */
  const testProvider = useCallback(
    async (
      provider: LLMProvider,
      overrides?: { model?: string; baseUrl?: string; apiKey?: string },
    ): Promise<ActionResult> => {
      try {
        const body: Record<string, unknown> = { provider };
        if (overrides?.model) body.model = overrides.model;
        if (overrides?.baseUrl) body.base_url = overrides.baseUrl;
        if (overrides?.apiKey) body.api_key = overrides.apiKey;
        const r = await postJson<{ ok: boolean; model?: string; error?: string }>(
          "/api/config/llm/test",
          body,
        );
        if (r.ok) {
          return { ok: true, message: `${LLM_PROVIDER_LABELS[provider]}: ${r.model ?? "connected"}.` };
        }
        return { ok: false, message: r.error ?? "Test failed." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Test failed" };
      }
    },
    [],
  );

  // ── Channels (restart required) ─────────────────────────────────────
  const setTelegram = useCallback(
    async (input: {
      enabled?: boolean;
      bot_token?: string;
      allowed_users?: number[];
    }): Promise<ActionResult> => {
      try {
        await postJson("/api/config/channels", { telegram: input });
        setRestartPending(true);
        await refresh();
        return {
          ok: true,
          message: "Telegram saved. Restart Jarvis to apply.",
          restartRequired: true,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const setDiscord = useCallback(
    async (input: {
      enabled?: boolean;
      bot_token?: string;
      allowed_users?: string[];
      guild_id?: string;
    }): Promise<ActionResult> => {
      try {
        await postJson("/api/config/channels", { discord: input });
        setRestartPending(true);
        await refresh();
        return {
          ok: true,
          message: "Discord saved. Restart Jarvis to apply.",
          restartRequired: true,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const setSTTProvider = useCallback(
    async (
      provider: STTProvider,
      extras?: {
        api_key?: string;
        endpoint?: string;
        server_type?: string;
      },
    ): Promise<ActionResult> => {
      try {
        const body: Record<string, unknown> = { provider };
        if (provider === "local") {
          body.local = {
            endpoint: extras?.endpoint,
            server_type: extras?.server_type,
          };
        } else if (extras?.api_key) {
          body[provider] = { api_key: extras.api_key };
        }
        await postJson("/api/config/stt", body);
        setRestartPending(true);
        await refresh();
        return {
          ok: true,
          message: `STT set to ${provider}. Restart Jarvis to apply.`,
          restartRequired: true,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  // ── TTS (hot-reloaded) ──────────────────────────────────────────────
  const setTTS = useCallback(
    async (input: {
      enabled?: boolean;
      provider?: TTSProvider;
      voice?: string;
      rate?: string;
      elevenlabs?: { api_key?: string; voice_id?: string; model?: string };
      sarvam?: {
        api_key?: string;
        model?: string;
        language?: string;
        speaker?: string;
        sampling_rate?: number;
      };
    }): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/tts",
          {
            enabled: input.enabled ?? ttsCfg?.enabled ?? false,
            provider: input.provider ?? ttsCfg?.provider ?? "edge",
            voice: input.voice ?? ttsCfg?.voice ?? "en-US-AriaNeural",
            rate: input.rate ?? ttsCfg?.rate ?? "+0%",
            ...(input.elevenlabs ? { elevenlabs: input.elevenlabs } : {}),
            ...(input.sarvam ? { sarvam: input.sarvam } : {}),
          },
        );
        await refresh();
        return { ok: true, message: r.message || "TTS updated." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh, ttsCfg],
  );

  // ── Heartbeat (config write — root /api/config) ─────────────────────
  // Note: backend has no dedicated heartbeat endpoint; field-level writes
  // would go through /api/config (POST). This room exposes the read but
  // defers heartbeat WRITES to a future backend endpoint — the UI button
  // is still keyboard-only and disabled with a tooltip until then.
  const setHeartbeatInterval = useCallback(
    async (_minutes: number): Promise<ActionResult> => {
      return {
        ok: false,
        message: "Heartbeat write endpoint not yet wired in daemon.",
      };
    },
    [],
  );

  const setHeartbeatAggressiveness = useCallback(
    async (_level: "passive" | "moderate" | "aggressive"): Promise<ActionResult> => {
      return {
        ok: false,
        message: "Heartbeat write endpoint not yet wired in daemon.",
      };
    },
    [],
  );

  // ── Service control ─────────────────────────────────────────────────
  const restartDaemon = useCallback(async (): Promise<ActionResult> => {
    try {
      const r = await postJson<{ ok: boolean; message: string }>(
        "/api/system/autostart/restart",
        {},
      );
      setRestartPending(false);
      // Refetch later — daemon may be down briefly
      window.setTimeout(refresh, 3000);
      return { ok: true, message: r.message || "Restart scheduled." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  // ── User profile ────────────────────────────────────────────────────
  const saveProfile = useCallback(
    async (answers: Record<string, string>): Promise<ActionResult> => {
      try {
        const r = await postJson<{ message: string }>("/api/user-profile", {
          answers,
        });
        await refresh();
        return { ok: true, message: r.message || "Profile saved." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const clearProfile = useCallback(async (): Promise<ActionResult> => {
    try {
      const r = await postJson<{ message: string }>(
        "/api/user-profile/clear",
        {},
      );
      await refresh();
      return { ok: true, message: r.message || "Profile cleared." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  // ── Google integration ──────────────────────────────────────────────
  const saveGoogleCredentials = useCallback(
    async (input: { client_id: string; client_secret: string }): Promise<ActionResult> => {
      try {
        await postJson("/api/config/google", input);
        await refresh();
        return { ok: true, message: "Google credentials saved." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const initGoogleAuth = useCallback(async (): Promise<
    | { ok: true; auth_url: string }
    | { ok: false; message: string }
  > => {
    try {
      const r = await postJson<{ auth_url: string }>(
        "/api/auth/google/init",
        {},
      );
      return { ok: true, auth_url: r.auth_url };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, []);

  const disconnectGoogle = useCallback(async (): Promise<ActionResult> => {
    try {
      await postJson("/api/auth/google/disconnect", {});
      setRestartPending(true);
      await refresh();
      return {
        ok: true,
        message: "Disconnected. Restart Jarvis to deactivate observers.",
        restartRequired: true,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  // ── Sidecars ────────────────────────────────────────────────────────
  const enrollSidecar = useCallback(
    async (
      name: string,
    ): Promise<{ ok: true; token: string; name: string } | { ok: false; message: string }> => {
      try {
        const r = await postJson<{ token: string; name: string }>(
          "/api/sidecars/enroll",
          { name },
        );
        await refresh();
        return { ok: true, token: r.token, name: r.name };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const revokeSidecar = useCallback(
    async (id: string): Promise<ActionResult> => {
      try {
        await postJson(`/api/sidecars/${encodeURIComponent(id)}`, undefined, "DELETE");
        await refresh();
        return { ok: true, message: "Sidecar revoked." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const findSidecarByName = useCallback(
    (name: string): SidecarInfo | null => {
      const q = name.trim().toLowerCase();
      if (!q) return null;
      const exact = sidecars.find((s) => s.name.toLowerCase() === q);
      if (exact) return exact;
      return sidecars.find((s) => s.name.toLowerCase().includes(q)) ?? null;
    },
    [sidecars],
  );

  return {
    // raw data
    llm,
    channelStatus,
    channelCfg,
    sttCfg,
    ttsCfg,
    autostart,
    rootCfg,
    personality,
    role,
    google,
    sidecars,
    profile,

    // derived
    stats,
    loading,
    restartPending,
    setRestartPending,

    // actions
    refresh,
    setPrimaryLLM,
    setFallbackLLM,
    setLLMModel,
    setLLMApiKey,
    setOllamaBaseUrl,
    setOpenAICompatibleBaseUrl,
    testProvider,
    setTelegram,
    setDiscord,
    setSTTProvider,
    setTTS,
    setHeartbeatInterval,
    setHeartbeatAggressiveness,
    restartDaemon,
    saveProfile,
    clearProfile,
    saveGoogleCredentials,
    initGoogleAuth,
    disconnectGoogle,
    enrollSidecar,
    revokeSidecar,
    findSidecarByName,
  };
}

export type SettingsHook = ReturnType<typeof useSettingsData>;
