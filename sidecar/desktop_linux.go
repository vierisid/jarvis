//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ── Element Cache ──────────────────────────────────────────────────────

// walkDesktopElements is the walk that mints element ids, and the one
// resolveDesktopElement repeats to confirm one (desktop_element_cache.go).
var walkDesktopElements = func(pid, depth int, budget time.Duration) ([]any, error) {
	tree, err := tryATSPI(pid, depth, budget)
	if err != nil {
		return nil, err
	}
	elems, _ := tree["elements"].([]any)
	return elems, nil
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
			"hwnd":          widInt,
			"title":         title,
			"pid":           pid,
			"process_name":  procName,
			"left":          x,
			"top":           y,
			"right":         x + w,
			"bottom":        y + h,
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

// handleGetWindowTree walks the AT-SPI2 tree through python3. It deliberately
// does not read params["semantic"]: durable refs (sig/path/ordinal) are
// implemented only in the Windows UIA walk, so `semantic: true` is a no-op here
// and elements come back without refs rather than with an error. Documented in
// docs/sidecar/SIDECAR_PROTOCOL.md, "Surface Limits"; the shared sig helpers in
// semantic.go are provider-independent if this walk ever grows them.
func handleGetWindowTree(params map[string]any) (*RPCResult, error) {
	// Every path that does not fill the cache retires it instead, so a failed
	// or empty snapshot leaves no earlier ids live (desktop_element_cache.go,
	// forget). Deferred so a return added later cannot skip it.
	filled := false
	defer func() {
		if !filled {
			elementCache.forget()
		}
	}()

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
	tree, atSPIErr := tryATSPI(pid, depth, atSPIWalkTimeout)
	if atSPIErr == nil {
		// Merge in window title and pid
		tree["window_title"] = windowTitle
		tree["pid"] = pid

		// Cache elements, with the depth that produced them: a read-back at a
		// different depth walks a different tree and its indices do not line up.
		if elems, ok := tree["elements"].([]any); ok {
			elementCache.fill(elems, pid, depth)
			filled = true
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

// atSPIWalkTimeout bounds one AT-SPI walk, for a snapshot and for the
// read-back ahead of an element action alike (see the budget note in
// desktop_element_cache.go: 10s + 5s click + 10s keystroke = 25s).
const atSPIWalkTimeout = 10 * time.Second

// desktopPlatformName names this platform in an unsupported-action refusal.
const desktopPlatformName = "Linux"

// desktopPointerTargetChecked: dispatchPointer checks the window under the
// pointer before it clicks (#705).
const desktopPointerTargetChecked = true

// linuxReadBack is the read-back every Linux element action gets: the walk's
// own budget for a click and ahead of a keystroke alike.
var linuxReadBack = readBackPolicy{budget: atSPIWalkTimeout}

// tryATSPI runs the embedded Python3 AT-SPI2 script and parses its output.
func tryATSPI(pid, depth int, timeout time.Duration) (map[string]any, error) {
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

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
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

// ── click_element ────────────────────────────────────────────────────

func handleClickElement(params map[string]any) (*RPCResult, error) {
	return handleClickElementWith(params, linuxReadBack)
}

// dispatchPointer moves the pointer to (x, y) and performs action there, for
// clickElement (desktop_element_action.go), which has already confirmed the
// element and the action -- but only once the window under the pointer is
// shown to belong to pid, the process whose window the element was read from
// (#705).
//
// AT-SPI extents ignore stacking: an element that passed the read-back can be
// covered by another window, or be on another workspace, and a click at its
// centre goes to whatever is on top. So the pointer is moved first and xdotool
// asked, in the same invocation, which window is under it and whose it is:
// `getmouselocation` puts that window on xdotool's window stack and
// `getwindowpid` reads its _NET_WM_PID. Only a match is clicked. A window
// whose owner cannot be read is refused too: there is nothing to match.
//
// The cost is one more xdotool process per click (the locate and the click
// cannot share one, because the decision sits between them): about 2 ms, the
// median of an X client's round trip measured on the machine this was written
// on, against an AT-SPI read-back whose python3 start alone is about 9 ms. The
// locate gets locateBudget and the click the rest of pointerDispatchTimeout,
// so the action budget is unchanged.
//
// The click re-places the pointer itself (`mousemove --sync X Y click`), so a
// pointer moved in the few milliseconds between the two runs -- by the person,
// say -- is put back before the button goes down. A window that appears over
// the point in that gap is not caught; closing that needs the check and the
// click in one X connection under a server grab.
//
// The check is per process, not per window: AT-SPI walks every window of the
// app, so another window of the SAME program covering the element passes it.
//
// _NET_WM_PID is what this sidecar already trusts to find a pid's window
// (focus_window, the window title in get_window_tree, the launch probe), so an
// app that misreports it -- a sandbox whose pid namespace differs, say --
// fails here as it already fails there.
func dispatchPointer(id int, action string, x, y, pid int) error {
	deadline := time.Now().Add(pointerDispatchTimeout)
	X, Y := strconv.Itoa(x), strconv.Itoa(y)
	// Where the pointer was, then the move, then what is under it now.
	located := runProbe(locateBudget, "xdotool", "getmouselocation", "--shell",
		"mousemove", "--sync", X, Y, "getmouselocation", "--shell", "getwindowpid")
	if located.timedOut || (located.exitCode == -1 && located.err != nil) {
		return fmt.Errorf("%s failed: could not move the pointer: %v", action, located.err)
	}
	if window, _, _ := windowUnderPointer(located.stdout); window == "" {
		// xdotool ran and found no window at all: no X display, a Wayland-only
		// session, an X error. Not a covered element, so not a code that tells
		// the model to refocus and retry; and the pointer may have moved.
		return fmt.Errorf("%s failed: xdotool could not report the window under the pointer (%s)",
			action, firstLine(strings.TrimSpace(located.stderr)))
	}
	if why := pointerTargetMismatch(located.stdout, pid); why != "" {
		// Put the pointer back where it was, so a refusal leaves it neither
		// over the covering window (which focus-follows-mouse would hand the
		// focus to) nor hovering anything.
		if ox, oy, ok := pointerOrigin(located.stdout); ok {
			_, _ = runWithTimeout(time.Until(deadline), "xdotool", "mousemove", strconv.Itoa(ox), strconv.Itoa(oy))
		}
		return &codedError{code: desktopTargetObscuredCode, err: fmt.Errorf(
			"element [%d] %s at its centre (%d, %d), so nothing was clicked. "+
				"Bring its window to the front with desktop_focus_window, then take a new desktop_snapshot", id, why, x, y)}
	}
	click := []string{"mousemove", "--sync", X, Y}
	switch action {
	case "double_click":
		click = append(click, "click", "--repeat", "2", "1")
	case "right_click":
		click = append(click, "click", "3")
	default: // click, focus
		click = append(click, "click", "1")
	}
	if _, err := runWithTimeout(time.Until(deadline), "xdotool", click...); err != nil {
		return fmt.Errorf("%s failed: %w", action, err)
	}
	return nil
}

// locateBudget bounds the move-and-locate run, leaving the click at least
// pointerDispatchTimeout - locateBudget (3s) for a process that takes
// milliseconds: a click is never started with a sliver of budget and killed
// half done, a double-click's second click or a button left down.
const locateBudget = 2 * time.Second

// pointerOrigin is the first X=/Y= pair the locate run printed: where the
// pointer was before it moved.
func pointerOrigin(out string) (x, y int, ok bool) {
	gotX, gotY := false, false
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if v, found := strings.CutPrefix(line, "X="); found && !gotX {
			x, gotX = toInt(v), true
		} else if v, found := strings.CutPrefix(line, "Y="); found && !gotY {
			y, gotY = toInt(v), true
		}
	}
	return x, y, gotX && gotY
}

// pointerTargetMismatch reads what the locate run printed and says why the
// window under the pointer is not pid's, or "". The window is the LAST
// WINDOW= line: the first getmouselocation reported where the pointer was.
func pointerTargetMismatch(out string, pid int) string {
	window, owner, ok := windowUnderPointer(out)
	switch {
	case !ok && window == "":
		return "could not be located under the pointer"
	case !ok:
		return fmt.Sprintf("is under a window (%s) whose owning program cannot be read", window)
	case owner != pid:
		return fmt.Sprintf("is covered by a window of another program (pid %d, not %d)", owner, pid)
	}
	return ""
}

// windowUnderPointer parses `xdotool getmouselocation --shell getwindowpid`:
// the shell lines X=, Y=, SCREEN=, WINDOW=, then the pid on a line of its own,
// which is missing when getwindowpid failed. ok is true only with both.
func windowUnderPointer(out string) (window string, pid int, ok bool) {
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if v, found := strings.CutPrefix(line, "WINDOW="); found {
			window = v
			continue
		}
		if strings.Contains(line, "=") || line == "" {
			continue
		}
		if n, err := strconv.Atoi(line); err == nil && n > 0 {
			pid = n
		}
	}
	return window, pid, window != "" && pid > 0
}

// ── type_text ────────────────────────────────────────────────────────

func handleTypeText(params map[string]any) (*RPCResult, error) {
	return handleTypeTextWith(params, linuxReadBack, func(text string) error {
		// "--" ends xdotool's option parsing, so text such as "-h" or
		// "--file=/home/me/.ssh/id_ed25519" is typed literally instead of being
		// read as an option (--file would type out the named file).
		_, err := runWithTimeout(keystrokeTimeout, "xdotool", "type", "--delay", "12", "--", text)
		return err
	})
}

// ── press_keys ───────────────────────────────────────────────────────

func handlePressKeys(params map[string]any) (*RPCResult, error) {
	keys, _ := params["keys"].(string)
	if keys == "" {
		return nil, fmt.Errorf("missing required parameter: keys")
	}

	combo := convertKeysToXdotool(keys)
	if err := checkXdotoolKeySequence(combo); err != nil {
		// Refused before xdotool ran: say so, so the model fixes the key
		// name instead of checking whether something was pressed.
		return nil, &codedError{code: "DESKTOP_INVALID_KEYS",
			err: fmt.Errorf("press_keys refused, nothing was pressed: %w", err)}
	}

	// The trailing "+" is an empty last key, which libxdo skips. It keeps the
	// argument from equalling any xdotool command name, so `xdotool key`
	// cannot chain into a command, whatever commands a later xdotool adds.
	if _, err := runWithTimeout(5*time.Second, "xdotool", "key", "--", combo+"+"); err != nil {
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

	// A spawned process is not an open app: returning immediately made the
	// next tool call race the window ("no window found"). Poll for a visible
	// window owned by this PID before declaring success.
	win, probe, probeErr := waitForWindowLinux(pid, 5*time.Second)
	return launchResultLinux(pid, name, win, probe, probeErr), nil
}

// launchResultLinux turns a window probe into the launch_app result.
//
// The three outcomes stay distinct on purpose. "A window appeared" and "no
// window appeared" are both observations, and success reports them. "The
// window could not be looked for" is not an observation at all, and
// reporting it as success:false would be exactly the kind of confident
// wrong answer this handler exists to stop: on a Wayland session or a box
// without xdotool that would mark every successful GUI launch as a failure,
// and the model would launch the app a second time.
func launchResultLinux(pid int, name string, win map[string]any, probe launchProbe, probeErr error) *RPCResult {
	res := map[string]any{"pid": pid, "name": name}

	switch probe {
	case probeWindowFound:
		res["success"] = true
		res["window_visible"] = true
		res["window_title"] = win["title"]

	case probeProcessGone:
		res["success"] = false
		res["window_visible"] = false
		res["note"] = fmt.Sprintf("process (pid %d) exited without showing a window - it may be a short-lived launcher, a CLI tool, or it crashed. Run desktop_list_windows to see what is actually open.", pid)

	case probeUncheckable:
		// The process is alive and nothing contradicts the launch, so this is
		// not a failure; it is an unverified success, and the note has to say
		// so rather than let the flag speak for it.
		res["success"] = true
		res["window_visible"] = nil
		res["note"] = fmt.Sprintf("process started (pid %d) but whether a window opened could NOT be checked: %v. This is not a failure report - the app may well be on screen. Run desktop_list_windows to see what is actually open before interacting, and do not launch it again on the strength of this result.", pid, probeErr)

	default: // probeWindowAbsent
		res["success"] = false
		res["window_visible"] = false
		res["note"] = fmt.Sprintf("process started (pid %d) but no window appeared within 5s - the app may still be starting, be windowless, or have exited. Run desktop_list_windows to check before interacting; do NOT assume it is open.", pid)
	}

	return &RPCResult{Result: res}
}

// classifyWindowSearch reads one `xdotool search` run.
//
// The exit status alone cannot answer the question: xdotool exits 1 both
// when it matched nothing and when it could not run at all (no DISPLAY, for
// instance). What separates them is that a clean no-match is silent and
// exits exactly 1, while a failure either says something on stderr, exits
// with another status, or never returns. Returning (nil, nil) claims "there
// is no window", so every other shape has to come back as an error.
func classifyWindowSearch(r probeRun) ([]string, error) {
	switch {
	case r.timedOut:
		return nil, fmt.Errorf("%w: xdotool search did not return in time", errWindowCheckUnavailable)
	case strings.TrimSpace(r.stderr) != "":
		return nil, fmt.Errorf("%w: xdotool search failed: %s", errWindowCheckUnavailable, firstLine(strings.TrimSpace(r.stderr)))
	case r.exitCode == 1:
		return nil, nil // ran cleanly and matched nothing
	case r.err != nil:
		return nil, fmt.Errorf("%w: could not run xdotool (exit %d): %v", errWindowCheckUnavailable, r.exitCode, r.err)
	}
	return strings.Fields(r.stdout), nil
}

// probeWindowOnce asks xdotool for a visible window owned by pid. A nil
// window with a nil error means "looked, found none"; a non-nil error means
// the question could not be put at all.
func probeWindowOnce(pid int) (map[string]any, error) {
	if _, err := exec.LookPath("xdotool"); err != nil {
		return nil, fmt.Errorf("%w: xdotool is not installed", errWindowCheckUnavailable)
	}

	ids, err := classifyWindowSearch(runProbe(2*time.Second, "xdotool", "search", "--onlyvisible", "--pid", strconv.Itoa(pid)))
	if err != nil || len(ids) == 0 {
		return nil, err
	}

	title := ""
	if t := runProbe(2*time.Second, "xdotool", "getwindowname", ids[0]); t.err == nil {
		title = t.stdout
	}
	return map[string]any{"title": title}, nil
}

// waitForWindowLinux polls for a visible window owned by pid. It stops early
// when the process disappears (no point waiting out the timeout for a window
// that can no longer appear) and when the check itself is unusable.
func waitForWindowLinux(pid int, timeout time.Duration) (map[string]any, launchProbe, error) {
	deadline := time.Now().Add(timeout)
	for {
		win, err := probeWindowOnce(pid)
		if win != nil {
			return win, probeWindowFound, nil
		}
		// A dead process settles the question whether or not xdotool worked.
		if syscall.Kill(pid, 0) != nil {
			return nil, probeProcessGone, err
		}
		if errors.Is(err, errWindowCheckUnavailable) {
			return nil, probeUncheckable, err
		}
		if time.Now().After(deadline) {
			return nil, probeWindowAbsent, nil
		}
		time.Sleep(150 * time.Millisecond)
	}
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
	// Walk (which fills the cache and mints this walk's ids), then filter THAT
	// walk's reply -- see findInWalk.
	res, err := handleGetWindowTree(params)
	if err != nil {
		return nil, fmt.Errorf("find_element failed: %w", err)
	}

	name, _ := params["name"].(string)
	controlType, _ := params["control_type"].(string)
	className, _ := params["class_name"].(string)
	// automation_id is ignored on Linux (not an AT-SPI concept)

	matches := findInWalk(res.Result, name, controlType, className)
	return &RPCResult{Result: map[string]any{
		"match_count": len(matches),
		"elements":    matches,
	}}, nil
}

// ── Helpers ──────────────────────────────────────────────────────────

// probeRun is everything needed to tell a tool that ran and found nothing
// apart from one that could not run. runWithTimeout throws all of it away
// except stdout, which is why the window check cannot use it.
type probeRun struct {
	stdout   string
	stderr   string
	exitCode int // 0 on success, the tool's status on exit, -1 if it never ran
	timedOut bool
	err      error
}

// runProbe runs a command with a timeout and keeps the full outcome.
func runProbe(timeout time.Duration, name string, args ...string) probeRun {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()

	r := probeRun{
		stdout:   strings.TrimSpace(string(out)),
		stderr:   stderr.String(),
		timedOut: errors.Is(ctx.Err(), context.DeadlineExceeded),
		err:      err,
	}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		r.exitCode = 0
	case errors.As(err, &exitErr):
		r.exitCode = exitErr.ExitCode()
	default:
		r.exitCode = -1
	}
	return r
}

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

// xdotoolKeyName matches the key names xdotool can press: X keysym names
// (Return, minus, F5, XF86AudioPlay, U20AC) and xdotool's aliases (ctrl,
// super, enter). xdotool ignores or rejects anything else, so refusing it
// loses no working key, and it keeps a leading "-" from ever reaching xdotool.
//
// This, the command checks and maxChordKeys are mirrored by the daemon's
// toXdotoolKeySequence (src/actions/app-control/linux.ts); keep them in sync.
var xdotoolKeyName = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

// xdotoolCommands is xdotool's command table. `xdotool key` stops at the
// first argument that names one and runs it as a chained command, "--" or
// not, so a lone key spelled like a command ("exec", "selectwindow") would run
// that command instead of being pressed. handlePressKeys also ends the
// argument with "+" (see there), which no command name contains; refusing
// these as well keeps a later edit to that argument from reopening the hole.
var xdotoolCommands = map[string]bool{
	"behave": true, "behave_screen_edge": true, "click": true, "exec": true, "get_desktop": true,
	"get_desktop_for_window": true, "get_desktop_viewport": true, "get_num_desktops": true,
	"getactivewindow": true, "getdisplaygeometry": true, "getmouselocation": true, "getwindowclassname": true,
	"getwindowfocus": true, "getwindowgeometry": true, "getwindowname": true, "getwindowpid": true, "help": true,
	"key": true, "keydown": true, "keyup": true, "mousedown": true, "mousemove": true, "mousemove_relative": true, "mouseup": true,
	"search": true, "selectwindow": true, "set_desktop": true, "set_desktop_for_window": true,
	"set_desktop_viewport": true, "set_num_desktops": true, "set_window": true, "sleep": true, "type": true, "version": true,
	"windowactivate": true, "windowclose": true, "windowfocus": true, "windowkill": true, "windowlower": true,
	"windowmap": true, "windowminimize": true, "windowmove": true, "windowquit": true, "windowraise": true,
	"windowreparent": true, "windowsize": true, "windowstate": true, "windowunmap": true,
}

// maxChordKeys bounds a combo: libxdo grows its key array with the wrong
// element size once a sequence reaches 10 keys (xdo.c
// `realloc(*keys, keys_size * sizeof(KeyCode))`) and then writes past it. No
// real chord comes close, so stay well below.
const maxChordKeys = 8

// keysymsNamedLikeCommands holds the real keysyms that share a name with a
// command. Help (the "help" command) is the only one. The trailing "+" in
// handlePressKeys is what lets it be pressed; were that ever lost, xdotool
// would merely print its help text.
var keysymsNamedLikeCommands = map[string]bool{"Help": true}

// checkXdotoolKeySequence refuses a "+"-joined combo that xdotool would read
// as anything other than keys to press. Empty items are skipped, as xdotool
// itself skips them. The checks run in the same order as the daemon's: names,
// then empty, then count, then command names.
func checkXdotoolKeySequence(combo string) error {
	named := 0
	for _, k := range strings.Split(combo, "+") {
		if k == "" {
			continue
		}
		if !xdotoolKeyName.MatchString(k) {
			return fmt.Errorf("invalid key name %q: use names such as enter, tab or f5, or X keysym names such as minus and slash", k)
		}
		named++
	}
	if named == 0 {
		return fmt.Errorf("no keys given")
	}
	if named > maxChordKeys {
		return fmt.Errorf("too many keys in one combo (%d); press at most %d at once", named, maxChordKeys)
	}
	if xdotoolCommands[strings.ToLower(combo)] && !keysymsNamedLikeCommands[combo] {
		hint := ""
		if strings.ToLower(combo) == "help" {
			hint = ` (the Help key is spelled "Help")`
		}
		return fmt.Errorf("%q is an xdotool command name and cannot be pressed as a key%s", combo, hint)
	}
	return nil
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
