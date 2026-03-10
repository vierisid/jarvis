//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Element Cache ──────────────────────────────────────────────────────

// elementCache stores the last tree snapshot so click_element / type_text
// can reference elements by their [id] without re-walking the tree.
var elementCache struct {
	mu        sync.Mutex
	elements  []map[string]any
	pid       int
	timestamp time.Time
}

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

// ── get_window_tree (desktop_snapshot) ────────────────────────────────

func handleGetWindowTree(params map[string]any) (*RPCResult, error) {
	pid := 0
	if v, ok := params["pid"].(float64); ok {
		pid = int(v)
	}

	// Build the PowerShell script for UIAutomation tree walk
	pidFilter := ""
	if pid > 0 {
		pidFilter = fmt.Sprintf("$targetPid = %d", pid)
	} else {
		// Use foreground window's PID
		pidFilter = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FGW {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public static int GetPid() { var h = GetForegroundWindow(); uint p; GetWindowThreadProcessId(h, out p); return (int)p; }
}
'@
$targetPid = [FGW]::GetPid()`
	}

	script := fmt.Sprintf(`
%s
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$auto = [System.Windows.Automation.AutomationElement]
$root = $auto::RootElement
$pidProp = [System.Windows.Automation.AutomationElement]::ProcessIdProperty
$cond = New-Object System.Windows.Automation.PropertyCondition($pidProp, $targetPid)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

if ($win -eq $null) {
    Write-Output '{"error":"Window not found for PID","pid":' + $targetPid + '}'
    exit 0
}

$allCond = [System.Windows.Automation.Condition]::TrueCondition
$elements = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $allCond)

$result = @()
$id = 0
foreach ($el in $elements) {
    try {
        $name = $el.Current.Name
        $ctrl = $el.Current.ControlType.ProgrammaticName
        $autoId = $el.Current.AutomationId
        $r = $el.Current.BoundingRectangle
        $enabled = $el.Current.IsEnabled
        $hasKb = $el.Current.IsKeyboardFocusable

        # Skip invisible or unnamed elements (reduce noise)
        if ($r.Width -le 0 -or $r.Height -le 0) { continue }

        $d = @{
            id = $id
            name = if ($name) { $name } else { "" }
            control_type = $ctrl -replace 'ControlType\.', ''
            automation_id = if ($autoId) { $autoId } else { "" }
            enabled = $enabled
            focusable = $hasKb
            rect = @{ x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height }
        }
        $result += $d
        $id++
    } catch { continue }
}

$winName = $win.Current.Name
$output = @{
    window_title = $winName
    pid = $targetPid
    element_count = $result.Count
    elements = $result
}
$output | ConvertTo-Json -Depth 4 -Compress
`, pidFilter)

	out, err := runPS(script, 15*time.Second)
	if err != nil {
		return nil, fmt.Errorf("get_window_tree failed: %w", err)
	}

	var tree map[string]any
	if err := json.Unmarshal([]byte(out), &tree); err != nil {
		return nil, fmt.Errorf("parse tree: %w (%s)", err, truncate(out, 200))
	}

	// Cache elements for click/type reference
	if elems, ok := tree["elements"].([]any); ok {
		elementCache.mu.Lock()
		elementCache.elements = make([]map[string]any, 0, len(elems))
		for _, e := range elems {
			if m, ok := e.(map[string]any); ok {
				elementCache.elements = append(elementCache.elements, m)
			}
		}
		elementCache.pid = pid
		elementCache.timestamp = time.Now()
		elementCache.mu.Unlock()
	}

	return &RPCResult{Result: tree}, nil
}

// ── click_element ────────────────────────────────────────────────────

func handleClickElement(params map[string]any) (*RPCResult, error) {
	elemID, ok := params["element_id"].(float64)
	if !ok {
		return nil, fmt.Errorf("missing required parameter: element_id")
	}
	id := int(elemID)

	// Look up cached element for its bounding rect
	elementCache.mu.Lock()
	var rect map[string]any
	if id >= 0 && id < len(elementCache.elements) {
		if r, ok := elementCache.elements[id]["rect"].(map[string]any); ok {
			rect = r
		}
	}
	elementCache.mu.Unlock()

	if rect == nil {
		return nil, fmt.Errorf("element [%d] not found in cache — run get_window_tree first", id)
	}

	// Calculate center of element
	x := toInt(rect["x"]) + toInt(rect["w"])/2
	y := toInt(rect["y"]) + toInt(rect["h"])/2

	script := fmt.Sprintf(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Clicker {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); // LEFTDOWN
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); // LEFTUP
    }
}
'@
[Clicker]::Click(%d, %d)
Write-Output '{"success":true,"x":%d,"y":%d}'
`, x, y, x, y)

	out, err := runPS(script, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("click_element failed: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return &RPCResult{Result: map[string]any{"success": true, "x": x, "y": y}}, nil
	}
	return &RPCResult{Result: result}, nil
}

// ── type_text ────────────────────────────────────────────────────────

func handleTypeText(params map[string]any) (*RPCResult, error) {
	text, _ := params["text"].(string)
	if text == "" {
		return nil, fmt.Errorf("missing required parameter: text")
	}

	// If element_id is given, click it first
	if elemID, ok := params["element_id"].(float64); ok {
		clickResult, err := handleClickElement(map[string]any{"element_id": elemID})
		if err != nil {
			return nil, fmt.Errorf("failed to click element before typing: %w", err)
		}
		_ = clickResult
		time.Sleep(100 * time.Millisecond)
	}

	// Escape text for PowerShell
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

	// Convert "ctrl,s" → "^s", "alt,f4" → "%{F4}", etc.
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
	args, _ := params["args"].(string)

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

	// Map special key names to SendKeys syntax
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
		// For single characters, return as-is
		if len(key) == 1 {
			return key
		}
		// For unknown keys, wrap in braces
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
