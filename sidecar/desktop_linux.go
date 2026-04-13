//go:build linux

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
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
	// Get the active window ID for is_foreground check
	activeWID := ""
	if out, err := runWithTimeout(3*time.Second, "xdotool", "getactivewindow"); err == nil {
		activeWID = strings.TrimSpace(out)
	}

	// Try wmctrl -lGp first (lists windows with geometry and PID)
	// Output format: <wid> <desktop> <pid> <x> <y> <w> <h> <hostname> <title>
	wmOut, wmErr := runWithTimeout(5*time.Second, "wmctrl", "-lGp")
	if wmErr == nil && strings.TrimSpace(wmOut) != "" {
		windows, err := parseWmctrlOutput(wmOut, activeWID)
		if err == nil {
			return &RPCResult{Result: map[string]any{"windows": windows}}, nil
		}
	}

	// Fallback: xdotool search + per-window queries
	widOut, err := runWithTimeout(5*time.Second, "xdotool", "search", "--onlyvisible", "--name", "")
	if err != nil {
		return nil, fmt.Errorf("list_windows failed: wmctrl unavailable (%v) and xdotool search failed: %w", wmErr, err)
	}

	wids := strings.Fields(strings.TrimSpace(widOut))
	windows := make([]map[string]any, 0, len(wids))
	for _, wid := range wids {
		w := buildWindowInfoFromXdotool(wid, activeWID)
		if w != nil {
			windows = append(windows, w)
		}
	}

	return &RPCResult{Result: map[string]any{"windows": windows}}, nil
}

// parseWmctrlOutput parses `wmctrl -lGp` output into window info maps.
// Line format: 0x04000001  0 12345  x y w h hostname Title Here
func parseWmctrlOutput(output, activeWID string) ([]map[string]any, error) {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	windows := make([]map[string]any, 0, len(lines))

	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		// wmctrl -lGp columns: wid desktop pid x y w h hostname title...
		fields := strings.Fields(line)
		if len(fields) < 9 {
			continue
		}

		wid := fields[0]
		pid, _ := strconv.Atoi(fields[2])
		x, _ := strconv.Atoi(fields[3])
		y, _ := strconv.Atoi(fields[4])
		w, _ := strconv.Atoi(fields[5])
		h, _ := strconv.Atoi(fields[6])
		// fields[7] is hostname, title starts at fields[8]
		title := strings.Join(fields[8:], " ")

		if title == "" {
			continue
		}

		procName := ""
		if pid > 0 {
			if out, err := runWithTimeout(2*time.Second, "ps", "-p", strconv.Itoa(pid), "-o", "comm="); err == nil {
				procName = strings.TrimSpace(out)
			}
		}

		// Convert wid hex string to int64 for hwnd field
		widInt, _ := strconv.ParseInt(strings.TrimPrefix(wid, "0x"), 16, 64)
		if widInt == 0 {
			// Try with leading zeros stripped
			widInt64, _ := strconv.ParseInt(wid, 0, 64)
			widInt = widInt64
		}

		windows = append(windows, map[string]any{
			"hwnd":         widInt,
			"title":        title,
			"pid":          pid,
			"process_name": procName,
			"left":         x,
			"top":          y,
			"right":        x + w,
			"bottom":       y + h,
			"is_foreground": wid == activeWID || fmt.Sprintf("%d", widInt) == activeWID,
		})
	}

	if len(windows) == 0 {
		return nil, fmt.Errorf("no windows parsed from wmctrl output")
	}
	return windows, nil
}

// buildWindowInfoFromXdotool queries a single window by xdotool wid.
func buildWindowInfoFromXdotool(wid, activeWID string) map[string]any {
	title, err := runWithTimeout(2*time.Second, "xdotool", "getwindowname", wid)
	if err != nil || strings.TrimSpace(title) == "" {
		return nil
	}
	title = strings.TrimSpace(title)

	pidStr, _ := runWithTimeout(2*time.Second, "xdotool", "getwindowpid", wid)
	pid, _ := strconv.Atoi(strings.TrimSpace(pidStr))

	procName := ""
	if pid > 0 {
		if out, err := runWithTimeout(2*time.Second, "ps", "-p", strconv.Itoa(pid), "-o", "comm="); err == nil {
			procName = strings.TrimSpace(out)
		}
	}

	// Get geometry via xdotool getwindowgeometry --shell
	left, top, right, bottom := 0, 0, 0, 0
	if geomOut, err := runWithTimeout(2*time.Second, "xdotool", "getwindowgeometry", "--shell", wid); err == nil {
		for _, gline := range strings.Split(geomOut, "\n") {
			parts := strings.SplitN(gline, "=", 2)
			if len(parts) != 2 {
				continue
			}
			val, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
			switch strings.TrimSpace(parts[0]) {
			case "X":
				left = val
			case "Y":
				top = val
			case "WIDTH":
				right = left + val
			case "HEIGHT":
				bottom = top + val
			}
		}
	}

	widInt, _ := strconv.ParseInt(strings.TrimPrefix(wid, "0x"), 16, 64)

	return map[string]any{
		"hwnd":          widInt,
		"title":         title,
		"pid":           pid,
		"process_name":  procName,
		"left":          left,
		"top":           top,
		"right":         right,
		"bottom":        bottom,
		"is_foreground": wid == activeWID,
	}
}

// ── get_window_tree (desktop_snapshot) ────────────────────────────────

// atSPIScript is the embedded Python3 script that walks the AT-SPI2 accessibility tree.
const atSPIScript = `
import gi, json, sys
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
pid = int(sys.argv[1])
max_depth = int(sys.argv[2]) if len(sys.argv) > 2 else 5
desktop = Atspi.get_desktop(0)
elements = []
def walk(node, depth=0):
    if depth > max_depth or len(elements) > 200:
        return
    try:
        role = node.get_role_name() or ''
        name = node.get_name() or ''
        comp = node.query_component()
        rect = {'x': 0, 'y': 0, 'w': 0, 'h': 0}
        if comp:
            try:
                ext = comp.get_extents(Atspi.CoordType.SCREEN)
                rect = {'x': ext.x, 'y': ext.y, 'w': ext.width, 'h': ext.height}
            except: pass
        if rect['w'] > 0 and rect['h'] > 0:
            elements.append({
                'id': len(elements), 'name': name[:100],
                'control_type': role, 'automation_id': '',
                'enabled': node.get_state_set().contains(Atspi.StateType.ENABLED),
                'focusable': node.get_state_set().contains(Atspi.StateType.FOCUSABLE),
                'rect': rect,
            })
        for i in range(min(node.get_child_count(), 100)):
            walk(node.get_child_at_index(i), depth + 1)
    except: pass
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    try:
        if app.get_process_id() != pid: continue
        for j in range(app.get_child_count()):
            walk(app.get_child_at_index(j))
        break
    except: pass
print(json.dumps({'elements': elements, 'element_count': len(elements)}))
`

func handleGetWindowTree(params map[string]any) (*RPCResult, error) {
	pid := 0
	if v, ok := params["pid"].(float64); ok {
		pid = int(v)
	}

	// Resolve PID from foreground window if not provided
	if pid == 0 {
		pidStr, err := runWithTimeout(3*time.Second, "xdotool", "getactivewindow", "getwindowpid")
		if err != nil {
			return nil, fmt.Errorf("get_window_tree: could not determine foreground window PID: %w", err)
		}
		pid, _ = strconv.Atoi(strings.TrimSpace(pidStr))
	}

	// Get window title for the result
	windowTitle := ""
	if out, err := runWithTimeout(3*time.Second, "xdotool", "search", "--pid", strconv.Itoa(pid), "getwindowname"); err == nil {
		// May return multiple lines; use first non-empty
		for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
			if strings.TrimSpace(line) != "" {
				windowTitle = strings.TrimSpace(line)
				break
			}
		}
	}

	depth := 5
	if v, ok := params["depth"].(float64); ok {
		depth = int(v)
	}

	// Try AT-SPI2 via python3
	tree, atSPIErr := tryATSPI(pid, depth)
	if atSPIErr == nil {
		// Merge in window title and pid
		tree["window_title"] = windowTitle
		tree["pid"] = pid

		// Cache elements
		if elems, ok := tree["elements"].([]any); ok {
			cacheElements(elems, pid)
		}

		return &RPCResult{Result: tree}, nil
	}

	// Fallback: basic info from xprop/xdotool
	return &RPCResult{Result: map[string]any{
		"window_title":  windowTitle,
		"pid":           pid,
		"element_count": 0,
		"elements":      []any{},
		"note":          "AT-SPI2 not available — install python3-gi and gir1.2-atspi-2.0 for full UI tree",
	}}, nil
}

// tryATSPI runs the embedded Python3 AT-SPI2 script and parses its output.
func tryATSPI(pid, depth int) (map[string]any, error) {
	// Write script to a temp file to avoid shell escaping issues
	tmpFile, err := os.CreateTemp("", "jarvis-atspi-*.py")
	if err != nil {
		return nil, fmt.Errorf("could not create temp script: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(atSPIScript); err != nil {
		tmpFile.Close()
		return nil, err
	}
	tmpFile.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "python3", tmpFile.Name(), strconv.Itoa(pid), strconv.Itoa(depth))
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("python3 AT-SPI2 script failed: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &result); err != nil {
		return nil, fmt.Errorf("parse AT-SPI2 output: %w", err)
	}
	return result, nil
}

// cacheElements stores the AT-SPI element list for subsequent click/type calls.
func cacheElements(elems []any, pid int) {
	elementCache.mu.Lock()
	defer elementCache.mu.Unlock()
	elementCache.elements = make([]map[string]any, 0, len(elems))
	for _, e := range elems {
		if m, ok := e.(map[string]any); ok {
			elementCache.elements = append(elementCache.elements, m)
		}
	}
	elementCache.pid = pid
	elementCache.timestamp = time.Now()
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
		if _, err := runWithTimeout(5*time.Second, "xdotool", "mousemove", "--sync",
			strconv.Itoa(x), strconv.Itoa(y), "click", "1"); err != nil {
			return nil, fmt.Errorf("click failed: %w", err)
		}
	case "double_click":
		if _, err := runWithTimeout(5*time.Second, "xdotool", "mousemove", "--sync",
			strconv.Itoa(x), strconv.Itoa(y), "click", "--repeat", "2", "1"); err != nil {
			return nil, fmt.Errorf("double_click failed: %w", err)
		}
	case "right_click":
		if _, err := runWithTimeout(5*time.Second, "xdotool", "mousemove", "--sync",
			strconv.Itoa(x), strconv.Itoa(y), "click", "3"); err != nil {
			return nil, fmt.Errorf("right_click failed: %w", err)
		}
	case "focus":
		if _, err := runWithTimeout(5*time.Second, "xdotool", "mousemove", "--sync",
			strconv.Itoa(x), strconv.Itoa(y), "click", "1"); err != nil {
			return nil, fmt.Errorf("focus failed: %w", err)
		}
	default:
		return nil, fmt.Errorf("action '%s' is not supported on Linux (supported: click, double_click, right_click, focus)", action)
	}

	return &RPCResult{Result: map[string]any{"success": true, "action": action, "x": x, "y": y}}, nil
}

// ── type_text ────────────────────────────────────────────────────────

func handleTypeText(params map[string]any) (*RPCResult, error) {
	text, _ := params["text"].(string)
	if text == "" {
		return nil, fmt.Errorf("missing required parameter: text")
	}

	// If element_id is given, click it first
	if elemID, ok := params["element_id"].(float64); ok {
		if _, err := handleClickElement(map[string]any{"element_id": elemID}); err != nil {
			return nil, fmt.Errorf("failed to click element before typing: %w", err)
		}
		time.Sleep(100 * time.Millisecond)
	}

	if _, err := runWithTimeout(10*time.Second, "xdotool", "type", "--delay", "12", text); err != nil {
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

	combo := convertKeysToXdotool(keys)

	if _, err := runWithTimeout(5*time.Second, "xdotool", "key", combo); err != nil {
		return nil, fmt.Errorf("press_keys failed: %w", err)
	}

	return &RPCResult{Result: map[string]any{"success": true, "keys": keys, "xdotool_combo": combo}}, nil
}

// ── launch_app ───────────────────────────────────────────────────────

func handleLaunchApp(params map[string]any) (*RPCResult, error) {
	executable, _ := params["executable"].(string)
	if executable == "" {
		return nil, fmt.Errorf("missing required parameter: executable")
	}
	argsStr, err := extractArgs(params)
	if err != nil {
		return nil, fmt.Errorf("launch_app: %w", err)
	}

	var cmdArgs []string
	if argsStr != "" {
		// Split args respecting simple quoted strings
		cmdArgs = splitArgs(argsStr)
	}

	cmd := exec.Command(executable, cmdArgs...)
	// Detach from parent process group so it survives beyond this handler
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

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

	// Derive a display name from the executable path
	name := executable
	if idx := strings.LastIndex(executable, "/"); idx >= 0 {
		name = executable[idx+1:]
	}

	return &RPCResult{Result: map[string]any{
		"success": true,
		"pid":     pid,
		"name":    name,
	}}, nil
}

// splitArgs splits a string into arguments, respecting double-quoted groups.
func splitArgs(s string) []string {
	var args []string
	var current strings.Builder
	inQuote := false
	for _, ch := range s {
		switch {
		case ch == '"' && !inQuote:
			inQuote = true
		case ch == '"' && inQuote:
			inQuote = false
		case ch == ' ' && !inQuote:
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(ch)
		}
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	return args
}

// ── focus_window ─────────────────────────────────────────────────────

func handleFocusWindow(params map[string]any) (*RPCResult, error) {
	pidF, ok := params["pid"].(float64)
	if !ok {
		return nil, fmt.Errorf("missing required parameter: pid")
	}
	pid := int(pidF)

	// Try windowactivate by PID via xdotool search
	_, err := runWithTimeout(5*time.Second, "xdotool", "search", "--pid", strconv.Itoa(pid), "windowactivate", "--sync")
	if err != nil {
		return &RPCResult{Result: map[string]any{"success": false, "pid": pid, "error": err.Error()}}, nil
	}

	return &RPCResult{Result: map[string]any{"success": true, "pid": pid}}, nil
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
	// automation_id is ignored on Linux (not an AT-SPI concept)

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

// ── Helpers ──────────────────────────────────────────────────────────

// runWithTimeout runs a command with a timeout and returns trimmed stdout.
// Stderr is discarded; only stdout is returned.
func runWithTimeout(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// toInt converts an interface{} value to int, handling float64, int, and string.
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

// convertKeysToXdotool converts a comma-separated key combo like "ctrl,s" into
// xdotool's "+" notation, e.g. "ctrl+s", "ctrl+shift+s", "alt+F4".
func convertKeysToXdotool(keys string) string {
	parts := strings.Split(strings.TrimSpace(keys), ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}

	var modifiers []string
	var keyParts []string

	for _, part := range parts {
		lower := strings.ToLower(part)
		switch lower {
		case "ctrl", "control":
			modifiers = append(modifiers, "ctrl")
		case "alt":
			modifiers = append(modifiers, "alt")
		case "shift":
			modifiers = append(modifiers, "shift")
		case "super", "win":
			modifiers = append(modifiers, "super")
		default:
			keyParts = append(keyParts, part)
		}
	}

	// Map the non-modifier key(s) to xdotool names
	mapped := make([]string, 0, len(keyParts))
	for _, k := range keyParts {
		mapped = append(mapped, mapKeyToXdotool(k))
	}

	all := append(modifiers, mapped...)
	return strings.Join(all, "+")
}

// mapKeyToXdotool maps human-readable key names to xdotool key names.
func mapKeyToXdotool(key string) string {
	switch strings.ToLower(key) {
	case "enter", "return":
		return "Return"
	case "tab":
		return "Tab"
	case "escape", "esc":
		return "Escape"
	case "backspace", "bs":
		return "BackSpace"
	case "delete", "del":
		return "Delete"
	case "up":
		return "Up"
	case "down":
		return "Down"
	case "left":
		return "Left"
	case "right":
		return "Right"
	case "home":
		return "Home"
	case "end":
		return "End"
	case "pageup", "pgup":
		return "Page_Up"
	case "pagedown", "pgdn":
		return "Page_Down"
	case "space":
		return "space"
	case "f1":
		return "F1"
	case "f2":
		return "F2"
	case "f3":
		return "F3"
	case "f4":
		return "F4"
	case "f5":
		return "F5"
	case "f6":
		return "F6"
	case "f7":
		return "F7"
	case "f8":
		return "F8"
	case "f9":
		return "F9"
	case "f10":
		return "F10"
	case "f11":
		return "F11"
	case "f12":
		return "F12"
	default:
		// Single character — pass through as-is (xdotool handles lowercase letters directly)
		if len(key) == 1 {
			return key
		}
		// Multi-character unknown key — pass through and let xdotool handle it
		return key
	}
}
