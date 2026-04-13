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
	script := `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
public class WinEnum {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static List<Dictionary<string,object>> List() {
        var result = new List<Dictionary<string,object>>();
        var fg = GetForegroundWindow();
        EnumWindows((hWnd, _) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            var title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            RECT r; GetWindowRect(hWnd, out r);
            string procName = "";
            try { procName = Process.GetProcessById((int)pid).ProcessName; } catch {}
            var d = new Dictionary<string,object>();
            d["hwnd"] = (long)hWnd;
            d["title"] = title;
            d["pid"] = pid;
            d["process_name"] = procName;
            d["class_name"] = cls.ToString();
            d["left"] = r.Left; d["top"] = r.Top; d["right"] = r.Right; d["bottom"] = r.Bottom;
            d["is_foreground"] = hWnd == fg;
            result.Add(d);
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
[WinEnum]::List() | ConvertTo-Json -Depth 3 -Compress
`
	out, err := runPS(script, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("list_windows failed: %w", err)
	}

	var windows []map[string]any
	if err := json.Unmarshal([]byte(out), &windows); err != nil {
		// Single window comes as object, not array
		var single map[string]any
		if err2 := json.Unmarshal([]byte(out), &single); err2 == nil {
			windows = []map[string]any{single}
		} else {
			return nil, fmt.Errorf("parse windows: %w", err)
		}
	}

	return &RPCResult{Result: map[string]any{"windows": windows}}, nil
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

	val, err := comThread.call(func(state *uiaState) (any, error) {
		return uiaInspect(state, pid, maxDepth, false)
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

	// Use SendKeys for typing
	escaped := strings.ReplaceAll(text, "'", "''")

	script := fmt.Sprintf(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('%s')
Write-Output '{"success":true}'
`, escapeSendKeys(escaped))

	out, err := runPS(script, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("type_text failed: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return &RPCResult{Result: map[string]any{"success": true}}, nil
	}
	return &RPCResult{Result: result}, nil
}

// ── press_keys ───────────────────────────────────────────────────────

func handlePressKeys(params map[string]any) (*RPCResult, error) {
	keys, _ := params["keys"].(string)
	if keys == "" {
		return nil, fmt.Errorf("missing required parameter: keys")
	}

	sendKeysStr := convertToSendKeys(keys)

	script := fmt.Sprintf(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('%s')
Write-Output '{"success":true,"keys":"%s"}'
`, sendKeysStr, strings.ReplaceAll(keys, `"`, `\"`))

	out, err := runPS(script, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("press_keys failed: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return &RPCResult{Result: map[string]any{"success": true, "keys": keys}}, nil
	}
	return &RPCResult{Result: result}, nil
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
@{ success=$true; pid=$p.Id; name=$p.ProcessName } | ConvertTo-Json -Compress
`, escaped, argsClause)

	out, err := runPS(script, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("launch_app failed: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return nil, fmt.Errorf("parse result: %w", err)
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

	script := fmt.Sprintf(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class Focuser {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public static bool Focus(int pid) {
        var p = Process.GetProcessById(pid);
        if (p == null || p.MainWindowHandle == IntPtr.Zero) return false;
        ShowWindow(p.MainWindowHandle, 9); // SW_RESTORE
        return SetForegroundWindow(p.MainWindowHandle);
    }
}
'@
$ok = [Focuser]::Focus(%d)
@{ success=$ok; pid=%d } | ConvertTo-Json -Compress
`, pid, pid)

	out, err := runPS(script, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("focus_window failed: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return &RPCResult{Result: map[string]any{"success": true, "pid": pid}}, nil
	}
	return &RPCResult{Result: result}, nil
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
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// convertToSendKeys converts "ctrl,s" → "^s", "alt,f4" → "%{F4}", etc.
func convertToSendKeys(keys string) string {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(keys)), ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}

	modifiers := ""
	keyParts := []string{}

	for _, part := range parts {
		switch part {
		case "ctrl", "control":
			modifiers += "^"
		case "alt":
			modifiers += "%"
		case "shift":
			modifiers += "+"
		case "win":
			modifiers += "^{ESC}" // approximate
		default:
			keyParts = append(keyParts, part)
		}
	}

	if len(keyParts) == 0 {
		return modifiers
	}

	key := keyParts[0]
	mapped := mapKey(key)

	return modifiers + mapped
}

func mapKey(key string) string {
	switch strings.ToLower(key) {
	case "enter", "return":
		return "{ENTER}"
	case "tab":
		return "{TAB}"
	case "escape", "esc":
		return "{ESC}"
	case "backspace", "bs":
		return "{BACKSPACE}"
	case "delete", "del":
		return "{DELETE}"
	case "up":
		return "{UP}"
	case "down":
		return "{DOWN}"
	case "left":
		return "{LEFT}"
	case "right":
		return "{RIGHT}"
	case "home":
		return "{HOME}"
	case "end":
		return "{END}"
	case "pageup", "pgup":
		return "{PGUP}"
	case "pagedown", "pgdn":
		return "{PGDN}"
	case "space":
		return " "
	case "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12":
		return "{" + strings.ToUpper(key) + "}"
	default:
		if len(key) == 1 {
			return key
		}
		return "{" + strings.ToUpper(key) + "}"
	}
}

// escapeSendKeys escapes special SendKeys characters in user text.
func escapeSendKeys(text string) string {
	r := strings.NewReplacer(
		"+", "{+}",
		"^", "{^}",
		"%", "{%}",
		"~", "{~}",
		"(", "{(}",
		")", "{)}",
		"{", "{{}",
		"}", "{}}",
		"[", "{[}",
		"]", "{]}",
	)
	return r.Replace(text)
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
