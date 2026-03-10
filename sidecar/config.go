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

var configDir = filepath.Join(homeDir(), ".jarvis-sidecar")
var configFile = filepath.Join(configDir, "config.yaml")

func homeDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return os.Getenv("HOME")
	}
	return h
}

func defaultConfig() SidecarConfig {
	return SidecarConfig{
		Capabilities: []SidecarCapability{
			CapTerminal, CapFilesystem, CapClipboard, CapScreenshot, CapSystemInfo, CapAwareness, CapDesktop, CapBrowser,
		},
		Terminal: TerminalConfig{
			BlockedCommands: []string{},
			TimeoutMs:       30000,
		},
		Filesystem: FilesystemConfig{
			BlockedPaths:  []string{},
			MaxFileSizeKB: 100,
		},
		Browser: BrowserConfig{
			CDPPort: 9222,
		},
		Awareness: AwarenessConfig{
			ScreenIntervalMs:   7000,
			WindowIntervalMs:   2000,
			MinChangeThreshold: 0.02,
			StuckThresholdMs:   120000,
		},
	}
}

func LoadConfig() (*SidecarConfig, error) {
	cfg := defaultConfig()

	data, err := os.ReadFile(configFile)
	if err != nil {
		if os.IsNotExist(err) {
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
	}

	// Awareness defaults
	if cfg.Awareness.ScreenIntervalMs == 0 {
		cfg.Awareness.ScreenIntervalMs = 7000
	}
	if cfg.Awareness.WindowIntervalMs == 0 {
		cfg.Awareness.WindowIntervalMs = 2000
	}
	if cfg.Awareness.MinChangeThreshold == 0 {
		cfg.Awareness.MinChangeThreshold = 0.02
	}
	if cfg.Awareness.StuckThresholdMs == 0 {
		cfg.Awareness.StuckThresholdMs = 120000
	}

	return &cfg, nil
}

func SaveConfig(cfg *SidecarConfig) error {
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return err
	}
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(configFile, data, 0644)
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
