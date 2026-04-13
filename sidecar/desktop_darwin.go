//go:build darwin

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
tell application "System Events"
	set windowList to ""
	set fg to name of first process whose frontmost is true
	repeat with proc in (every process whose background only is false)
		set procName to name of proc
		set procPID to unix id of proc
		try
			repeat with w in windows of proc
				set wTitle to name of w
				set wPos to position of w
				set wSize to size of w
				set windowList to windowList & procName & "|||" & procPID & "|||" & wTitle & "|||" & (item 1 of wPos) & "|||" & (item 2 of wPos) & "|||" & (item 1 of wSize) & "|||" & (item 2 of wSize) & "|||" & (procName = fg) & linefeed
			end repeat
		end try
	end repeat
	return windowList
end tell`

	out, err := runOsascript(script, 15*time.Second)
	if err != nil {
		return nil, fmt.Errorf("list_windows failed: %w", err)
	}

	windows := []map[string]any{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|||")
		if len(parts) < 8 {
			continue
		}
		procName := strings.TrimSpace(parts[0])
		pid, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
		title := strings.TrimSpace(parts[2])
		left, _ := strconv.Atoi(strings.TrimSpace(parts[3]))
		top, _ := strconv.Atoi(strings.TrimSpace(parts[4]))
		width, _ := strconv.Atoi(strings.TrimSpace(parts[5]))
		height, _ := strconv.Atoi(strings.TrimSpace(parts[6]))
		isFG := strings.TrimSpace(parts[7]) == "true"

		windows = append(windows, map[string]any{
			"title":        title,
			"pid":          pid,
			"process_name": procName,
			"left":         left,
			"top":          top,
			"right":        left + width,
			"bottom":       top + height,
			"is_foreground": isFG,
		})
	}

	return &RPCResult{Result: map[string]any{"windows": windows}}, nil
}

// ── get_window_tree ────────────────────────────────────────────────────

func handleGetWindowTree(params map[string]any) (*RPCResult, error) {
	pid := 0
	if v, ok := params["pid"].(float64); ok {
		pid = int(v)
	}

	// If no PID given, resolve the frontmost process PID via AppleScript
	if pid == 0 {
		pidScript := `tell application "System Events" to unix id of first process whose frontmost is true`
		pidOut, err := runOsascript(pidScript, 5*time.Second)
		if err != nil {
			return nil, fmt.Errorf("get_window_tree: could not determine frontmost PID: %w", err)
		}
		pid, _ = strconv.Atoi(strings.TrimSpace(pidOut))
		if pid == 0 {
			return nil, fmt.Errorf("get_window_tree: frontmost PID resolved to 0")
		}
	}

	depth := 3
	if v, ok := params["depth"].(float64); ok {
		depth = int(v)
	}

	// Use JXA (JavaScript for Automation) to walk the accessibility tree
	jsScript := fmt.Sprintf(`
ObjC.import('stdlib')
var se = Application('System Events')
var maxDepth = %d
var procs = se.processes.whose({unixId: %d})
if (procs.length === 0) {
    JSON.stringify({error: 'Process not found', pid: %d})
} else {
var proc = procs[0]
var elements = []
function walk(el, depth) {
    if (depth > maxDepth || elements.length > 200) return
    try {
        var role = el.role()
        var name = ''
        try { name = el.name() || '' } catch(e) {}
        var pos = [0, 0], sz = [0, 0]
        try { pos = el.position(); sz = el.size() } catch(e) {}
        if (sz[0] > 0 && sz[1] > 0) {
            elements.push({
                id: elements.length,
                name: String(name).substring(0, 100),
                control_type: role,
                automation_id: '',
                enabled: el.enabled(),
                focusable: el.focused !== undefined,
                rect: {x: pos[0], y: pos[1], w: sz[0], h: sz[1]}
            })
        }
        var children = el.uiElements()
        for (var i = 0; i < children.length && i < 50; i++) {
            walk(children[i], depth + 1)
        }
    } catch(e) {}
}
var wins = proc.windows()
for (var w = 0; w < wins.length; w++) { walk(wins[w], 0) }
var winTitle = ''
try { winTitle = proc.frontWindow ? proc.frontWindow.name() : (wins.length > 0 ? wins[0].name() : '') } catch(e) {}
JSON.stringify({window_title: winTitle, pid: %d, element_count: elements.length, elements: elements})
}`, depth, pid, pid, pid)

	out, err := runOsascriptJS(jsScript, 20*time.Second)
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

	action, _ := params["action"].(string)
	if action == "" {
		action = "click"
	}

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
		return nil, fmt.Errorf("element [%d] not found in cache — run desktop_snapshot first", id)
	}

	x := toInt(rect["x"]) + toInt(rect["w"])/2
	y := toInt(rect["y"]) + toInt(rect["h"])/2

	switch action {
	case "click":
		if err := clickAtCoords(x, y); err != nil {
			return nil, fmt.Errorf("click_element failed: %w", err)
		}
	case "double_click":
		if err := doubleClickAtCoords(x, y); err != nil {
			return nil, fmt.Errorf("double_click failed: %w", err)
		}
	case "right_click":
		if err := rightClickAtCoords(x, y); err != nil {
			return nil, fmt.Errorf("right_click failed: %w", err)
		}
	case "focus":
		if err := clickAtCoords(x, y); err != nil {
			return nil, fmt.Errorf("focus failed: %w", err)
		}
	default:
		return nil, fmt.Errorf("action '%s' is not supported on macOS (supported: click, double_click, right_click, focus)", action)
	}

	return &RPCResult{Result: map[string]any{"success": true, "action": action, "x": x, "y": y}}, nil
}

// clickAtCoords performs a left-click at the given screen coordinates.
// It tries cliclick first (if available), then falls back to python3 + Quartz.
func clickAtCoords(x, y int) error {
	// Try cliclick first (brew install cliclick)
	if _, err := exec.LookPath("cliclick"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, "cliclick", fmt.Sprintf("c:%d,%d", x, y)).Run()
	}

	// Fallback: python3 + Quartz.CoreGraphics (available on macOS with Xcode CLT)
	pyScript := fmt.Sprintf(`
from Quartz.CoreGraphics import *
import time
pt = CGPointMake(%d, %d)
ev = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, pt, kCGMouseButtonLeft)
CGEventPost(kCGHIDEventTap, ev)
time.sleep(0.05)
ev = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, pt, kCGMouseButtonLeft)
CGEventPost(kCGHIDEventTap, ev)
`, x, y)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "python3", "-c", pyScript).Run()
}

// ── type_text ────────────────────────────────────────────────────────

func handleTypeText(params map[string]any) (*RPCResult, error) {
	text, _ := params["text"].(string)
	if text == "" {
		return nil, fmt.Errorf("missing required parameter: text")
	}

	// If element_id is given, click it first to focus it
	if elemID, ok := params["element_id"].(float64); ok {
		if _, err := handleClickElement(map[string]any{"element_id": elemID}); err != nil {
			return nil, fmt.Errorf("failed to click element before typing: %w", err)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Escape backslashes and double-quotes for AppleScript string literal
	escaped := strings.ReplaceAll(text, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)

	script := fmt.Sprintf(`tell application "System Events" to keystroke "%s"`, escaped)
	if _, err := runOsascript(script, 10*time.Second); err != nil {
		return nil, fmt.Errorf("type_text failed: %w", err)
	}

	return &RPCResult{Result: map[string]any{"success": true}}, nil
}

// ── press_keys ───────────────────────────────────────────────────────

func handlePressKeys(params map[string]any) (*RPCResult, error) {
	keys, _ := params["keys"].(string)
	if keys == "" {
		return nil, fmt.Errorf("missing required parameter: keys")
	}

	script := convertKeysToOsascript(keys)
	if _, err := runOsascript(script, 5*time.Second); err != nil {
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

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Use "open -a" for .app bundles; fall back to direct exec for plain binaries
	if strings.HasSuffix(executable, ".app") || !strings.Contains(executable, "/") {
		// Looks like an app name or .app bundle — use open -a
		var cmd *exec.Cmd
		if args != "" {
			cmd = exec.CommandContext(ctx, "open", "-a", executable, "--args", args)
		} else {
			cmd = exec.CommandContext(ctx, "open", "-a", executable)
		}

		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("launch_app: open -a %q failed: %w", executable, err)
		}

		// Wait briefly for the app to register, then resolve its PID
		time.Sleep(500 * time.Millisecond)

		name := executable
		if strings.HasSuffix(name, ".app") {
			name = name[:len(name)-4]
		}
		if idx := strings.LastIndex(name, "/"); idx >= 0 {
			name = name[idx+1:]
		}

		pgrepOut, _ := exec.Command("pgrep", "-n", name).Output()
		pidStr := strings.TrimSpace(string(pgrepOut))
		pid, _ := strconv.Atoi(pidStr)
		if pid == 0 {
			return nil, fmt.Errorf("launch_app: open -a %q succeeded but process PID could not be resolved via pgrep %q", executable, name)
		}
		return &RPCResult{Result: map[string]any{"success": true, "pid": pid, "name": name}}, nil
	}

	// Absolute/relative path to a binary — start detached
	var cmd *exec.Cmd
	if args != "" {
		cmd = exec.CommandContext(ctx, executable, strings.Fields(args)...)
	} else {
		cmd = exec.CommandContext(ctx, executable)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("launch_app: failed to start %q: %w", executable, err)
	}

	// Detach: don't wait, let the child run independently
	go func() { _ = cmd.Wait() }()

	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
	}
	if pid == 0 {
		return nil, fmt.Errorf("launch_app: started %q but could not obtain process ID", executable)
	}

	name := executable
	if idx := strings.LastIndex(executable, "/"); idx >= 0 {
		name = executable[idx+1:]
	}

	return &RPCResult{Result: map[string]any{"success": true, "pid": pid, "name": name}}, nil
}

// ── focus_window ─────────────────────────────────────────────────────

func handleFocusWindow(params map[string]any) (*RPCResult, error) {
	pidF, ok := params["pid"].(float64)
	if !ok {
		return nil, fmt.Errorf("missing required parameter: pid")
	}
	pid := int(pidF)

	script := fmt.Sprintf(`
tell application "System Events"
	set proc to first process whose unix id is %d
	set frontmost of proc to true
end tell`, pid)

	_, err := runOsascript(script, 5*time.Second)
	success := err == nil

	return &RPCResult{Result: map[string]any{"success": success, "pid": pid}}, nil
}

// doubleClickAtCoords performs a double-click at screen coordinates.
func doubleClickAtCoords(x, y int) error {
	if _, err := exec.LookPath("cliclick"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, "cliclick", fmt.Sprintf("dc:%d,%d", x, y)).Run()
	}
	pyScript := fmt.Sprintf(`
from Quartz.CoreGraphics import *
import time
pt = CGPointMake(%d, %d)
for _ in range(2):
    ev = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, pt, kCGMouseButtonLeft)
    CGEventSetIntegerValueField(ev, kCGMouseEventClickState, 2)
    CGEventPost(kCGHIDEventTap, ev)
    ev = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, pt, kCGMouseButtonLeft)
    CGEventSetIntegerValueField(ev, kCGMouseEventClickState, 2)
    CGEventPost(kCGHIDEventTap, ev)
    time.sleep(0.05)
`, x, y)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "python3", "-c", pyScript).Run()
}

// rightClickAtCoords performs a right-click at screen coordinates.
func rightClickAtCoords(x, y int) error {
	if _, err := exec.LookPath("cliclick"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, "cliclick", fmt.Sprintf("rc:%d,%d", x, y)).Run()
	}
	pyScript := fmt.Sprintf(`
from Quartz.CoreGraphics import *
import time
pt = CGPointMake(%d, %d)
ev = CGEventCreateMouseEvent(None, kCGEventRightMouseDown, pt, kCGMouseButtonRight)
CGEventPost(kCGHIDEventTap, ev)
time.sleep(0.05)
ev = CGEventCreateMouseEvent(None, kCGEventRightMouseUp, pt, kCGMouseButtonRight)
CGEventPost(kCGHIDEventTap, ev)
`, x, y)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "python3", "-c", pyScript).Run()
}

// ── find_element ─────────────────────────────────────────────────────

func handleFindElement(params map[string]any) (*RPCResult, error) {
	// Snapshot the tree to populate the cache, then filter in Go
	_, err := handleGetWindowTree(params)
	if err != nil {
		return nil, fmt.Errorf("find_element failed: %w", err)
	}

	name, _ := params["name"].(string)
	controlType, _ := params["control_type"].(string)
	className, _ := params["class_name"].(string)
	// automation_id is ignored on macOS (not an accessibility concept)

	elementCache.mu.Lock()
	defer elementCache.mu.Unlock()

	var matches []map[string]any
	for _, el := range elementCache.elements {
		if name != "" {
			elName, _ := el["name"].(string)
			if elName != name {
				continue
			}
		}
		if controlType != "" {
			elType, _ := el["control_type"].(string)
			if elType != controlType {
				continue
			}
		}
		if className != "" {
			elClass, _ := el["class_name"].(string)
			if elClass != className {
				continue
			}
		}
		matches = append(matches, el)
	}

	return &RPCResult{Result: map[string]any{
		"match_count": len(matches),
		"elements":    matches,
	}}, nil
}

// ── Helpers ───────────────────────────────────────────────────────────

// runOsascript runs an AppleScript via osascript and returns trimmed stdout.
func runOsascript(script string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "osascript", "-e", script)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// runOsascriptJS runs a JXA (JavaScript for Automation) script via osascript -l JavaScript.
func runOsascriptJS(script string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "osascript", "-l", "JavaScript", "-e", script)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// convertKeysToOsascript converts a comma-separated key spec like "cmd,s" or
// "ctrl,shift,a" into a complete AppleScript tell-block for System Events.
//
// Modifier names: ctrl/control, alt/option, shift, cmd/command/super/win
// Special key names map to AppleScript key codes.
func convertKeysToOsascript(keys string) string {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(keys)), ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}

	var modifiers []string
	var keyParts []string

	for _, part := range parts {
		switch part {
		case "ctrl", "control":
			modifiers = append(modifiers, "control down")
		case "alt", "option":
			modifiers = append(modifiers, "option down")
		case "shift":
			modifiers = append(modifiers, "shift down")
		case "cmd", "command", "super", "win":
			modifiers = append(modifiers, "command down")
		default:
			keyParts = append(keyParts, part)
		}
	}

	usingClause := ""
	if len(modifiers) > 0 {
		usingClause = fmt.Sprintf(" using {%s}", strings.Join(modifiers, ", "))
	}

	if len(keyParts) == 0 {
		// No key, just modifiers — nothing meaningful to send
		return `tell application "System Events" to keystroke ""`
	}

	key := keyParts[0]

	// Check for special keys that require key code
	if keyCode, isSpecial := osascriptKeyCode(key); isSpecial {
		return fmt.Sprintf(`tell application "System Events" to key code %d%s`, keyCode, usingClause)
	}

	// Single printable character — use keystroke
	escaped := strings.ReplaceAll(key, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return fmt.Sprintf(`tell application "System Events" to keystroke "%s"%s`, escaped, usingClause)
}

// osascriptKeyCode maps special key names to AppleScript key codes.
// Returns (keyCode, true) for known special keys, (0, false) otherwise.
func osascriptKeyCode(key string) (int, bool) {
	keyCodes := map[string]int{
		"enter":    36,
		"return":   36,
		"tab":      48,
		"escape":   53,
		"esc":      53,
		"delete":   51,
		"backspace": 51,
		"space":    49,
		"up":       126,
		"down":     125,
		"left":     123,
		"right":    124,
		"home":     115,
		"end":      119,
		"pageup":   116,
		"pgup":     116,
		"pagedown": 121,
		"pgdn":     121,
		"f1":       122,
		"f2":       120,
		"f3":       99,
		"f4":       118,
		"f5":       96,
		"f6":       97,
		"f7":       98,
		"f8":       100,
		"f9":       101,
		"f10":      109,
		"f11":      103,
		"f12":      111,
	}
	if code, ok := keyCodes[strings.ToLower(key)]; ok {
		return code, true
	}
	return 0, false
}

// toInt converts common JSON number types to int.
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
