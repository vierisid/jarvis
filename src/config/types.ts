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
  /**
   * SELF-HOSTED ONLY. Absent on a control-plane managed instance, which holds no
   * Google client credentials at all — see `refresh_url`. Optional so the
   * compiler makes every reader face that case instead of trusting a `''`.
   */
  client_id?: string;
  client_secret?: string;
  /**
   * HOSTED ONLY (usejarvis, GOOGLE.md "Push bridging"). Present when the control
   * plane runs a push bridge: Google notifies it, and it rings this instance's
   * doorbell so a change reflects in seconds instead of on the next poll.
   *
   * All three absent = self-hosted, or a deployment with no bridge. Polling then
   * covers everything, which is the designed fallback rather than a degraded
   * mode — so nothing here is required and nothing fails without it.
   */
  /** HMAC key the inbound doorbell is verified with (per instance). */
  notify_secret?: string;
  /** Pub/Sub topic to point Gmail's users.watch at. */
  pubsub_topic?: string;
  /** The bridge's public URL, for Calendar's events.watch callback. */
  push_callback?: string;
  /**
   * The token to set on the Calendar watch, which Google echoes back to the
   * bridge so it can tell which instance a notification belongs to. Rendered
   * whole by the control plane rather than built here from notify_secret — the
   * derivation would then live in two codebases, and a drifted token is a
   * notification the bridge refuses without anything looking wrong.
   */
  channel_token?: string;
  /**
   * Where the user connects Google, on the hosted account page.
   *
   * Its PRESENCE means this instance is control-plane MANAGED: there are no
   * client credentials in this file at all, the tokens are delivered rather than
   * obtained here, and this daemon's own OAuth flow must not run — its redirect
   * URI is this instance's own hostname, which is not registered with Google and
   * cannot be (there is one registered URI, on the control plane, precisely so a
   * VPS move does not break it).
   */
  connect_url?: string;
  /**
   * HMAC key this instance SIGNS its refresh requests with (hosted only).
   *
   * A different key from notify_secret, which the DOORBELL is verified with. The
   * two travel in opposite directions, and while one key served both, the same
   * signature was valid at either endpoint — safe only because the two body
   * shapes happen to be disjoint. Both are rendered whole by the control plane.
   */
  refresh_secret?: string;
  /**
   * Where this instance asks the control plane to refresh its access token.
   *
   * Present INSTEAD of client_id/client_secret on a managed instance: the
   * control plane holds those and applies them on our behalf, so no shared
   * credential sits in a file this daemon's own (tenant-owned) user can read.
   */
  refresh_url?: string;
  /** This instance's control-plane id, used to name itself when refreshing. */
  instance_id?: string;
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
  /**
   * `usejarvis` is a pure string choice: the hosted "Usejarvis AI" STT rides
   * the system-owned `usejarvis_ai` credentials, which are threaded to
   * createSTTProvider as a separate argument and NEVER stored here (this
   * section persists as plaintext JSON in the DB settings store).
   */
  provider: 'openai' | 'groq' | 'local' | 'sarvam' | 'usejarvis';
  /**
   * ISO-639-1 hint sent to the Whisper-shaped providers (openai / groq /
   * local / usejarvis). Unset = auto-detect (the `language` param is omitted
   * from the request entirely) — a hosted product cannot assume its users
   * speak English, and Whisper detects reliably. Sarvam keeps its own
   * `sarvam.language` (different API, different codes).
   */
  language?: string;
  openai?: { api_key: string; model?: string };
  groq?: { api_key: string; model?: string };
  local?: { endpoint: string; model?: string; server_type?: 'whisper_cpp' | 'openai_compatible' };
  sarvam?: { api_key: string; model?: string; language?: string };
};

export type TTSConfig = {
  enabled: boolean;
  /**
   * Default: 'edge'. `usejarvis` is a pure string choice like the STT one:
   * the hosted credentials ride the factory's separate `hosted` argument
   * (never this persisted section).
   */
  provider?: 'edge' | 'elevenlabs' | 'sarvam' | 'usejarvis';
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
  /** Min gap between vision calls backed by a local signal (error/stuck/struggle). */
  cloud_vision_cooldown_ms: number;
  /** Min gap between signal-less "what's on screen now" vision calls. */
  cloud_vision_ambient_cooldown_ms: number;
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
  /**
   * How long an idle warm engine subprocess stays parked before being
   * killed, in ms. The parked engine holds ~100MB RSS; hosts that prefer
   * RAM over the respawn cost can lower this. Default 5 minutes. Must be
   * positive — non-positive values are ignored with a warning. The
   * JARVIS_ENGINE_IDLE_TTL_MS env var overrides this setting (workflows is
   * a user-owned section, so fleet operators tune via env instead).
   */
  engineIdleTtlMs?: number;
  /**
   * Where the workflow runtime finds READY-MADE artifacts instead of
   * building/installing its own. All optional; each path may contain a
   * `${version}` placeholder expanded from the `JARVIS_VERSION` env var
   * (useful when one machine keeps artifacts per installed version). Any
   * unset/missing path just means jarvis does the work itself, as usual.
   * The JARVIS_ENGINE_CACHE_ROOT / JARVIS_SHARED_PIECES_DIR /
   * JARVIS_PIECE_METADATA_CACHE env vars are honored as fallbacks; config
   * wins when both are set.
   */
  /** Dir holding prebuilt engine bundles as `<hash>/main.js` — consulted
   * before building into `~/.jarvis/cache/engine`. */
  engine_dir?: string;
  /** Dir with a ready-made pieces catalog (`node_modules/@activepieces/...`).
   * Pieces here are usable without installing; a piece installed via the
   * Library into `~/.jarvis/pieces` shadows the copy found here. */
  pieces_dir?: string;
  /** A prebuilt piece-metadata cache FILE (the per-entry JSON the catalog
   * builder writes) — boots skip extraction for every piece it covers. */
  piece_metadata_cache?: string;
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
  /**
   * DANGEROUS - allow dashboard/API access WITHOUT an enrolled-device token.
   * The brain is JWT-only by default: enroll a device (`jarvis enroll`) and
   * connect through the sidecar. Set this ONLY for first-time self-host
   * setup before any device is enrolled, and remove it as soon as
   * enrollment is done. The daemon logs a loud warning while it is on.
   * SYSTEM-owned (config.yaml); there is no shared auth token anymore.
   */
  insecure_open_access?: boolean;
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
 * Onboarding completion state — persists in the vault DB settings store
 * (user-owned section) so the dashboard knows which phase (setup / profile
 * interview / tutorial) to show on next load. Each `*_completed_at` is a `Date.now()` stamp;
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
  | 'litellm'
  | 'omniroute'
  // Hosted "Usejarvis AI": the platform's LLM proxy, configured exclusively
  // by the root-owned config.yaml `usejarvis_ai` block (never the dashboard).
  | 'usejarvis_ai';

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
  /** Base URL for local providers and compatible API gateways. */
  base_url?: string;
  /** Header used to send api_key. Authorization values are prefixed with Bearer. */
  auth_header?: string;
  /**
   * usejarvis_ai entries only: the system-block prompt-cache opt-in,
   * carried through by applyUsejarvisAi so the binding layer can see it.
   * Unlike the user-level `llm.prompt_cache` toggle (default ON), this
   * defaults OFF — see the `usejarvis_ai.prompt_cache` block comment.
   */
  prompt_cache?: boolean;
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

  /**
   * Provider-side prompt caching (Anthropic cache_control; OpenAI caching is
   * automatic). DB/dashboard-sourced like `tiers` - never read from
   * config.yaml. Absent means enabled; only an explicit false disables it.
   */
  prompt_cache?: boolean;
};

export type JarvisConfig = {
  /**
   * Hosted-LLM access (SYSTEM-owned, file-authoritative): written by the
   * hosting provisioner into the root-owned config.yaml, never by the brain
   * or dashboard. Survives the user-section discard (not listed in
   * USER_OWNED_SECTIONS) and is re-applied over every DB merge by
   * applyUsejarvisAi (daemon/usejarvis-ai.ts). Absent on self-hosted installs.
   */
  usejarvis_ai?: {
    base_url?: string;
    api_key?: string;
    /**
     * Where this instance reads its OWN usage meter, and how it proves it is
     * itself (control plane: POST /api/llm/instance-usage).
     *
     * In THIS block rather than under `google` — where `instance_id` also
     * appears — because the meter is hosted-only and this block is exactly the
     * hosted marker, while the google fields exist only when Google is
     * configured. A hosted tenant who never connects Google still has a meter.
     *
     * All three or none: a partial set cannot authenticate, and treating it as
     * present would poll a control plane that answers 401 on a timer.
     */
    usage_url?: string;
    instance_id?: string;
    usage_secret?: string;
    /**
     * OPT-IN for Anthropic prompt-cache breakpoints on hosted LLM calls
     * (margin-critical when on: cached reads bill at ~0.1x fresh input).
     * Absent/false means OFF.
     *
     * MUST REMAIN false FLEET-WIDE until the platform ships per-tenant
     * upstream credentials. Platform-verified 2026-08-19: the prompt cache
     * namespace follows the single upstream api_key shared by every tenant
     * — a cross-tenant cache_read on a never-sent prefix was measured. A
     * shared namespace is a byte-level confirmation oracle on other
     * tenants' prompt prefixes (plus a 1.25x-write/0.1x-read billing
     * asymmetry), and no client-side mitigation exists. The fix is
     * platform-side; do not write `true` before it lands.
     *
     * Also verified 2026-08-19: cache_control forwarding is per-provider
     * (openai/ upstreams receive the marker VERBATIM — 400 risk — while
     * gemini/ drops it and anthropic/ translates and keeps it), so this
     * gate stays required even after the namespace fix unless emission
     * becomes vendor-aware; markers on tool-role messages ARE translated
     * and honoured (cached at tool_result.content depth), so the
     * last-user-message breakpoint anchor is safe.
     */
    prompt_cache?: boolean;
  };
  user?: UserConfig;
  onboarding?: OnboardingConfig;
  telemetry?: TelemetryConfig;
  daemon: {
    port: number;
    /**
     * SYSTEM-owned listen address. When set to `unix:/absolute/path.sock`
     * the daemon binds a unix-domain socket INSTEAD of the TCP port (no
     * port is opened at all). Hosted instances use this so Caddy is the
     * only way in: `listen: unix:/run/jarvis/u_<id>.sock`. Omit for the
     * self-host default (TCP on `port`).
     */
    listen?: string;
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
     * Legacy alias for `public_url`. Precedence is `JARVIS_PUBLIC_URL` /
     * `public_url`, then `JARVIS_BRAIN_DOMAIN` / this field, then the internal
     * `localhost:<port>` fallback (with a startup warning).
     *
     * Sidecars must be able to reach both derived endpoints from the
     * enrolled machine, or JWKS fetch / WebSocket connect will fail until
     * the token is re-issued with a reachable origin.
     */
    brain_domain?: string;
    /**
     * Canonical public HTTP(S) origin for OAuth callbacks, webhooks, dashboard
     * links, and sidecar enrollment. Prefer this clearer name for new
     * deployments; `brain_domain` remains a backwards-compatible alias.
     * Must be an origin with no path, query, fragment, or credentials.
     */
    public_url?: string;
    /**
     * Graceful-drain deadline (ms). On SIGTERM the daemon quiesces (stops
     * accepting new work) and waits up to this long for in-flight agent turns
     * and workflow runs to reach a safe point before tearing down. Kept UNDER
     * the supervisor's kill grace (hosted: systemd `TimeoutStopSec=90`) so the
     * drain finishes before SIGKILL. Default 75s.
     */
    drain_deadline_ms?: number;
  };
  auth?: AuthConfig;
  /**
   * SYSTEM-owned (config.yaml, not the DB): whether a LOCAL Chrome may be
   * launched on this machine. Hosted instances set `local: false` so no CDP
   * ports ever open on the VPS; browser actions route to a connected
   * sidecar's browser instead (the tools already prefer a `browser`-capable
   * sidecar and only fall back to local).
   */
  browser?: {
    local?: boolean;
  };
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
  /**
   * SYSTEM-owned: the user's IANA timezone (e.g. "America/New_York").
   * Hosted brains run on UTC VPSs; the hosting server writes this (from the
   * sidecar-reported value) so morning/evening crons, workflow triggers and
   * goal windows fire at the user's wall-clock times. Self-host: omit to use
   * the machine's local time.
   */
  timezone?: string;
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
  browser: {
    local: true,
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
    capture_interval_ms: 15000,
    min_change_threshold: 0.02,
    cloud_vision_enabled: true,
    cloud_vision_cooldown_ms: 30000,
    cloud_vision_ambient_cooldown_ms: 900000,
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

/**
 * Config sections that are USER-OWNED: they live in the vault DB settings
 * store (managed from the dashboard), never in config.yaml. loadConfig
 * discards any such section found in the file (after a one-time legacy
 * import at daemon boot; see daemon/user-settings.ts), exactly like the
 * `llm` block. config.yaml keeps only network/system/hosting keys:
 * daemon.*, auth, google (system-owned when present in the file).
 */
export const USER_OWNED_SECTIONS = [
  'user',
  'onboarding',
  'telemetry',
  'personality',
  'active_role',
  'authority',
  'heartbeat',
  'cron',
  'stt',
  'tts',
  'voice',
  'channels',
  'desktop',
  'awareness',
  'sites',
  'goals',
  'workflows',
] as const satisfies readonly (keyof JarvisConfig)[];

export type UserOwnedSection = (typeof USER_OWNED_SECTIONS)[number];

/**
 * The SYSTEM-owned keys of the otherwise user-owned `workflows` section:
 * ready-made artifact paths a deployment (e.g. a managed host) writes into
 * config.yaml. The FILE wins for these — loadConfig preserves them through
 * the user-section discard and the DB merge re-applies them on top, so a
 * dashboard save of the user-tunable workflow fields can never strip them.
 */
export const WORKFLOW_SYSTEM_KEYS = ["engine_dir", "pieces_dir", "piece_metadata_cache"] as const;
