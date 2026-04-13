package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func NewHandlerRegistry(cfg *SidecarConfig, availableCaps []SidecarCapability, onReloaded func()) map[string]RPCHandler {
	caps := make(map[string]bool)
	for _, c := range availableCaps {
		caps[c] = true
	}

	registry := make(map[string]RPCHandler)

	if caps[CapTerminal] {
		registry["run_command"] = makeRunCommandHandler(cfg)
	}
	if caps[CapFilesystem] {
		registry["read_file"] = makeReadFileHandler(cfg)
		registry["write_file"] = makeWriteFileHandler(cfg)
		registry["list_directory"] = makeListDirectoryHandler(cfg)
	}
	if caps[CapClipboard] {
		registry["get_clipboard"] = handleGetClipboard
		registry["set_clipboard"] = handleSetClipboard
	}
	if caps[CapScreenshot] {
		registry["capture_screen"] = handleCaptureScreen
	}
	if caps[CapSystemInfo] {
		registry["get_system_info"] = handleGetSystemInfo
	}
	if caps[CapDesktop] {
		registry["list_windows"] = handleListWindows
		registry["get_window_tree"] = handleGetWindowTree
		registry["click_element"] = handleClickElement
		registry["type_text"] = handleTypeText
		registry["press_keys"] = handlePressKeys
		registry["launch_app"] = handleLaunchApp
		registry["focus_window"] = handleFocusWindow
		registry["find_element"] = handleFindElement
	}
	if caps[CapBrowser] {
		launchChromeIfNeeded(cfg)
		registry["browser_navigate"] = makeBrowserNavigateHandler(cfg)
		registry["browser_snapshot"] = makeBrowserSnapshotHandler(cfg)
		registry["browser_click"] = makeBrowserClickHandler(cfg)
		registry["browser_type"] = makeBrowserTypeHandler(cfg)
		registry["browser_screenshot"] = makeBrowserScreenshotHandler(cfg)
		registry["browser_scroll"] = makeBrowserScrollHandler(cfg)
		registry["browser_evaluate"] = makeBrowserEvaluateHandler(cfg)
	}

	// Administrative handlers — not gated by capability
	registry["get_config"] = makeGetConfigHandler(cfg)
	registry["update_config"] = makeUpdateConfigHandler(cfg, onReloaded)

	return registry
}

// --- Terminal ---

func makeRunCommandHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		command, _ := params["command"].(string)
		if command == "" {
			return nil, fmt.Errorf("missing required parameter: command")
		}

		cwd, _ := params["cwd"].(string)
		if cwd == "" {
			cwd, _ = os.Getwd()
		}

		timeoutMs := cfg.Terminal.TimeoutMs
		if t, ok := params["timeout"].(float64); ok && t > 0 {
			timeoutMs = int(t)
		}

		for _, blocked := range cfg.Terminal.BlockedCommands {
			if strings.Contains(command, blocked) {
				return &RPCResult{Result: map[string]any{
					"stdout":    "",
					"stderr":    fmt.Sprintf("Command blocked: %s", blocked),
					"exit_code": 1,
				}}, nil
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
		defer cancel()

		shell := cfg.Terminal.DefaultShell
		if shell == "" {
			shell = platformDefaultShell()
		}
		var cmd *exec.Cmd
		if shell == "cmd.exe" {
			cmd = exec.CommandContext(ctx, shell, "/C", command)
		} else {
			cmd = exec.CommandContext(ctx, shell, "-c", command)
		}
		cmd.Dir = cwd

		var stdoutBuf, stderrBuf strings.Builder
		cmd.Stdout = &stdoutBuf
		cmd.Stderr = &stderrBuf

		err := cmd.Run()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}

		return &RPCResult{Result: map[string]any{
			"stdout":    stdoutBuf.String(),
			"stderr":    stderrBuf.String(),
			"exit_code": exitCode,
		}}, nil
	}
}

// --- Filesystem ---

func isBlockedPath(filePath string, blockedPaths []string) bool {
	resolved, _ := filepath.Abs(filePath)
	for _, bp := range blockedPaths {
		abs, _ := filepath.Abs(bp)
		if strings.HasPrefix(resolved, abs) {
			return true
		}
	}
	return false
}

func makeReadFileHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		path, _ := params["path"].(string)
		if path == "" {
			return nil, fmt.Errorf("missing required parameter: path")
		}
		if isBlockedPath(path, cfg.Filesystem.BlockedPaths) {
			return nil, fmt.Errorf("path is blocked: %s", path)
		}

		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if info.Size() > int64(cfg.Filesystem.MaxFileSizeKB)*1024 {
			return nil, fmt.Errorf("file exceeds max size of %dKB", cfg.Filesystem.MaxFileSizeKB)
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"content": string(content)}}, nil
	}
}

func makeWriteFileHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		path, _ := params["path"].(string)
		content, _ := params["content"].(string)
		if path == "" {
			return nil, fmt.Errorf("missing required parameter: path")
		}
		if _, ok := params["content"]; !ok {
			return nil, fmt.Errorf("missing required parameter: content")
		}
		if isBlockedPath(path, cfg.Filesystem.BlockedPaths) {
			return nil, fmt.Errorf("path is blocked: %s", path)
		}

		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"success": true}}, nil
	}
}

func makeListDirectoryHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		dirPath, _ := params["path"].(string)
		if dirPath == "" {
			return nil, fmt.Errorf("missing required parameter: path")
		}
		if isBlockedPath(dirPath, cfg.Filesystem.BlockedPaths) {
			return nil, fmt.Errorf("path is blocked: %s", dirPath)
		}

		entries, err := os.ReadDir(dirPath)
		if err != nil {
			return nil, err
		}

		results := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			entryType := "file"
			if entry.IsDir() {
				entryType = "directory"
			}
			size := int64(0)
			if info, err := entry.Info(); err == nil {
				size = info.Size()
			}
			results = append(results, map[string]any{
				"name": entry.Name(),
				"type": entryType,
				"size": size,
			})
		}
		return &RPCResult{Result: map[string]any{"entries": results}}, nil
	}
}

// --- Clipboard ---

func runCmd(name string, args []string, input string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	out, err := cmd.Output()
	return string(out), err
}

func handleGetClipboard(params map[string]any) (*RPCResult, error) {
	content, err := platformClipboardRead()
	if err != nil {
		return nil, err
	}
	return &RPCResult{Result: map[string]any{"content": content}}, nil
}

func handleSetClipboard(params map[string]any) (*RPCResult, error) {
	content, _ := params["content"].(string)
	if _, ok := params["content"]; !ok {
		return nil, fmt.Errorf("missing required parameter: content")
	}

	if err := platformClipboardWrite(content); err != nil {
		return nil, err
	}
	return &RPCResult{Result: map[string]any{"success": true}}, nil
}

// --- Screenshot ---

func handleCaptureScreen(params map[string]any) (*RPCResult, error) {
	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("jarvis-screenshot-%d.png", time.Now().UnixMilli()))
	defer os.Remove(tmpFile)

	if err := platformCaptureScreen(tmpFile); err != nil {
		return nil, fmt.Errorf("screenshot capture failed: %w", err)
	}

	data, err := os.ReadFile(tmpFile)
	if err != nil {
		return nil, err
	}

	return &RPCResult{
		Result: map[string]any{"captured": true},
		Binary: BinaryDataInline{
			Type:     "inline",
			MimeType: "image/png",
			Data:     base64.StdEncoding.EncodeToString(data),
		},
	}, nil
}

// --- Config Management ---

func makeGetConfigHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return &RPCResult{Result: map[string]any{
			"capabilities": cfg.Capabilities,
			"terminal": map[string]any{
				"blocked_commands": cfg.Terminal.BlockedCommands,
				"default_shell":   cfg.Terminal.DefaultShell,
				"timeout_ms":      cfg.Terminal.TimeoutMs,
			},
			"filesystem": map[string]any{
				"blocked_paths":    cfg.Filesystem.BlockedPaths,
				"max_file_size_kb": cfg.Filesystem.MaxFileSizeKB,
			},
			"browser": map[string]any{
				"cdp_port":    cfg.Browser.CDPPort,
				"profile_dir": cfg.Browser.ProfileDir,
			},
			"awareness": map[string]any{
				"screen_interval_ms":   cfg.Awareness.ScreenIntervalMs,
				"window_interval_ms":   cfg.Awareness.WindowIntervalMs,
				"min_change_threshold": cfg.Awareness.MinChangeThreshold,
				"stuck_threshold_ms":   cfg.Awareness.StuckThresholdMs,
			},
		}}, nil
	}
}

func makeUpdateConfigHandler(cfg *SidecarConfig, onReloaded func()) RPCHandler {
	getConfig := makeGetConfigHandler(cfg)

	return func(params map[string]any) (*RPCResult, error) {
		// Update capabilities
		if caps, ok := params["capabilities"].([]any); ok {
			newCaps := make([]SidecarCapability, 0, len(caps))
			for _, c := range caps {
				if s, ok := c.(string); ok {
					newCaps = append(newCaps, s)
				}
			}
			cfg.Capabilities = newCaps
		}

		// Update terminal
		if terminal, ok := params["terminal"].(map[string]any); ok {
			if v, ok := terminal["timeout_ms"].(float64); ok {
				cfg.Terminal.TimeoutMs = int(v)
			}
			if v, ok := terminal["default_shell"].(string); ok {
				cfg.Terminal.DefaultShell = v
			}
			if v, ok := terminal["blocked_commands"].([]any); ok {
				cmds := make([]string, 0, len(v))
				for _, c := range v {
					if s, ok := c.(string); ok {
						cmds = append(cmds, s)
					}
				}
				cfg.Terminal.BlockedCommands = cmds
			}
		}

		// Update filesystem
		if fs, ok := params["filesystem"].(map[string]any); ok {
			if v, ok := fs["max_file_size_kb"].(float64); ok {
				cfg.Filesystem.MaxFileSizeKB = int(v)
			}
			if v, ok := fs["blocked_paths"].([]any); ok {
				paths := make([]string, 0, len(v))
				for _, p := range v {
					if s, ok := p.(string); ok {
						paths = append(paths, s)
					}
				}
				cfg.Filesystem.BlockedPaths = paths
			}
		}

		// Update browser
		if browser, ok := params["browser"].(map[string]any); ok {
			if v, ok := browser["cdp_port"].(float64); ok {
				cfg.Browser.CDPPort = int(v)
			}
			if v, ok := browser["profile_dir"].(string); ok {
				cfg.Browser.ProfileDir = v
			}
		}

		// Update awareness
		if awareness, ok := params["awareness"].(map[string]any); ok {
			if v, ok := awareness["screen_interval_ms"].(float64); ok {
				cfg.Awareness.ScreenIntervalMs = int(v)
			}
			if v, ok := awareness["window_interval_ms"].(float64); ok {
				cfg.Awareness.WindowIntervalMs = int(v)
			}
			if v, ok := awareness["min_change_threshold"].(float64); ok {
				cfg.Awareness.MinChangeThreshold = v
			}
			if v, ok := awareness["stuck_threshold_ms"].(float64); ok {
				cfg.Awareness.StuckThresholdMs = int(v)
			}
		}

		// Persist to disk
		if err := SaveConfig(cfg); err != nil {
			return nil, fmt.Errorf("failed to save config: %w", err)
		}

		if onReloaded != nil {
			onReloaded()
		}

		// Return updated config
		return getConfig(params)
	}
}

// --- System Info ---

func handleGetSystemInfo(params map[string]any) (*RPCResult, error) {
	hostname, _ := os.Hostname()
	return &RPCResult{Result: map[string]any{
		"hostname": hostname,
		"platform": runtime.GOOS,
		"arch":     runtime.GOARCH,
		"cpus":     runtime.NumCPU(),
		"uptime":   0, // Go stdlib doesn't expose system uptime easily
		"go_version": runtime.Version(),
	}}, nil
}

// --- Launch-App Helpers ---

// extractArgs extracts the "args" parameter from an RPC params map.
// It accepts:
//   - string:  returned as-is (e.g. "--verbose --output /tmp/foo")
//   - []any:   each element is fmt.Sprint'd and joined with spaces
//   - missing: returns ("", nil)
//
// Returns an error if "args" is present but has an unsupported type,
// so callers never silently ignore a malformed request.
func extractArgs(params map[string]any) (string, error) {
	raw, exists := params["args"]
	if !exists || raw == nil {
		return "", nil
	}
	switch v := raw.(type) {
	case string:
		return v, nil
	case []any:
		parts := make([]string, 0, len(v))
		for i, elem := range v {
			s, ok := elem.(string)
			if !ok {
				return "", fmt.Errorf("args[%d]: expected string, got %T", i, elem)
			}
			parts = append(parts, s)
		}
		return strings.Join(parts, " "), nil
	default:
		return "", fmt.Errorf("args: expected string or array, got %T", raw)
	}
}
