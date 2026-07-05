package main

// SidecarCapability represents a feature the sidecar can provide.
type SidecarCapability = string

const (
	CapTerminal   SidecarCapability = "terminal"
	CapFilesystem SidecarCapability = "filesystem"
	CapDesktop    SidecarCapability = "desktop"
	CapBrowser    SidecarCapability = "browser"
	CapClipboard  SidecarCapability = "clipboard"
	CapScreenshot SidecarCapability = "screenshot"
	CapSystemInfo SidecarCapability = "system_info"
	CapAwareness  SidecarCapability = "awareness"
	CapOCR        SidecarCapability = "ocr"
	CapWindows    SidecarCapability = "windows"
	CapPebble     SidecarCapability = "pebble"
	CapSubPebble  SidecarCapability = "sub_pebble"
	// Host-sensing observers (moved out of the brain in the ambient/pebble
	// model — the sidecar is the agent that runs on the user's machine, so all
	// machine-level observation lives here and streams to the brain).
	CapFileWatch     SidecarCapability = "file_watch"
	CapProcesses     SidecarCapability = "processes"
	CapNotifications SidecarCapability = "notifications"
)

// AwarenessConfig controls screen and window observer behavior.
type AwarenessConfig struct {
	ScreenIntervalMs   int     `yaml:"screen_interval_ms"`
	WindowIntervalMs   int     `yaml:"window_interval_ms"`
	MinChangeThreshold float64 `yaml:"min_change_threshold"`
	StuckThresholdMs   int     `yaml:"stuck_threshold_ms"`
	OCREnabled         bool    `yaml:"ocr_enabled"`
	CaptureDir         string  `yaml:"capture_dir"`
}

// SidecarTokenClaims is the JWT payload from the brain.
type SidecarTokenClaims struct {
	Sub   string `json:"sub"`
	Jti   string `json:"jti"`
	Sid   string `json:"sid"`
	Name  string `json:"name"`
	Brain string `json:"brain"`
	JWKS  string `json:"jwks"`
	// Bid is the brain's anonymous telemetry id, stamped by the brain at
	// enrollment so the sidecar can report which brain it belongs to. Empty on
	// tokens issued before sidecar telemetry existed (re-enroll to populate).
	Bid string `json:"bid"`
	Iat int64  `json:"iat"`
}

// RPCRequest is a message from brain to sidecar.
type RPCRequest struct {
	Type   string         `json:"type"`
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// BinaryData is the interface for binary attachment metadata in events.
type BinaryData interface {
	binaryMarker()
}

// BinaryDataInline holds inline base64 binary data (e.g. screenshot < 256KB).
type BinaryDataInline struct {
	Type     string `json:"type"` // always "inline"
	MimeType string `json:"mime_type"`
	Data     string `json:"data"` // base64-encoded
}

func (BinaryDataInline) binaryMarker() {}

// BinaryDataRef references binary data sent in a separate WebSocket binary frame.
type BinaryDataRef struct {
	Type     string `json:"type"` // always "ref"
	RefID    string `json:"ref_id"`
	MimeType string `json:"mime_type"`
	Size     int    `json:"size"`
}

func (BinaryDataRef) binaryMarker() {}

// SidecarEvent is a message from sidecar to brain.
type SidecarEvent struct {
	Type      string         `json:"type"`
	EventType string         `json:"event_type"`
	Timestamp int64          `json:"timestamp"`
	Payload   map[string]any `json:"payload"`
	Priority  string         `json:"priority,omitempty"`
	Binary    BinaryData     `json:"binary,omitempty"`
}

// SidecarRegistration is sent on connect.
type SidecarRegistration struct {
	Type     string `json:"type"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Platform string `json:"platform"`
	// Version is the sidecar's own semver (sidecarVersion, "dev" for unstamped
	// local builds). The brain classifies it against its MIN/RECOMMENDED floors
	// to accept / suggest-update / hard-block on register.
	Version                 string                  `json:"version"`
	Capabilities            []SidecarCapability     `json:"capabilities"`
	UnavailableCapabilities []UnavailableCapability `json:"unavailable_capabilities,omitempty"`
	// Timezone is the machine's IANA zone (e.g. "Europe/Rome"), best-effort
	// ("" = unknown). Hosted brains run on UTC VPSs and use this for the
	// user's local-time crons; the hosting server schedules follow-the-night
	// maintenance with it.
	Timezone string `json:"timezone,omitempty"`
}

// SidecarCapabilitiesUpdate is sent when config changes to sync capabilities with the brain.
type SidecarCapabilitiesUpdate struct {
	Type                    string                  `json:"type"`
	Capabilities            []SidecarCapability     `json:"capabilities"`
	UnavailableCapabilities []UnavailableCapability `json:"unavailable_capabilities,omitempty"`
}

// SidecarConfig is the YAML config file structure.
type SidecarConfig struct {
	Token string `yaml:"token"`
	Brain string `yaml:"brain"`
	// HostedBaseURL overrides the usejarvis connect origin for the first-run
	// handshake. Honored ONLY in `-tags jarvisdebug` builds (see hosted.go);
	// release binaries always use the production origin.
	HostedBaseURL string              `yaml:"hosted_base_url,omitempty"`
	Capabilities  []SidecarCapability `yaml:"capabilities"`
	Terminal      TerminalConfig      `yaml:"terminal"`
	Filesystem    FilesystemConfig    `yaml:"filesystem"`
	Browser       BrowserConfig       `yaml:"browser"`
	Awareness     AwarenessConfig     `yaml:"awareness"`
	Preferences   PreferencesConfig   `yaml:"preferences"`
	Telemetry     TelemetryConfig     `yaml:"telemetry"`
}

// TelemetryConfig controls anonymous sidecar usage metrics. Independent of the
// brain's telemetry: it does NOT honor the brain's JARVIS_TELEMETRY/DO_NOT_TRACK
// env vars. Enabled is a pointer so a config file without the key reads as "on"
// (the opt-out default) rather than a zero-value false. Toggle it from the
// settings window's Privacy section or with JARVIS_SIDECAR_TELEMETRY=0.
type TelemetryConfig struct {
	// omitempty so an unset (default-on) config doesn't persist `enabled: null`;
	// an explicit true/false is a non-nil pointer and is still written.
	Enabled *bool `yaml:"enabled,omitempty"`
}

// PreferencesConfig holds user-facing sidecar preferences edited from the local
// settings window, grouped by UI category. Add fields over time.
type PreferencesConfig struct {
	// General
	StartAtStartup bool `yaml:"start_at_startup"` // register the sidecar to launch on login
	// Style
	EtherealPebble      bool `yaml:"ethereal_pebble"`       // fade the pebble out while idle, pop it back on activity
	EtherealIdleSeconds int  `yaml:"ethereal_idle_seconds"` // idle time before the pebble fades out (default 5)
}

type TerminalConfig struct {
	BlockedCommands []string `yaml:"blocked_commands"`
	DefaultShell    string   `yaml:"default_shell"`
	TimeoutMs       int      `yaml:"timeout_ms"`
}

type FilesystemConfig struct {
	BlockedPaths  []string `yaml:"blocked_paths"`
	MaxFileSizeKB int      `yaml:"max_file_size_kb"`
}

type BrowserConfig struct {
	// ExecutablePath optionally pins the Chromium-based browser to drive. When
	// empty the sidecar auto-detects one (the OS default browser if it is
	// Chromium-based, otherwise a known install: Chrome, Edge, Brave, ...).
	ExecutablePath string `yaml:"executable_path"`
	// ProfileDir is the dedicated user-data dir for Jarvis's automation browser
	// (kept separate from the user's own profile). Defaults to a temp dir.
	ProfileDir string `yaml:"profile_dir"`
	// CDPPort is retained for backward-compatible config files but is no longer
	// used: the sidecar drives the browser over an inherited CDP pipe
	// (--remote-debugging-pipe), not a TCP port.
	CDPPort int `yaml:"cdp_port"`
}

// RPCResult is returned by handlers.
//
// Handlers returning binary data should set BinaryRaw/BinaryMime (raw bytes)
// rather than pre-encoding into Binary. sendResult then inlines small payloads
// as base64 and routes large ones (>= the inline threshold) through a separate
// binary WebSocket frame, keeping the JSON message small. Binary remains for
// callers that have already built an inline descriptor.
type RPCResult struct {
	Result any        `json:"result"`
	Binary BinaryData `json:"binary,omitempty"`

	// BinaryRaw, when non-nil, is the raw binary payload; sendResult chooses
	// inline-vs-ref transport. Not serialized — it never travels as JSON.
	BinaryRaw  []byte `json:"-"`
	BinaryMime string `json:"-"`
}

// RPCHandler processes an RPC request.
type RPCHandler func(params map[string]any) (*RPCResult, error)
