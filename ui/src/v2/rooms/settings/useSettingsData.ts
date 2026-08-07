import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const POLL_INTERVAL_MS = 10000;

/**
 * Provider classes the backend can instantiate. The user names a provider
 * however they want (the map key in `LLMConfig.providers`); the `kind` field
 * picks which class to use. Defaults to the map key when omitted.
 */
export type LLMProviderKind =
  | "anthropic"
  | "openai"
  | "groq"
  | "gemini"
  | "ollama"
  | "openrouter"
  | "nvidia"
  | "openai_compatible"
  | "litellm"
  | "omniroute";

export const LLM_PROVIDER_KINDS: readonly LLMProviderKind[] = [
  "anthropic",
  "openai",
  "groq",
  "gemini",
  "ollama",
  "openrouter",
  "nvidia",
  "openai_compatible",
  "litellm",
  "omniroute",
] as const;

export const LLM_PROVIDER_KIND_LABELS: Record<LLMProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  groq: "Groq",
  gemini: "Gemini",
  ollama: "Ollama",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA NIM",
  openai_compatible: "OpenAI-compatible",
  litellm: "LiteLLM",
  omniroute: "OmniRoute",
};

/**
 * Provider kinds that authenticate via API key (vs base URL).
 * Used by the UI to decide which form field to render.
 */
export const KEY_BASED_KINDS: ReadonlySet<LLMProviderKind> = new Set([
  "anthropic",
  "openai",
  "groq",
  "gemini",
  "openrouter",
  "nvidia",
  "omniroute",
]);

/**
 * Kinds that show a key field but don't require it - local gateway installs
 * can run without auth (the daemon instantiates them keyless too).
 */
export const OPTIONAL_KEY_KINDS: ReadonlySet<LLMProviderKind> = new Set([
  "omniroute",
]);

/** Provider kinds that need a base_url. */
export const URL_BASED_KINDS: ReadonlySet<LLMProviderKind> = new Set([
  "ollama",
  "openai_compatible",
  "litellm",
  "omniroute",
]);

/** Cloud providers that may use a compatible gateway instead of their default API. */
export const OPTIONAL_BASE_URL_KINDS: ReadonlySet<LLMProviderKind> = new Set([
  "anthropic",
]);

/** Tier slot identifiers. */
export type LLMTier = "conversation" | "high" | "medium" | "low";

/** Backward-compat alias - some legacy components still import LLMProvider. */
export type LLMProvider = LLMProviderKind;
export const LLM_PROVIDERS = LLM_PROVIDER_KINDS;
export const LLM_PROVIDER_LABELS = LLM_PROVIDER_KIND_LABELS;

export type STTProvider = "openai" | "groq" | "sarvam" | "local";
export type TTSProvider = "edge" | "elevenlabs" | "sarvam";

/**
 * Per-provider summary returned by GET /api/config/llm. The credential value
 * (api_key) is never sent to the client - we only expose `has_api_key`. The
 * `base_url` is visible because it's not a secret.
 */
export interface LLMConfigProviderView {
  kind: LLMProviderKind;
  has_api_key: boolean;
  base_url?: string;
}

/**
 * Full LLM config snapshot. Two modes:
 *   - Single-LLM: `default` is set to a "name:model" reference; `tiers` is
 *     empty. The classic orchestrator runs.
 *   - Multi-tier: `tiers` has at least one entry. When tiers.conversation is
 *     set, the router-first architecture activates.
 *
 * `mode` is the user's persisted choice of architecture. It's stored
 * explicitly (not inferred from tier presence) so the selection survives a
 * tab switch / reload even before any tier model is picked, and so the user
 * can flip back to single at any time. Runtime routing still keys off tier
 * presence; `mode` only drives which section the UI shows.
 */
export interface LLMConfig {
  providers: Record<string, LLMConfigProviderView>;
  default: string | null;
  mode: "single" | "multi-tier";
  tiers: {
    conversation: string | null;
    high: string | null;
    medium: string | null;
    low: string | null;
  };
  available_kinds: LLMProviderKind[];
}

/** Helper: split a "provider:model" reference into its parts. */
export function parseModelRef(ref: string | null | undefined): { provider: string; model: string } | null {
  if (!ref || typeof ref !== "string") return null;
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
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

export type RealtimeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface VoiceConfig {
  wake_engine: string;
  realtime: {
    enabled: boolean;
    model: string;
    voice: string | null;
    reasoning_effort: RealtimeReasoningEffort;
    max_session_minutes: number;
    monthly_budget_usd: number | null;
    blocked_categories: string[];
    /** true when enabled AND the OpenAI provider key resolves. */
    available: boolean;
  };
}

/** Partial patch sent to POST /api/config/voice. */
export interface VoiceConfigPatch {
  wake_engine?: string;
  realtime?: Partial<{
    enabled: boolean;
    model: string;
    voice: string;
    reasoning_effort: RealtimeReasoningEffort;
    max_session_minutes: number;
    monthly_budget_usd: number;
  }>;
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
    sub_roles?: Array<{ role_id: string; name: string; description: string }>;
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
  /** Sidecar's own (brain-decoupled) version, "dev" for local builds */
  version?: string;
  /** Compatibility verdict while connected: 'ok' | 'suggested' | 'dev' */
  update_status?: "ok" | "suggested" | "blocked" | "dev";
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
  | { ok: true; message: string }
  | { ok: false; message: string };

export type ProviderTestResult = ActionResult & { models?: string[] };

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
 * Apply a freshly-fetched value to state only when it actually differs from
 * the current one. Every poll's `fetch` produces a brand-new object even when
 * the data is byte-for-byte identical; setting state with that new reference
 * churns `===` identity and needlessly re-fires every downstream
 * `useEffect([obj])` across the settings tabs. That churn is what let the 10s
 * poll clobber in-progress form edits (issue #238). Comparing by JSON keeps
 * the previous reference stable when nothing changed, so dependent effects
 * only run on a real data change.
 *
 * Use it as the functional state updater: `setX((prev) => preserveRef(prev, next))`.
 *
 * Safe here because every payload is plain JSON straight from `fetch`, and
 * `prev` came from the same server serializer, so key ordering is stable.
 */
function preserveRef<T>(prev: T, next: T): T {
  try {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  } catch {
    return next;
  }
}

/**
 * Settings Room data hook.
 *
 * Polls the 8 read endpoints in parallel every 10s (paused while tab
 * hidden). Exposes lifecycle actions that all return ActionResult so the
 * UI can show a per-action toast. Settings are hot-applied by the daemon
 * (channels, STT, TTS, Google observers), so no restart tracking.
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
  const [voiceCfg, setVoiceCfg] = useState<VoiceConfig | null>(null);
  const [autostart, setAutostart] = useState<AutostartStatus | null>(null);
  const [rootCfg, setRootCfg] = useState<RootConfig | null>(null);
  const [personality, setPersonality] = useState<PersonalityModel | null>(null);
  const [role, setRole] = useState<RoleInfo | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [sidecars, setSidecars] = useState<SidecarInfo[]>([]);
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
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
        voiceR,
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
        getJson<VoiceConfig>("/api/config/voice"),
        getJson<AutostartStatus>("/api/system/autostart"),
        getJson<RootConfig>("/api/config"),
        getJson<PersonalityModel>("/api/personality"),
        getJson<RoleInfo>("/api/roles"),
        getJson<GoogleStatus>("/api/auth/google/status"),
        getJson<SidecarInfo[]>("/api/sidecars"),
        getJson<UserProfileResponse>("/api/user-profile"),
      ]);
      // Functional updaters + preserveRef: keep the previous object reference
      // when the re-fetched payload is unchanged, so dependent effects in the
      // tabs don't re-fire on every poll (see preserveRef / issue #238).
      if (llmR) setLLM((p) => preserveRef(p, llmR));
      if (chanStatusR) setChannelStatus((p) => preserveRef(p, chanStatusR));
      if (chanCfgR) setChannelCfg((p) => preserveRef(p, chanCfgR));
      if (sttR) setSTTCfg((p) => preserveRef(p, sttR));
      if (ttsR) setTTSCfg((p) => preserveRef(p, ttsR));
      if (voiceR) setVoiceCfg((p) => preserveRef(p, voiceR));
      if (autoR) setAutostart((p) => preserveRef(p, autoR));
      if (rootR) setRootCfg((p) => preserveRef(p, rootR));
      if (persR) setPersonality((p) => preserveRef(p, persR));
      if (roleR) setRole((p) => preserveRef(p, roleR));
      if (gR) setGoogle((p) => preserveRef(p, gR));
      if (scR) setSidecars((p) => preserveRef(p, scR));
      if (profR) setProfile((p) => preserveRef(p, profR));
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
      for (const entry of Object.values(llm.providers ?? {})) {
        const usesUrl = URL_BASED_KINDS.has(entry.kind);
        const needsKey = KEY_BASED_KINDS.has(entry.kind) && !OPTIONAL_KEY_KINDS.has(entry.kind);
        if ((!usesUrl || !!entry.base_url?.trim()) && (!needsKey || entry.has_api_key)) {
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
    };
  }, [llm, channelCfg, ttsCfg, sidecars]);

  // ── LLM actions (hot-reloaded) ──────────────────────────────────────

  /** Add/update a provider entry. Partial fields are merged with existing. */
  const upsertProvider = useCallback(
    async (
      name: string,
      input: { kind?: LLMProviderKind; api_key?: string; base_url?: string },
    ): Promise<ProviderTestResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { providers: { [name]: input } },
        );
        await refresh();
        return { ok: true, message: r.message || `Provider '${name}' saved.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  /** Remove a provider entry entirely. */
  const removeProvider = useCallback(
    async (name: string): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { providers: { [name]: null } },
        );
        await refresh();
        return { ok: true, message: r.message || `Provider '${name}' removed.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  /** Set or clear the single-LLM default model. `null` clears it. */
  const setDefaultModel = useCallback(
    async (ref: string | null): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { default: ref },
        );
        await refresh();
        return {
          ok: true,
          message: r.message || (ref ? `Default model set to ${ref}.` : "Default model cleared."),
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  /** Set or clear a tier's model. `null` clears the tier. */
  const setTierModel = useCallback(
    async (tier: LLMTier, ref: string | null): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          { tiers: { [tier]: ref } },
        );
        await refresh();
        return {
          ok: true,
          message: r.message || (ref ? `${tier} tier set to ${ref}.` : `${tier} tier cleared.`),
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  /**
   * Clear every tier slot in a single request. Used by the LLM mode-switch
   * (multi-tier -> single LLM) so the transition is atomic from the user's
   * perspective: one button click, one network round-trip, one refresh.
   */
  const clearAllTiers = useCallback(async (): Promise<ActionResult> => {
    try {
      const r = await postJson<{ ok: boolean; message: string }>(
        "/api/config/llm",
        { tiers: { conversation: null, high: null, medium: null, low: null } },
      );
      await refresh();
      return { ok: true, message: r.message || "All tiers cleared." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  /**
   * Switch the persisted LLM architecture mode. The choice is stored on the
   * backend so it survives reloads and the user can flip either direction at
   * any time. Switching to single also clears every tier in the same request
   * (atomic from the user's perspective) so router-first stays off and there's
   * no stale tier config left behind.
   */
  const setLLMMode = useCallback(
    async (mode: "single" | "multi-tier"): Promise<ActionResult> => {
      try {
        const body =
          mode === "single"
            ? { mode, tiers: { conversation: null, high: null, medium: null, low: null } }
            : { mode };
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/llm",
          body,
        );
        await refresh();
        return {
          ok: true,
          message:
            r.message ||
            (mode === "single"
              ? "Switched to single-LLM mode (tier config cleared)."
              : "Switched to multi-tier mode."),
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  /**
   * Test a provider's credentials. The `name` is the user's chosen provider
   * key (e.g. "anthropic" or "ollama-remote"). Optional overrides let the UI
   * test what's in a form field before the user clicks Save - without them,
   * the server uses currently-stored credentials.
   */
  const testProvider = useCallback(
    async (
      name: string,
      overrides?: { kind?: LLMProviderKind; model?: string; baseUrl?: string; apiKey?: string },
    ): Promise<ProviderTestResult> => {
      try {
        const body: Record<string, unknown> = { name };
        if (overrides?.kind) body.kind = overrides.kind;
        if (overrides?.model) body.model = overrides.model;
        if (overrides && Object.hasOwn(overrides, "baseUrl")) {
          body.base_url = overrides.baseUrl ?? "";
        }
        if (overrides?.apiKey) body.api_key = overrides.apiKey;
        const r = await postJson<{ ok: boolean; model?: string; models?: string[]; error?: string }>(
          "/api/config/llm/test",
          body,
        );
        if (r.ok) {
          return { ok: true, message: `${name}: ${r.model ?? "connected"}.`, models: r.models };
        }
        return { ok: false, message: r.error ?? "Test failed." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Test failed" };
      }
    },
    [],
  );

  // ── Channels (hot-applied by the daemon) ────────────────────────────
  const setTelegram = useCallback(
    async (input: {
      enabled?: boolean;
      bot_token?: string;
      allowed_users?: number[];
    }): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/channels",
          { telegram: input },
        );
        await refresh();
        return r.ok
          ? { ok: true, message: r.message || "Telegram saved and applied." }
          : { ok: false, message: r.message || "Failed to apply Telegram config." };
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
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/channels",
          { discord: input },
        );
        await refresh();
        return r.ok
          ? { ok: true, message: r.message || "Discord saved and applied." }
          : { ok: false, message: r.message || "Failed to apply Discord config." };
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
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/stt",
          body,
        );
        await refresh();
        return r.ok
          ? { ok: true, message: r.message || `STT set to ${provider}.` }
          : { ok: false, message: r.message || "Failed to apply STT config." };
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

  // ── Voice / Premium realtime (config write — /api/config/voice) ─────
  const setVoiceConfig = useCallback(
    async (patch: VoiceConfigPatch): Promise<ActionResult> => {
      try {
        const r = await postJson<{ ok: boolean; message: string }>(
          "/api/config/voice",
          patch,
        );
        await refresh();
        return { ok: true, message: r.message || "Voice settings saved." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
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
      const r = await postJson<{ ok: boolean; message: string }>(
        "/api/auth/google/disconnect",
        {},
      );
      await refresh();
      return r.ok
        ? { ok: true, message: r.message || "Google disconnected. Observers stopped." }
        : { ok: false, message: r.message || "Disconnect failed." };
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
    voiceCfg,
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

    // actions
    refresh,
    // New-shape LLM actions
    upsertProvider,
    removeProvider,
    setDefaultModel,
    setTierModel,
    clearAllTiers,
    setLLMMode,
    testProvider,
    setTelegram,
    setDiscord,
    setSTTProvider,
    setTTS,
    setVoiceConfig,
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
