//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// ── list_windows ──────────────────────────────────────────────────────

func handleListWindows(params map[string]any) (*RPCResult, error) {
	// Native EnumWindows — the previous implementation recompiled embedded
	// C# in a fresh PowerShell on every call (~0.7-1.5s); this is ~1ms.
	return &RPCResult{Result: map[string]any{"windows": enumTopWindows()}}, nil
}

// ── get_window_tree (desktop_snapshot) — uses UIAutomation COM ───────

func handleGetWindowTree(params map[string]any) (*RPCResult, error) {
	pid := 0
	if pidF, ok := params["pid"].(float64); ok {
		pid = int(pidF)
	}
	maxDepth := 8
	if d, ok := params["depth"].(float64); ok {
		maxDepth = int(d)
	}

	semantic, _ := params["semantic"].(bool)

	val, err := comThread.call(func(state *uiaState) (any, error) {
		return uiaInspect(state, pid, maxDepth, false, semantic)
	})
	if err != nil {
		return nil, fmt.Errorf("get_window_tree failed: %w", err)
	}

	result := val.(map[string]any)
	return &RPCResult{Result: result}, nil
}

// ── click_element — uses UIAutomation COM for all actions ────────────

func handleClickElement(params map[string]any) (*RPCResult, error) {
	elemID, ok := params["element_id"].(float64)
	if !ok {
		return nil, fmt.Errorf("missing required parameter: element_id")
	}

	action, _ := params["action"].(string)
	if action == "" {
		action = "click"
	}

	value, _ := params["value"].(string)

	val, err := comThread.call(func(state *uiaState) (any, error) {
		return uiaPerformAction(state, int(elemID), action, value)
	})
	if err != nil {
		return nil, fmt.Errorf("click_element (action=%s) failed: %w", action, err)
	}

	result := val.(map[string]any)
	return &RPCResult{Result: result}, nil
}

// ── type_text ────────────────────────────────────────────────────────

func handleTypeText(params map[string]any) (*RPCResult, error) {
	text, _ := params["text"].(string)
	if text == "" {
		return nil, fmt.Errorf("missing required parameter: text")
	}

	// If element_id is given, click it first to focus
	if elemID, ok := params["element_id"].(float64); ok {
		_, err := comThread.call(func(state *uiaState) (any, error) {
			return uiaPerformAction(state, int(elemID), "click", "")
		})
		if err != nil {
			return nil, fmt.Errorf("failed to click element before typing: %w", err)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Native SendInput — replaces a per-call PowerShell spawn running
	// SendKeys, which was slow (~250-500ms overhead), lossy on long/fast
	// text, and required metacharacter escaping.
	if err := typeTextNative(text); err != nil {
		return nil, fmt.Errorf("type_text failed: %w", err)
	}
	return &RPCResult{Result: map[string]any{"success": true, "chars": len([]rune(text))}}, nil
}

// ── press_keys ───────────────────────────────────────────────────────

func handlePressKeys(params map[string]any) (*RPCResult, error) {
	keys, _ := params["keys"].(string)
	if keys == "" {
		return nil, fmt.Errorf("missing required parameter: keys")
	}

	// Native SendInput chords — replaces per-call PowerShell SendKeys. This
	// also makes the `win` modifier a real Windows-key chord (SendKeys had
	// no Windows key; the old code sent an approximate ctrl+esc).
	if err := pressKeysNative(keys); err != nil {
		return nil, fmt.Errorf("press_keys failed: %w", err)
	}
	return &RPCResult{Result: map[string]any{"success": true, "keys": keys}}, nil
}

// ── launch_app ───────────────────────────────────────────────────────

func handleLaunchApp(params map[string]any) (*RPCResult, error) {
	executable, _ := params["executable"].(string)
	if executable == "" {
		return nil, fmt.Errorf("missing required parameter: executable")
	}
	args, err := extractArgs(params)
	if err != nil {
		return nil, fmt.Errorf("launch_app: %w", err)
	}

	escaped := strings.ReplaceAll(executable, "'", "''")
	argsClause := ""
	if args != "" {
		argsClause = fmt.Sprintf("-ArgumentList '%s'", strings.ReplaceAll(args, "'", "''"))
	}

	script := fmt.Sprintf(`
$p = Start-Process -FilePath '%s' %s -PassThru
@{ pid=$p.Id; name=$p.ProcessName } | ConvertTo-Json -Compress
`, escaped, argsClause)

	out, err := runPS(script, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("launch_app failed: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return nil, fmt.Errorf("parse result: %w", err)
	}

	// A spawned process is not an open app. The old handler returned success
	// immediately, so the very next tool call ("type into it") raced the
	// window and failed with "no window found for PID". Wait for a visible
	// window before declaring success — matching by PID first, then by
	// process name (packaged apps hand the window to a broker process, e.g.
	// calc.exe -> Calculator.exe).
	pid := toInt(result["pid"])
	win, matchedBy := waitForWindow(pid, executable, 5*time.Second)
	if win == nil {
		result["success"] = false
		result["window_visible"] = false
		result["note"] = fmt.Sprintf(
			"process started (pid %d) but no window appeared within 5s — the app may still be starting, be windowless, or have exited. Run desktop_list_windows to check before interacting; do NOT assume it is open.",
			pid)
		return &RPCResult{Result: result}, nil
	}

	result["success"] = true
	result["window_visible"] = true
	result["window_title"] = win.Title
	result["window_pid"] = win.Pid // may differ from launch pid for packaged apps
	if matchedBy == "process_name" {
		result["note"] = fmt.Sprintf("window belongs to pid %d (matched by process name; the launcher pid %d handed off) — use pid %d with desktop_snapshot/desktop_focus_window", win.Pid, pid, win.Pid)
	}
	return &RPCResult{Result: result}, nil
}

// ── focus_window ─────────────────────────────────────────────────────

func handleFocusWindow(params map[string]any) (*RPCResult, error) {
	pidF, ok := params["pid"].(float64)
	if !ok {
		return nil, fmt.Errorf("missing required parameter: pid")
	}
	pid := int(pidF)

	// Native — the previous implementation recompiled embedded C# in a fresh
	// PowerShell per call, and returned a bare boolean with no explanation.
	win, err := focusWindowNative(pid)
	if err != nil {
		return nil, fmt.Errorf("focus_window failed: %w", err)
	}
	return &RPCResult{Result: map[string]any{
		"success": true,
		"pid":     pid,
		"title":   win.Title,
	}}, nil
}

// ── find_element — uses UIAutomation COM ─────────────────────────────

func handleFindElement(params map[string]any) (*RPCResult, error) {
	pid := 0
	if pidF, ok := params["pid"].(float64); ok {
		pid = int(pidF)
	}

	automationId, _ := params["automation_id"].(string)
	name, _ := params["name"].(string)
	className, _ := params["class_name"].(string)
	controlType, _ := params["control_type"].(string)

	val, err := comThread.call(func(state *uiaState) (any, error) {
		return uiaFindElements(state, pid, automationId, name, className, controlType)
	})
	if err != nil {
		return nil, fmt.Errorf("find_element failed: %w", err)
	}

	result := val.(map[string]any)
	return &RPCResult{Result: result}, nil
}

// ── Helpers ──────────────────────────────────────────────────────────

// runPS executes a PowerShell script with a timeout and returns stdout.
func runPS(script string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-Command", script)
	hideSubprocessWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case string:
		i, _ := strconv.Atoi(n)
		return i
	}
	return 0
}
