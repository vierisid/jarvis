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
)

// AwarenessConfig controls screen and window observer behavior.
type AwarenessConfig struct {
	ScreenIntervalMs   int     `yaml:"screen_interval_ms"`
	WindowIntervalMs   int     `yaml:"window_interval_ms"`
	MinChangeThreshold float64 `yaml:"min_change_threshold"`
	StuckThresholdMs   int     `yaml:"stuck_threshold_ms"`
}

// SidecarTokenClaims is the JWT payload from the brain.
type SidecarTokenClaims struct {
	Sub   string `json:"sub"`
	Jti   string `json:"jti"`
	Sid   string `json:"sid"`
	Name  string `json:"name"`
	Brain string `json:"brain"`
	JWKS  string `json:"jwks"`
	Iat   int64  `json:"iat"`
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
	Type     string `json:"type"`      // always "inline"
	MimeType string `json:"mime_type"`
	Data     string `json:"data"`      // base64-encoded
}

func (BinaryDataInline) binaryMarker() {}

// BinaryDataRef references binary data sent in a separate WebSocket binary frame.
type BinaryDataRef struct {
	Type     string `json:"type"`      // always "ref"
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
	Type                    string                  `json:"type"`
	Hostname                string                  `json:"hostname"`
	OS                      string                  `json:"os"`
	Platform                string                  `json:"platform"`
	Capabilities            []SidecarCapability     `json:"capabilities"`
	UnavailableCapabilities []UnavailableCapability `json:"unavailable_capabilities,omitempty"`
}

// SidecarCapabilitiesUpdate is sent when config changes to sync capabilities with the brain.
type SidecarCapabilitiesUpdate struct {
	Type                    string                  `json:"type"`
	Capabilities            []SidecarCapability     `json:"capabilities"`
	UnavailableCapabilities []UnavailableCapability `json:"unavailable_capabilities,omitempty"`
}

// SidecarConfig is the YAML config file structure.
type SidecarConfig struct {
	Token        string              `yaml:"token"`
	Brain        string              `yaml:"brain"`
	Capabilities []SidecarCapability `yaml:"capabilities"`
	Terminal     TerminalConfig      `yaml:"terminal"`
	Filesystem   FilesystemConfig    `yaml:"filesystem"`
	Browser      BrowserConfig       `yaml:"browser"`
	Awareness    AwarenessConfig     `yaml:"awareness"`
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
	CDPPort    int    `yaml:"cdp_port"`
	ProfileDir string `yaml:"profile_dir"`
}

// RPCResult is returned by handlers.
type RPCResult struct {
	Result any        `json:"result"`
	Binary BinaryData `json:"binary,omitempty"`
}

// RPCHandler processes an RPC request.
type RPCHandler func(params map[string]any) (*RPCResult, error)
