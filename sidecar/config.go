package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// The sidecar shares the ~/.jarvis data folder with the brain (they rarely run
// on the same host); its files are named distinctly so they can't collide with
// brain files (jarvis.pid, sidecar-keys/, the db, etc.). captures/ is shared.
var configDir = filepath.Join(homeDir(), ".jarvis")
var configFile = filepath.Join(configDir, "sidecar.yaml")

func homeDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return os.Getenv("HOME")
	}
	return h
}

// Built-in defaults for every value the user can override.
//
// Two rules keep these live rather than frozen into each install's config file
// at enrollment:
//
//  1. SaveConfig never writes a value that still equals its default
//     (sparseForSave), so sidecar.yaml only ever pins deliberate choices.
//  2. Values a previous release baked into every config file are listed in
//     supersededDefaults and treated as "not specified" on load, so the new
//     default applies to installs that already have the old one on disk.
//
// When you change a default here, add the value you are replacing to
// supersededDefaults. Without that, every existing install keeps the old
// behavior forever and the change only reaches fresh installs.
const (
	defaultTerminalTimeoutMs  = 30000
	defaultMaxFileSizeKB      = 100
	defaultCDPPort            = 9222
	defaultScreenIntervalMs   = 15000
	defaultWindowIntervalMs   = 5000
	defaultMinChangeThreshold = 0.02
	defaultStuckThresholdMs   = 120000
)

// currentConfigVersion is the number stamped into every config this build
// writes. Bump it when adding a migration below.
const currentConfigVersion = 1

// Defaults that shipped in an earlier release and were therefore written into
// existing sidecar.yaml files verbatim. Within a file that predates
// versioning, a stored value matching one of these is indistinguishable from
// "the installer wrote the default here", so it is read as unset and the
// current default wins.
//
// This applies ONLY to unversioned files, and only once — the load that
// migrates a file also stamps it, and every save from this build onward writes
// the stamp. Without that guard a user who deliberately picks the old value
// today (7s screen sampling is a perfectly reasonable choice) would find it
// silently reverted on the next restart.
//
// The residual trade-off is confined to unversioned files: someone who had
// deliberately chosen the old default before this build existed gets moved to
// the new one. There is no way to tell those two apart, and leaving every
// install pinned to enrollment-day defaults is the worse failure.
var supersededDefaults = struct {
	ScreenIntervalMs []int
	WindowIntervalMs []int
}{
	ScreenIntervalMs: []int{7000},
	WindowIntervalMs: []int{2000},
}

func isSuperseded(value int, superseded []int) bool {
	for _, v := range superseded {
		if value == v {
			return true
		}
	}
	return false
}

func defaultCaptureDir() string {
	return filepath.Join(homeDir(), ".jarvis", "captures")
}

func defaultConfig() SidecarConfig {
	return SidecarConfig{
		Capabilities: []SidecarCapability{
			CapTerminal, CapFilesystem, CapClipboard, CapScreenshot, CapSystemInfo, CapAwareness, CapDesktop, CapBrowser, CapOCR, CapWindows, CapPebble, CapSubPebble,
			CapFileWatch, CapProcesses, CapNotifications,
		},
		Terminal: TerminalConfig{
			BlockedCommands: []string{},
			TimeoutMs:       defaultTerminalTimeoutMs,
		},
		Filesystem: FilesystemConfig{
			BlockedPaths:  []string{},
			MaxFileSizeKB: defaultMaxFileSizeKB,
		},
		Browser: BrowserConfig{
			CDPPort: defaultCDPPort,
		},
		Awareness: AwarenessConfig{
			// Sampling rates are a cost knob, not just a CPU one: every capture
			// feeds the brain's awareness pipeline, and window polls emit a
			// context_changed event on every title change. 15s/5s keeps the
			// event stream legible without losing anything the brain acts on.
			ScreenIntervalMs:   defaultScreenIntervalMs,
			WindowIntervalMs:   defaultWindowIntervalMs,
			MinChangeThreshold: defaultMinChangeThreshold,
			StuckThresholdMs:   defaultStuckThresholdMs,
			OCREnabled:         true,
			CaptureDir:         defaultCaptureDir(),
		},
	}
}

func LoadConfig() (*SidecarConfig, error) {
	cfg := defaultConfig()

	data, err := os.ReadFile(configFile)
	if err != nil {
		if os.IsNotExist(err) {
			cfg.ConfigVersion = currentConfigVersion
			return &cfg, nil
		}
		return nil, err
	}

	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	// Ensure defaults for zero values
	if cfg.Terminal.TimeoutMs == 0 {
		cfg.Terminal.TimeoutMs = 30000
	}
	if cfg.Filesystem.MaxFileSizeKB == 0 {
		cfg.Filesystem.MaxFileSizeKB = 100
	}
	if cfg.Browser.CDPPort == 0 {
		cfg.Browser.CDPPort = 9222
	}
	if len(cfg.Capabilities) == 0 {
		cfg.Capabilities = defaultConfig().Capabilities
	} else {
		// Merge in any default capabilities that aren't already present in the
		// saved config. This makes new capabilities (e.g. CapWindows added in
		// Phase 2) auto-enable on existing installs without requiring users to
		// hand-edit ~/.jarvis-sidecar/config.yaml.
		have := make(map[SidecarCapability]bool, len(cfg.Capabilities))
		for _, c := range cfg.Capabilities {
			have[c] = true
		}
		for _, c := range defaultConfig().Capabilities {
			if !have[c] {
				cfg.Capabilities = append(cfg.Capabilities, c)
			}
		}
	}

	// Read the stamp off the raw file rather than off cfg: cfg was seeded from
	// defaultConfig(), so an absent key there is indistinguishable from a
	// current one.
	var probe struct {
		ConfigVersion int `yaml:"config_version"`
	}
	_ = yaml.Unmarshal(data, &probe)

	if probe.ConfigVersion < 1 {
		// Unversioned file: a value matching a superseded default is only there
		// because an older release wrote it, so read it as unset.
		if isSuperseded(cfg.Awareness.ScreenIntervalMs, supersededDefaults.ScreenIntervalMs) {
			cfg.Awareness.ScreenIntervalMs = 0
		}
		if isSuperseded(cfg.Awareness.WindowIntervalMs, supersededDefaults.WindowIntervalMs) {
			cfg.Awareness.WindowIntervalMs = 0
		}
	}
	cfg.ConfigVersion = currentConfigVersion

	// Awareness defaults
	if cfg.Awareness.ScreenIntervalMs == 0 {
		cfg.Awareness.ScreenIntervalMs = defaultScreenIntervalMs
	}
	if cfg.Awareness.WindowIntervalMs == 0 {
		cfg.Awareness.WindowIntervalMs = defaultWindowIntervalMs
	}
	if cfg.Awareness.MinChangeThreshold == 0 {
		cfg.Awareness.MinChangeThreshold = defaultMinChangeThreshold
	}
	if cfg.Awareness.StuckThresholdMs == 0 {
		cfg.Awareness.StuckThresholdMs = defaultStuckThresholdMs
	}
	if cfg.Awareness.CaptureDir == "" {
		cfg.Awareness.CaptureDir = defaultCaptureDir()
	}

	return &cfg, nil
}

// sparseForSave strips every value that still matches the built-in default so
// it is left out of the file (the tunables are tagged omitempty).
//
// Writing the fully-resolved config back is what pins an install to whatever
// the defaults happened to be on the day it enrolled: the file then specifies
// every value explicitly, and a later change to a default can never reach it.
// Callers keep working with the fully-populated in-memory config; only the
// on-disk form is sparse.
func sparseForSave(cfg *SidecarConfig) SidecarConfig {
	out := *cfg
	// Always stamped, never stripped: this is the record of which migrations
	// have run, not a tunable.
	out.ConfigVersion = currentConfigVersion
	if out.Terminal.TimeoutMs == defaultTerminalTimeoutMs {
		out.Terminal.TimeoutMs = 0
	}
	if out.Filesystem.MaxFileSizeKB == defaultMaxFileSizeKB {
		out.Filesystem.MaxFileSizeKB = 0
	}
	if out.Browser.CDPPort == defaultCDPPort {
		out.Browser.CDPPort = 0
	}
	if out.Awareness.ScreenIntervalMs == defaultScreenIntervalMs {
		out.Awareness.ScreenIntervalMs = 0
	}
	if out.Awareness.WindowIntervalMs == defaultWindowIntervalMs {
		out.Awareness.WindowIntervalMs = 0
	}
	if out.Awareness.MinChangeThreshold == defaultMinChangeThreshold {
		out.Awareness.MinChangeThreshold = 0
	}
	if out.Awareness.StuckThresholdMs == defaultStuckThresholdMs {
		out.Awareness.StuckThresholdMs = 0
	}
	if out.Awareness.CaptureDir == defaultCaptureDir() {
		out.Awareness.CaptureDir = ""
	}
	return out
}

func SaveConfig(cfg *SidecarConfig) error {
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(configDir, 0700); err != nil {
		return err
	}
	sparse := sparseForSave(cfg)
	data, err := yaml.Marshal(&sparse)
	if err != nil {
		return err
	}
	// O_NOFOLLOW prevents a hostile symlink at configFile from redirecting
	// the write to an unrelated target (e.g. ~/.bash_history).
	f, err := os.OpenFile(configFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|oNoFollow, 0600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Chmod(configFile, 0600)
}

func DecodeJWTPayload(token string) (*SidecarTokenClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid JWT format")
	}

	payload := parts[1]
	// Convert URL-safe base64 to standard
	payload = strings.ReplaceAll(payload, "-", "+")
	payload = strings.ReplaceAll(payload, "_", "/")
	// Add padding
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}

	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("decode JWT payload: %w", err)
	}

	var claims SidecarTokenClaims
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return nil, fmt.Errorf("parse JWT claims: %w", err)
	}
	return &claims, nil
}
