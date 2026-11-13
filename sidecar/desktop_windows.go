//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
	// How a line break in the text is typed (desktop_reach.go).
	softBreak, err := typeLineBreakIsSoft(params)
	if err != nil {
		return nil, fmt.Errorf("type_text refused, nothing was typed: %w", err)
	}

	// If element_id is given, click it first to focus
	clicked := ""
	if elemID, ok := params["element_id"].(float64); ok {
		_, err := comThread.call(func(state *uiaState) (any, error) {
			return uiaPerformAction(state, int(elemID), "click", "")
		})
		if err != nil {
			return nil, fmt.Errorf("failed to click element before typing: %w", err)
		}
		clicked = fmt.Sprintf("element [%d] was clicked", int(elemID))
		time.Sleep(100 * time.Millisecond)
	}

	// The text goes to whatever window is in front. Into one that runs as
	// administrator it vanished, and the reply still said success: Windows
	// drops those keys without an error (desktop_reach.go).
	front := win32GetForegroundWindow()
	reach := windowKeyReach(front)
	if reach == keysBlocked {
		return nil, fmt.Errorf("type_text refused: %w", keysBlockedError("typed", clicked))
	}

	// Native SendInput — replaces a per-call PowerShell spawn running
	// SendKeys, which was slow (~250-500ms overhead), lossy on long/fast
	// text, and required metacharacter escaping.
	if err := typeTextNative(text, softBreak); err != nil {
		return nil, fmt.Errorf("type_text failed: %w", err)
	}
	// Which window that was, as a number and a fixed word: nothing read from
	// the screen goes into this reply.
	return &RPCResult{Result: map[string]any{
		"success": true, "chars": len([]rune(text)),
		"foreground_pid": win32GetWindowPid(front), "delivery": reach.delivery(),
	}}, nil
}

// ── press_keys ───────────────────────────────────────────────────────

func handlePressKeys(params map[string]any) (*RPCResult, error) {
	keys, _ := params["keys"].(string)
	if keys == "" {
		return nil, fmt.Errorf("missing required parameter: keys")
	}

	front := win32GetForegroundWindow()
	reach := windowKeyReach(front)
	if reach == keysBlocked {
		return nil, fmt.Errorf("press_keys refused: %w", keysBlockedError("pressed", ""))
	}

	// Native SendInput chords — replaces per-call PowerShell SendKeys. This
	// also makes the `win` modifier a real Windows-key chord (SendKeys had
	// no Windows key; the old code sent an approximate ctrl+esc).
	if err := pressKeysNative(keys); err != nil {
		return nil, fmt.Errorf("press_keys failed: %w", err)
	}
	return &RPCResult{Result: map[string]any{
		"success": true, "keys": keys,
		"foreground_pid": win32GetWindowPid(front), "delivery": reach.delivery(),
	}}, nil
}

// ── launch_app ───────────────────────────────────────────────────────

func handleLaunchApp(params map[string]any) (*RPCResult, error) {
	executable, _ := params["executable"].(string)
	if executable == "" {
		return nil, fmt.Errorf("missing required parameter: executable")
	}
	// One path with spaces in it stays one argument (desktop_launch_args.go).
	args, err := launchArgLine(params)
	if err != nil {
		return nil, fmt.Errorf("launch_app: %w", err)
	}

	// psSingleQuoted doubles ASCII and typographic single quotes alike.
	escaped := psSingleQuoted(executable)
	argsClause := ""
	if args != "" {
		argsClause = "-ArgumentList " + psSingleQuoted(args)
	}

	// 'Stop', or a name that cannot be found does not fail the script: the
	// next line still runs, PowerShell exits 0 with a null pid, and "not
	// found" was reported as "started, but no window" (and the Start menu was
	// never asked). Seen on the first machine this ran on.
	script := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath %s %s -PassThru
@{ pid=$p.Id; name=$p.ProcessName } | ConvertTo-Json -Compress
`, escaped, argsClause)

	// Snapshot what is on screen before starting anything, so the
	// process-name fallback below cannot hand back a window that belongs to
	// an instance the user already had open.
	preexisting := visibleWindowHandles()

	out, err := runPS(script, 10*time.Second)
	if err != nil {
		// Not startable by that name. An app a person installed usually is
		// not: it is in the Start menu (desktop_startmenu.go).
		started, ok, why := launchFromStartMenu(executable, args, preexisting)
		if ok {
			return started, nil
		}
		if why != "" {
			return nil, fmt.Errorf("launch_app failed: %s", why)
		}
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
	if pid == 0 {
		// Started, with no process handed back: Windows gave it to a program
		// that was already running. That is how a web address, a folder, a
		// document, and an app that keeps a single window all open. It was
		// reported as "process started (pid 0) but no window appeared", a
		// failure, for something that had just opened.
		return launchHandedOff(executable, result, preexisting), nil
	}
	win, matchedBy := waitForWindow(pid, executable, 8*time.Second, preexisting)
	if win == nil {
		if !processAlive(pid) {
			// It started and is gone again without a window: a command-line
			// tool that shares an app's name (docker is the command; Docker
			// Desktop is the app). The Start menu knows the app.
			if started, ok, _ := launchFromStartMenu(executable, args, preexisting); ok {
				return started, nil
			}
			result["success"] = false
			result["window_visible"] = false
			result["note"] = fmt.Sprintf(
				"%q started (pid %d) and ended at once without a window - it is probably a command-line program, not an app. Run desktop_list_windows to check; do NOT assume anything opened.",
				executable, pid)
			return &RPCResult{Result: result}, nil
		}
		// Still running, no window yet: a slow start, not a failure.
		result["success"] = true
		result["window_visible"] = nil
		result["note"] = fmt.Sprintf(
			"%q is running (pid %d) but has shown no window in 8s - it is probably still starting. Run desktop_list_windows in a moment; do NOT launch it again.",
			executable, pid)
		return &RPCResult{Result: result}, nil
	}

	result["success"] = true
	result["window_visible"] = true
	result["window_title"] = win.Title
	result["window_pid"] = win.Pid // may differ from launch pid for packaged apps
	if matchedBy == "process_name" {
		result["note"] = fmt.Sprintf("window belongs to pid %d (matched by process name; the launcher pid %d handed off) - use pid %d with desktop_snapshot/desktop_focus_window", win.Pid, pid, win.Pid)
	}
	return &RPCResult{Result: result}, nil
}

// processAlive says whether a process is still running.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	out, err := runPS(fmt.Sprintf("if (Get-Process -Id %d -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }", pid), 5*time.Second)
	// Not knowing is "alive": the kinder reply, and nothing is started twice.
	return err != nil || strings.TrimSpace(out) != "no"
}

// launchHandedOff answers for a launch that Windows handed to a program that
// was already running. If a window of that name is on screen it is named;
// otherwise the reply is "opened, window not followed", which is not a failure.
func launchHandedOff(executable string, result map[string]any, preexisting map[uintptr]bool) *RPCResult {
	name := startMenuFold(executable)
	if i := strings.LastIndexAny(name, `\/`); i >= 0 {
		name = name[i+1:]
	}
	result["pid"] = 0
	result["success"] = true
	deadline := time.Now().Add(3 * time.Second)
	for {
		wins := enumTopWindows()
		seen := make([]startMenuWin, len(wins))
		for i, w := range wins {
			seen[i] = startMenuWin{Hwnd: w.Hwnd, Title: w.Title, ProcessName: w.ProcessName}
		}
		opened, _, already := pickStartMenuWindow(seen, name, name, preexisting)
		if opened < 0 && time.Now().After(deadline) {
			opened = already
		}
		if opened >= 0 {
			w := wins[opened]
			result["window_visible"] = true
			result["window_title"] = w.Title
			result["window_pid"] = w.Pid
			result["note"] = fmt.Sprintf("opened in a program that was already running: its window is %q - use pid %d with desktop_snapshot/desktop_focus_window", w.Title, w.Pid)
			return &RPCResult{Result: result}
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	result["window_visible"] = nil
	result["note"] = "opened, and handed to a program that was already running (a browser for a web address, File Explorer for a folder, or the app itself if it was open). Its window was not followed: run desktop_list_windows to see it; do NOT open it again."
	return &RPCResult{Result: result}
}

// launchFromStartMenu starts the one app the Start menu lists under the name
// that could not be started directly. `ok` is false when this was not a plain
// app by its name, when no app or more than one answers to it, or when
// starting it failed; `why` then says which, in words the agent can act on.
func launchFromStartMenu(executable, args string, preexisting map[uintptr]bool) (result *RPCResult, ok bool, why string) {
	want, plain := startMenuWanted(executable, args)
	if !plain {
		return nil, false, ""
	}
	out, err := runPS(startMenuListScript(), 15*time.Second)
	if err != nil {
		log.Printf("[desktop] launch_app: the Start menu could not be read: %v", err)
		return nil, false, ""
	}
	apps, err := startMenuApps(out)
	if err != nil {
		log.Printf("[desktop] launch_app: the Start menu's answer could not be read: %v", err)
		return nil, false, ""
	}
	found, names, count := startMenuPick(want, apps)
	if found == nil {
		log.Printf("[desktop] launch_app: %q is not one app in the Start menu (%d found)", want, count)
		if count == 0 {
			return nil, false, fmt.Sprintf("no program called %q could be started, and no app in the Start menu has that name. It may not be installed, or it has another name.", want)
		}
		return nil, false, fmt.Sprintf("%d apps in the Start menu answer to %q (%s). Launch one by its exact name.", count, want, strings.Join(names, "; "))
	}
	if _, err := runPS(startMenuLaunchScript(found.ID), 10*time.Second); err != nil {
		log.Printf("[desktop] launch_app: %q could not be started from the Start menu: %v", found.Name, err)
		return nil, false, fmt.Sprintf("%q is in the Start menu but could not be started from it.", found.Name)
	}
	log.Printf("[desktop] launch_app: %q was not startable by name; started %q from the Start menu", executable, found.Name)
	reply := map[string]any{"pid": 0, "name": found.Name, "via": "start_menu"}
	hint := startMenuWindowHint(found.ID, executable)

	// The Start menu hands back no process to follow, so the window is found
	// by what it is: a new window of that program, or one that carries the
	// app's name. One that was already open counts too, once nothing new came.
	deadline := time.Now().Add(10 * time.Second)
	var already *windowInfo
	for {
		wins := enumTopWindows()
		seen := make([]startMenuWin, len(wins))
		for i, w := range wins {
			seen[i] = startMenuWin{Hwnd: w.Hwnd, Title: w.Title, ProcessName: w.ProcessName}
		}
		opened, how, was := pickStartMenuWindow(seen, found.Name, hint, preexisting)
		if opened >= 0 {
			w := wins[opened]
			reply["success"] = true
			reply["window_visible"] = true
			reply["window_title"] = w.Title
			reply["window_pid"] = w.Pid
			reply["note"] = fmt.Sprintf("started %q from the Start menu (window matched by %s) - use pid %d with desktop_snapshot/desktop_focus_window", found.Name, how, w.Pid)
			return &RPCResult{Result: reply}, true, ""
		}
		if was >= 0 {
			w := wins[was]
			already = &w
		}
		// Already open: starting it again brings its own window forward, so
		// there is no reason to wait the whole time for a new one.
		if already != nil && time.Until(deadline) < 7*time.Second {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	reply["success"] = true
	if already != nil {
		reply["window_visible"] = true
		reply["window_title"] = already.Title
		reply["window_pid"] = already.Pid
		reply["note"] = fmt.Sprintf("%q was already open: its window is %q - use pid %d with desktop_snapshot/desktop_focus_window", found.Name, already.Title, already.Pid)
		return &RPCResult{Result: reply}, true, ""
	}
	// Started, by the Start menu's own word, but no window could be told to be
	// its: said as that, which is not a failure.
	reply["window_visible"] = nil
	reply["note"] = fmt.Sprintf("%q was started from the Start menu, but its window could not be told apart within 10s - it may still be starting. Run desktop_list_windows to see it; do NOT launch it again.", found.Name)
	return &RPCResult{Result: reply}, true, ""
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
	// One program can own several windows. `hwnd` (from list_windows) names
	// one of them; without it the one a person means is taken.
	hwnd := uintptr(0)
	if h, ok := params["hwnd"].(float64); ok && h > 0 {
		hwnd = uintptr(h)
	}
	win, err := focusWindowNative(pid, hwnd)
	if err != nil {
		return nil, fmt.Errorf("focus_window failed: %w", err)
	}
	return &RPCResult{Result: map[string]any{
		"success": true,
		"pid":     pid,
		"hwnd":    win.Hwnd,
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
