export type HeartbeatConfig = {
  interval_minutes: number;
  active_hours: { start: number; end: number };
  aggressiveness: 'passive' | 'moderate' | 'aggressive';
};

/**
 * System-level cron expressions. Published as `cron.<name>` events on the
 * shared event bus so other subsystems can react instead of polling.
 */
export type SystemCronConfig = {
  morning?: string;   // default "0 7 * * *"
  evening?: string;   // default "0 20 * * *"
  hourly?: string;    // default "37 * * * *"
};

export type GoogleConfig = {
  client_id: string;
  client_secret: string;
};

export type ChannelConfig = {
  telegram?: {
    enabled: boolean;
    bot_token: string;
    allowed_users: number[];  // Telegram user IDs
  };
  discord?: {
    enabled: boolean;
    bot_token: string;
    allowed_users: string[];  // Discord user IDs
    guild_id?: string;        // restrict to single guild
  };
};

export type WakeEngine = 'openwakeword' | 'webspeech' | 'auto';

/**
 * OpenAI realtime reasoning-effort ladder. Higher = more deliberate answers at
 * the cost of latency and tokens. User-selectable in the Voice settings UI.
 * Default is "low" (OpenAI's default for gpt-realtime-2).
 */
export type RealtimeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Premium opt-in speech-to-speech voice via OpenAI's Realtime API
 * (`gpt-realtime-2`). When enabled, the realtime session reuses the OpenAI
 * provider configured under `llm.providers` (matched by `kind: 'openai'`) -
 * there is no separate realtime key. When disabled (default) JARVIS uses the
 * standard STT -> text LLM -> TTS pipeline.
 *
 * See docs/GPT_REALTIME_2_INTEGRATION.md.
 */
export type RealtimeVoiceConfig = {
  /** Master opt-in. Default false. Env: JARVIS_REALTIME_VOICE. */
  enabled: boolean;
  /** Realtime model id. Default 'gpt-realtime-2'. */
  model?: string;
  /** OpenAI realtime voice id (e.g. 'marin', 'cedar'). */
  voice?: string;
  /** User-selectable reasoning effort (settings UI). Default 'low'. */
  reasoning_effort?: RealtimeReasoningEffort;
  /** Hard cap on a single realtime session length (cost guard). Default 10. */
  max_session_minutes?: number;
  /** Optional monthly USD spend ceiling; block new sessions past it. */
  monthly_budget_usd?: number;
  /**
   * Action categories that stay BLOCKED even though realtime auto-approves
   * everything else (safety backstop for destructive/irreversible tools).
   * When unset, defaults to all `destructive`-impact categories (payments,
   * deletes, shell exec, installs, settings changes, agent termination) so an
   * open mic can't trigger them unattended — see DEFAULT_BLOCKED_CATEGORIES.
   * Set to an explicit array (including `[]`) to override the default. Phase 3.
   */
  blocked_categories?: string[];
};

export type VoiceConfig = {
  /**
   * Wake-word engine used by the browser UI.
   *  - "openwakeword": local on-device model (default, private).
   *  - "webspeech":    browser SpeechRecognition (Chromium only; streams audio
   *                    to the browser vendor's cloud for transcription).
   *  - "auto":         prefer webspeech when available, fall back to openwakeword.
   * Env: JARVIS_WAKE_ENGINE
   */
  wake_engine: WakeEngine;
  /** Premium opt-in realtime speech-to-speech voice (gpt-realtime-2). */
  realtime?: RealtimeVoiceConfig;
};

export type STTConfig = {
  provider: 'openai' | 'groq' | 'local' | 'sarvam';
  openai?: { api_key: string; model?: string };
  groq?: { api_key: string; model?: string };
  local?: { endpoint: string; model?: string; server_type?: 'whisper_cpp' | 'openai_compatible' };
  sarvam?: { api_key: string; model?: string; language?: string };
};

export type TTSConfig = {
  enabled: boolean;
  provider?: 'edge' | 'elevenlabs' | 'sarvam';  // default: 'edge'
  voice?: string;       // e.g. 'en-US-AriaNeural' (edge)
  rate?: string;        // e.g. '+0%', '+10%' (edge)
  volume?: string;      // e.g. '+0%' (edge)
  elevenlabs?: {
    api_key: string;
    voice_id?: string;
    model?: string;           // 'eleven_flash_v2_5' | 'eleven_multilingual_v2'
    stability?: number;       // 0-1
    similarity_boost?: number; // 0-1
  };
  sarvam?: {
    api_key: string;
    model?: string;
    language?: string;
    speaker?: string;
    sampling_rate?: number;
  };
};

export type DesktopConfig = {
  enabled: boolean;
  sidecar_port: number;
  sidecar_path?: string;
  auto_launch: boolean;
  tree_depth: number;
  snapshot_max_elements: number;
};

export type AwarenessConfig = {
  enabled: boolean;
  capture_interval_ms: number;
  min_change_threshold: number;       // 0.0-1.0 pixel diff percentage
  cloud_vision_enabled: boolean;
  cloud_vision_cooldown_ms: number;
  stuck_threshold_ms: number;
  struggle_grace_ms: number;          // min time before struggle fires
  struggle_cooldown_ms: number;       // min gap between struggle detections
  suggestion_rate_limit_ms: number;
  overlay_autolaunch: boolean;        // auto-open floating overlay widget on start
  retention: {
    full_hours: number;
    key_moment_hours: number;
  };
};

export type PerActionOverride = {
  action: string;            // ActionCategory
  role_id?: string;
  allowed: boolean;
  requires_approval?: boolean;
};

export type ContextRule = {
  id: string;
  action: string;            // ActionCategory
  condition: 'time_range' | 'tool_name' | 'always';
  params: Record<string, unknown>;
  effect: 'allow' | 'deny' | 'require_approval';
  description: string;
};

export type AuthorityConfig = {
  default_level: number;
  governed_categories: string[];       // ActionCategory[]
  overrides: PerActionOverride[];
  context_rules: ContextRule[];
  learning: {
    enabled: boolean;
    suggest_threshold: number;
  };
  emergency_state: 'normal' | 'paused' | 'killed';
};

export type WorkflowConfig = {
  enabled: boolean;
  maxConcurrentExecutions: number;
  defaultRetries: number;
  defaultTimeoutMs: number;
  selfHealEnabled: boolean;
  autoSuggestEnabled: boolean;
};

export type GoalConfig = {
  enabled: boolean;
  morning_window: { start: number; end: number };
  evening_window: { start: number; end: number };
  accountability_style: 'drill_sergeant' | 'supportive' | 'balanced';
  escalation_weeks: { pressure: number; root_cause: number; suggest_kill: number };
  auto_decompose: boolean;
  calendar_ownership: boolean;
};

export type AuthConfig = {
  /** Shared secret token. If unset, auth is disabled (open access). Env: JARVIS_AUTH_TOKEN */
  token?: string;
};

export type UserConfig = {
  name?: string;
};

/**
 * Anonymous usage telemetry. Opt-out model: enabled by default so the
 * project can measure unique installs and retention. Disable with
 * `enabled: false`, the `JARVIS_TELEMETRY=0` env var, or the community
 * standard `DO_NOT_TRACK=1`.
 */
export type TelemetryConfig = {
  enabled: boolean;
};

/**
 * Onboarding completion state — persists in `~/.jarvis/config.yaml` so
 * the dashboard knows which phase (setup / profile interview / tutorial)
 * to show on next load. Each `*_completed_at` is a `Date.now()` stamp;
 * `null` means not yet done. Reset endpoint clears subsets per scope.
 *
 * See `docs/ONBOARDING_PLAN.md` for the gate logic and reset semantics.
 */
export type OnboardingConfig = {
  /** Phase A — LLM provider + key + model + TTS choice all saved. */
  setup_completed_at: number | null;
  /** Phase B opt-out — user clicked Skip on the profile interview. */
  setup_skipped_profile?: boolean;
  /** Phase C completion stamp. */
  tutorial_completed_at: number | null;
  /** Phase C dismissal stamp (one-shot snooze; user can replay). */
  tutorial_dismissed_at?: number | null;
  /** Resume key for an in-progress tutorial. */
  tutorial_progress_step?: string;
  /** Set by the reset endpoint — useful for debugging "did the reset
   *  actually fire" or rate-limiting accidental resets later. */
  last_reset_at?: number;
};

/**
 * LLM provider classes that the system knows how to instantiate. The `kind`
 * field on a provider entry selects one of these; the canonical default is
 * the provider's name (the key in `providers`).
 */
export type LLMProviderKind =
  | 'anthropic'
  | 'openai'
  | 'groq'
  | 'gemini'
  | 'ollama'
  | 'openrouter'
  | 'nvidia'
  | 'openai_compatible'
  | 'litellm';

/**
 * Credentials + endpoint for one provider instance. The `kind` field is
 * optional; when absent, the key in `LLMConfig.providers` is assumed to be
 * the provider class (e.g. `anthropic`). Specify `kind` explicitly when you
 * want multiple instances of the same class (e.g. two ollama backends with
 * different keys/URLs).
 */
export type LLMProviderEntry = {
  /** Which provider class to use. Defaults to the map key. */
  kind?: LLMProviderKind;
  /** API key for cloud providers. */
  api_key?: string;
  /** Base URL for self-hosted / local providers (ollama, openai-compatible, litellm). */
  base_url?: string;
};

/**
 * Model reference string in the form "<provider-name>:<model-id>" where
 * `provider-name` is a key in `LLMConfig.providers`. Examples:
 *   "anthropic:claude-sonnet-4-6"
 *   "openai:gpt-4o-mini"
 *   "ollama:llama3"
 *   "ollama-remote:qwen2.5"   (custom-named provider instance)
 */
export type LLMModelRef = string;

export type LLMTiersConfig = {
  conversation?: LLMModelRef;
  high?: LLMModelRef;
  medium?: LLMModelRef;
  low?: LLMModelRef;
};

export type LLMConfig = {
  /**
   * Provider credentials, keyed by the name you reference them as in model
   * strings. Set `kind` when you want a custom name (e.g. two ollama
   * instances "ollama-local" + "ollama-remote", both with kind=ollama).
   */
  providers?: Record<string, LLMProviderEntry>;

  /**
   * Single-LLM mode model reference. When set and `tiers` is absent, all
   * task tiers (low/medium/high) resolve to this model and the classic
   * orchestrator runs. Ignored when `tiers` is configured.
   */
  default?: LLMModelRef;

  /**
   * Per-tier model map. This is the in-memory runtime representation, sourced
   * EXCLUSIVELY from the DB (dashboard-managed) - it is NOT read from or
   * written to config.yaml. Any `llm.tiers` block in config.yaml is discarded
   * on load and stripped on save; only the single-LLM `default` may be set via
   * the config file. The `conversation` tier switches the system into
   * router-first mode (conv LLM delegates to task tiers); task tiers
   * (low/medium/high) without an explicit assignment fall up.
   */
  tiers?: LLMTiersConfig;
};

export type JarvisConfig = {
  user?: UserConfig;
  onboarding?: OnboardingConfig;
  telemetry?: TelemetryConfig;
  daemon: {
    port: number;
    data_dir: string;
    db_path: string;
    /**
     * Canonical origin signed into sidecar enrollment JWTs as the `brain`
     * (WebSocket) and `jwks` (public-key fetch) claims, so this is what the
     * sidecar will keep using once enrolled.
     *
     * NOT the brain's bind address. If the brain is fronted by a reverse
     * proxy or accessed across NAT, this must be the externally-reachable
     * URL (e.g. `https://brain.example.com` or `wss://brain.example.com`),
     * not the internal `localhost:PORT` the brain listens on.
     *
     * Accepts a full URL (`https://...`, `wss://...`) or a bare host[:port]
     * (`brain.example.com`, `10.0.0.5:3142`). Bare local hosts default to
     * ws/http; everything else defaults to wss/https.
     *
     * Precedence: `JARVIS_BRAIN_DOMAIN` env var > this field > internal
     * `localhost:<port>` fallback (with a startup warning).
     *
     * Sidecars must be able to reach both derived endpoints from the
     * enrolled machine, or JWKS fetch / WebSocket connect will fail until
     * the token is re-issued with a reachable origin.
     */
    brain_domain?: string;
  };
  auth?: AuthConfig;
  google?: GoogleConfig;
  channels?: ChannelConfig;
  stt?: STTConfig;
  tts?: TTSConfig;
  voice?: VoiceConfig;
  desktop?: DesktopConfig;
  awareness?: AwarenessConfig;
  llm: LLMConfig;
  personality: {
    core_traits: string[];
    assistant_name?: string;
  };
  workflows?: WorkflowConfig;
  goals?: GoalConfig;
  sites?: {
    enabled: boolean;
    projects_dir: string;
    port_range_start: number;
    port_range_end: number;
    auto_commit: boolean;
    max_concurrent_servers: number;
  };
  authority: AuthorityConfig;
  heartbeat: HeartbeatConfig;
  cron?: SystemCronConfig;
  active_role: string;  // role file name
};

export const DEFAULT_CONFIG: JarvisConfig = {
  user: {
    name: '',
  },
  telemetry: {
    enabled: true,
  },
  daemon: {
    port: 3142,
    data_dir: '~/.jarvis',
    db_path: '~/.jarvis/jarvis.db',
  },
  channels: {
    telegram: { enabled: false, bot_token: '', allowed_users: [] },
    discord: { enabled: false, bot_token: '', allowed_users: [] },
  },
  stt: {
    provider: 'openai',
  },
  tts: {
    enabled: false,
    provider: 'edge',
    voice: 'en-US-AriaNeural',
    rate: '+0%',
    volume: '+0%',
  },
  voice: {
    wake_engine: 'openwakeword',
    realtime: {
      enabled: false,
      model: 'gpt-realtime-2',
      reasoning_effort: 'low',
      max_session_minutes: 10,
    },
  },
  desktop: {
    enabled: true,
    sidecar_port: 9224,
    auto_launch: true,
    tree_depth: 5,
    snapshot_max_elements: 60,
  },
  awareness: {
    enabled: true,
    capture_interval_ms: 7000,
    min_change_threshold: 0.02,
    cloud_vision_enabled: true,
    cloud_vision_cooldown_ms: 30000,
    stuck_threshold_ms: 120000,
    struggle_grace_ms: 45000,
    struggle_cooldown_ms: 90000,
    suggestion_rate_limit_ms: 60000,
    overlay_autolaunch: true,
    retention: {
      full_hours: 1,
      key_moment_hours: 24,
    },
  },
  llm: {
    providers: {},
    tiers: {},
  },
  personality: {
    core_traits: [
      'loyal',
      'efficient',
      'proactive',
      'respectful',
      'adaptive',
    ],
    assistant_name: 'Jarvis',
  },
  sites: {
    enabled: true,
    projects_dir: '~/.jarvis/projects',
    port_range_start: 4000,
    port_range_end: 4999,
    auto_commit: true,
    max_concurrent_servers: 3,
  },
  authority: {
    default_level: 3,
    governed_categories: ['send_email', 'send_message', 'make_payment'],
    overrides: [],
    context_rules: [],
    learning: {
      enabled: true,
      suggest_threshold: 5,
    },
    emergency_state: 'normal',
  },
  heartbeat: {
    interval_minutes: 15,
    active_hours: { start: 8, end: 23 },
    aggressiveness: 'aggressive',
  },
  active_role: 'personal-assistant',
};
