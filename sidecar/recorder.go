package main

// recorder.go: cross-platform skill-recorder plumbing.
//
// The platform-specific input hook + acted-element capture lives in
// recorder_windows.go (real) and recorder_other.go (stub); each assigns the
// inputHookStart / inputHookStop variables in its init so this file, and its
// tests, never need to know the platform. This file holds the shared event
// sender, the recorder_start / recorder_stop RPC handlers, the session cap,
// and the visible indicator.
//
// Invariants:
//   - A recording is bounded. recorder_start arms a timer at the requested
//     max_ms (clamped to [recorderMinCap, recorderMaxCap]); when it fires the
//     hooks come out whether or not the brain ever sends recorder_stop. A
//     brain crash cannot leave WH_MOUSE_LL / WH_KEYBOARD_LL installed for the
//     process lifetime.
//   - A recording is visible. While the hooks are installed the pebble shows
//     the working state with a "Recording a skill" line, and a native
//     notification announces the start and the end.
//   - start and stop are serialized under recorderOpMu, so a stop that races
//     a start cannot leave hooks installed with recorderActive false.
//   - The brain hears about every end (ui_recording {state: stopped, reason})
//     so its own session closes with the hooks.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

const (
	recorderDefaultCap = 10 * time.Minute
	recorderMaxCap     = 30 * time.Minute
)

// recorderMinCap is a var only so tests can fire the cap quickly; production
// never changes it.
var recorderMinCap = 10 * time.Second

func recorderMinCapOverride(d time.Duration) { recorderMinCap = d }

var (
	// recorderMu guards the sender fields, read by emitInteraction from the
	// capture goroutine while connectAndServe may be re-assigning them.
	recorderMu   sync.Mutex
	recorderCtx  context.Context
	recorderSend EventSender

	// recorderOpMu serializes start / stop / cap expiry as whole operations.
	recorderOpMu   sync.Mutex
	recorderActive bool
	recorderTimer  *time.Timer

	// Platform hook control, assigned by recorder_windows.go / recorder_other.go.
	inputHookStart func() error
	inputHookStop  func()

	// recorderPebble is the overlay used as the indicator; nil when the
	// pebble capability is off, in which case only the notification shows.
	recorderPebble PebbleService
)

// setRecorderSender wires the observer event channel to the recorder. Called
// once observers start (client.go).
func setRecorderSender(ctx context.Context, send EventSender) {
	recorderMu.Lock()
	recorderCtx = ctx
	recorderSend = send
	recorderMu.Unlock()
}

// setRecorderIndicator hands the recorder the pebble it should light while a
// recording is live. Safe with a nil service.
func setRecorderIndicator(p PebbleService) {
	recorderOpMu.Lock()
	recorderPebble = p
	recorderOpMu.Unlock()
}

// errOwnWindow marks an interaction that belongs to one of Jarvis's own
// windows. It is not a capture failure -- the element was read fine and is
// deliberately not recorded -- so the capture paths log it as an ignore
// rather than a fault, and never as an empty result the caller has to guess
// the meaning of.
var errOwnWindow = errors.New("element belongs to one of Jarvis's own windows")

// ownWindowVerdict decides whether an interaction must be dropped because it
// belongs to one of Jarvis's own windows.
//
//   - elemPid is the process owning the element itself.
//   - hostPid is the process owning the top-level window hosting it, and
//     hostKnown says whether that window could be established at all.
//   - ownPid is the sidecar's own process.
//
// elemPid alone never identifies a panel: the chat panel is a WebView2
// control whose elements belong to msedgewebview2.exe while the window
// belongs to the sidecar. And this FAILS CLOSED -- an element whose hosting
// window is unknown is treated as ours -- because an unknown host cannot be
// shown NOT to be a panel, and silently recording what the person typed into
// Jarvis is the worse of the two outcomes. Dropping a step the person can
// re-record is the cheaper one.
func ownWindowVerdict(elemPid, hostPid, ownPid uint32, hostKnown bool) bool {
	if elemPid == ownPid || hostPid == ownPid {
		return true
	}
	return !hostKnown
}

// ownWindowReason explains an ownWindowVerdict of true, so the two causes are
// distinguishable in sidecar.log. They are not the same thing to a person
// asking why the recorder ignored what they just did: one is working as
// intended, the other is a UIA read this machine would not answer.
func ownWindowReason(elemPid, hostPid, ownPid uint32, hostKnown bool) string {
	if elemPid == ownPid || hostPid == ownPid {
		return "one of Jarvis's own windows"
	}
	if !hostKnown {
		return "an element whose hosting window could not be read, dropped rather than risk recording a Jarvis panel"
	}
	return "not one of Jarvis's own windows"
}

// errClickUnattributable marks a click the recorder deliberately did not
// record because it could not say, without guessing, which control received
// it. Like errOwnWindow it is not a capture fault; unlike it, it is a step
// the person probably expected to see, so the capture path logs it loudly.
var errClickUnattributable = errors.New("the click could not be attributed to the window that received it")

// clickTarget is what a click should be attributed to.
type clickTarget int

const (
	// clickTargetDrop: record nothing. Either the window that received the
	// click is gone, or we never established which window that was. It is
	// the zero value on purpose: a clickTarget nobody assigned must fail
	// closed, not record whatever a late hit test happened to return.
	clickTargetDrop clickTarget = iota
	// clickTargetHit: record the element the hit test returned. It is hosted
	// by the window that received the click, so it is what was clicked.
	clickTargetHit
	// clickTargetHostWindow: something else is drawn over the window that
	// received the click (the overlay case, #493). Re-point into the
	// click-time hosting window.
	clickTargetHostWindow
	// clickTargetOwnWindow: the click went to one of Jarvis's own windows.
	// Also a drop, but an expected one rather than a lost step.
	clickTargetOwnWindow
)

func (t clickTarget) String() string {
	switch t {
	case clickTargetHit:
		return "hit"
	case clickTargetHostWindow:
		return "host-window"
	case clickTargetDrop:
		return "drop"
	case clickTargetOwnWindow:
		return "own-window"
	}
	return "unknown"
}

// clickFacts is everything the attribution decision is allowed to look at.
//
// The first group is sampled inside the mouse hook, when the button went
// down; the second is read much later, on the COM thread, after the settle
// sleep and the event queue. Keeping the two apart in one struct is the
// point: a click is attributed to the world as it was when the person
// clicked, and what the world looks like now can only be evidence that the
// recorded world is gone -- never a replacement for it.
//
// Windows are compared by HWND, not by pid. Cross-process hosting is
// ordinary on Windows -- a UWP app's top-level window belongs to
// ApplicationFrameHost.exe while its content belongs to the app, and any
// WebView2 app (Teams, Spotify, Jarvis's own panels) puts msedgewebview2.exe
// content inside its own window -- so "different process" does not mean
// "different window", and only the second one is an overlay.
type clickFacts struct {
	// --- recorded in the hook, at the moment of the click ---

	// HostHwnd is the top-level window that was under the pointer when the
	// button went down (WindowFromPoint resolved through GA_ROOT): the
	// window that received the click. HostPid owned it then.
	HostHwnd uintptr
	HostPid  uint32

	// FgHwnd / FgPid are the foreground window as it was at click time.
	// They decide nothing; they say whether the click went to the
	// foreground window or to a background one (a taskbar button, another
	// app's window), which is what makes a log line legible.
	FgHwnd uintptr
	FgPid  uint32

	// --- read at resolution time, 60ms+ later, on the COM thread ---

	// HostStillExists is IsWindow(HostHwnd) now, and HostPidNow is who owns
	// that handle now. Windows recycles HWNDs, so "the window is still
	// there" has to mean "and it is still the same window": a handle whose
	// owner changed is a different window wearing the dead one's number.
	HostStillExists bool
	HostPidNow      uint32

	// HitPid owns the element the hit test returned (0 when UIA would not
	// say), and HitHostHwnd is the top-level window hosting that element
	// (0 when it could not be established). HitHostHwnd is what decides
	// whether the hit element is part of the window that got the click.
	HitPid      uint32
	HitHostHwnd uintptr

	// CaptureHwnd is the top-level window that held the mouse capture when
	// the button went down, if any. A window with capture receives the
	// click wherever the pointer is -- an open menu captures the mouse so
	// that a click anywhere dismisses it -- so when it is not the window
	// under the pointer, the window under the pointer received nothing and
	// must not be recorded. MenuUp says a menu was open, which is the usual
	// reason for that and worth naming in the log.
	CaptureHwnd uintptr
	MenuUp      bool

	// CurrentFgPid is the foreground process at resolution time. It exists
	// to be reported, never to be acted on -- reacting to it is the bug
	// (#499): between the click and here the person may simply have
	// switched apps, and re-pointing the click at whatever is in front now
	// invents a step they never performed.
	CurrentFgPid uint32

	// OwnPid is the sidecar's own process.
	OwnPid uint32
}

// clickAttribution decides what a click is attributed to, from what was
// recorded when it happened and what can still be seen now. It returns the
// target and a reason fit for sidecar.log, so a step that never appears can
// be explained from the log alone.
//
// The rules, in order:
//
//  1. No hosting window was recorded: we cannot say which window was
//     clicked, so we do not say. (Fail closed.)
//  2. The window that received the click is one of Jarvis's own. Not a step,
//     and not a fault either. This is where #493's panel rule now lives: the
//     chat panel takes its clicks, so WindowFromPoint names it, and it is
//     ours whatever process the WebView2 content inside it belongs to.
//  3. That window is gone, or its handle now belongs to someone else. Its
//     controls went with it; re-pointing the click at whatever replaced it
//     is exactly the fabrication this fails closed to avoid.
//  4. The hit element is hosted by that same window: it is what was clicked.
//     This covers hosted content of every kind, because the comparison is on
//     the window, not on the process.
//  5. Otherwise the hit element belongs to a different top-level window, so
//     something is drawn over the window that received the click (a GPU
//     overlay, a screen recorder, a remote-control layer, or one of Jarvis's
//     own click-through surfaces). Attribute to the recorded hosting window
//     -- which is #493's fix, sharpened: it re-pointed at the foreground
//     window, and the window that took the click is the same thing whenever
//     an overlay is involved but is right in the cases where they differ.
//
// What is deliberately absent is any rule on CurrentFgPid. The foreground
// window at resolution time is not evidence about a click that happened 60ms
// or more ago: a demonstration switches apps constantly, and reading a switch
// as "an overlay is covering the foreground window" is what produced a
// confident step against a control the person never touched.
//
// Two residual limits, both narrower than what they replace:
//
//   - An overlay that genuinely takes the click (an interactive game or chat
//     overlay) IS the window that received it, so it is recorded as itself.
//     That is accurate, if not useful.
//   - Movement within one window across the settle is invisible here: if the
//     clicked window re-lays-out its own contents in those 60ms, the hit test
//     can land on a different control of the same window and rule 4 keeps it.
//     Cross-window drift, which is what #499 is about, is what this fixes.
func clickAttribution(f clickFacts) (clickTarget, string) {
	switch {
	case f.HostHwnd == 0 || f.HostPid == 0:
		return clickTargetDrop, "no window was recorded under the pointer when the click happened, so the window that received it is unknown"

	case f.OwnPid != 0 && f.HostPid == f.OwnPid:
		return clickTargetOwnWindow, fmt.Sprintf(
			"the click went to one of Jarvis's own windows (hwnd %#x)", f.HostHwnd)

	case f.CaptureHwnd != 0 && f.CaptureHwnd != f.HostHwnd:
		return clickTargetDrop, fmt.Sprintf(
			"window %#x held the mouse capture%s, so it received this click rather than the window under the pointer (hwnd %#x, pid %d)",
			f.CaptureHwnd, menuNote(f), f.HostHwnd, f.HostPid)

	case !f.HostStillExists:
		return clickTargetDrop, fmt.Sprintf(
			"the window that received the click (hwnd %#x, pid %d) no longer exists%s",
			f.HostHwnd, f.HostPid, foregroundNote(f))

	case f.HostPidNow != f.HostPid:
		return clickTargetDrop, fmt.Sprintf(
			"the window that received the click (hwnd %#x) belonged to pid %d and now belongs to pid %d: the handle has been reused%s",
			f.HostHwnd, f.HostPid, f.HostPidNow, foregroundNote(f))

	case f.HitHostHwnd != 0 && f.HitHostHwnd == f.HostHwnd:
		return clickTargetHit, fmt.Sprintf(
			"the element under the pointer is hosted by the window that received the click (hwnd %#x, pid %d)%s",
			f.HostHwnd, f.HostPid, foregroundNote(f))

	case f.OwnPid != 0 && f.HitPid == f.OwnPid:
		// One of our own click-through surfaces (the pebble indicator, a
		// click-through panel) is drawn over someone else's window. The
		// click went through it -- that is what WindowFromPoint naming the
		// other window means -- so the step belongs to that window. #493
		// had to drop this click; the click-time window makes it keepable.
		return clickTargetHostWindow, fmt.Sprintf(
			"a Jarvis surface is drawn over the window that received the click (hwnd %#x, pid %d%s); the click went through it, attributing to that window%s",
			f.HostHwnd, f.HostPid, hwndRole(f), foregroundNote(f))

	default:
		return clickTargetHostWindow, fmt.Sprintf(
			"%s is drawn over the window that received the click (hwnd %#x, pid %d%s); attributing to that window%s",
			hitDescription(f), f.HostHwnd, f.HostPid, hwndRole(f), foregroundNote(f))
	}
}

// hitDescription names whatever the late hit test found on top, for the log.
func hitDescription(f clickFacts) string {
	if f.HitPid == 0 && f.HitHostHwnd == 0 {
		return "an element belonging to no window this machine would name"
	}
	if f.HitHostHwnd == 0 {
		return fmt.Sprintf("pid %d, in no window this machine would name,", f.HitPid)
	}
	return fmt.Sprintf("window %#x (pid %d)", f.HitHostHwnd, f.HitPid)
}

// menuNote names the usual reason another window holds the mouse: a menu is
// open, and the click is dismissing it rather than pressing anything.
func menuNote(f clickFacts) string {
	if f.MenuUp {
		return " with a menu open"
	}
	return ""
}

// hwndRole says whether the clicked window was the foreground one when it was
// clicked. An overlay over the foreground window and a click on a background
// window (a taskbar button) look the same to the rules above and want telling
// apart in a log.
func hwndRole(f clickFacts) string {
	switch {
	case f.FgHwnd == 0:
		return ", with no foreground window at the time"
	case f.FgHwnd == f.HostHwnd:
		return ", the foreground window at the time"
	default:
		return ", not the foreground window at the time"
	}
}

// foregroundNote reports a foreground change across the settle. It never
// changes a verdict; it is here because "the app switched under me" is the
// first thing worth knowing when a recorded step looks wrong.
func foregroundNote(f clickFacts) string {
	if f.FgPid == 0 || f.CurrentFgPid == 0 || f.FgPid == f.CurrentFgPid {
		return ""
	}
	return fmt.Sprintf(" (foreground moved from pid %d to pid %d since the click; attribution ignores that)", f.FgPid, f.CurrentFgPid)
}

// The three helpers below serve the Windows click path and live here, in the
// file with no build tag, for one reason: this is where they can be tested.
// Every other line of that path needs UIA, a hook callback or a real desktop;
// these are arithmetic, and arithmetic that is wrong by four pixels or by a
// sign bit is exactly the kind of defect a Windows-only file hides for
// months.

// clickSlopPx is how far the pointer may travel between press and release
// for the release to still count as a click on what was pressed. It matches
// Windows' own drag threshold (the SM_CXDRAG / SM_CYDRAG default).
const clickSlopPx = 4

// pressSiteStillApplies reports whether the window sampled when the button
// went down still describes where the button came up. It does not when no
// press was seen (the recording was armed mid-click) or when the pointer
// travelled: a drag from one window to another releases somewhere the press
// says nothing about, and attributing it to the pressed window would be the
// same invention this whole path exists to prevent.
func pressSiteStillApplies(pressedX, pressedY int, sampled bool, releaseX, releaseY int) bool {
	if !sampled {
		return false
	}
	return absInt(releaseX-pressedX) <= clickSlopPx && absInt(releaseY-pressedY) <= clickSlopPx
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// packPoint packs a screen point into the single register a Win32 POINT is
// passed in by value on amd64 and arm64: x in the low dword, y in the high
// one, both as signed 32-bit values.
//
// The sign matters and is the reason this is tested: a monitor placed to the
// left of or above the primary one has negative screen coordinates, and a
// naive conversion sign-extends x into y's half, which would hit-test a
// point on the wrong screen -- or on no screen.
func packPoint(x, y int) uintptr {
	return uintptr(uint64(uint32(int32(x))) | uint64(uint32(int32(y)))<<32)
}

// pointInRect reports whether a screen point falls inside a UIA bounding
// rectangle given as (left, top, width, height). A zero-area rectangle
// contains nothing: UIA reports one for an element that is not on screen,
// and "the point is inside it" would be the wrong answer for every point.
func pointInRect(x, y, left, top, width, height int) bool {
	if width <= 0 || height <= 0 {
		return false
	}
	return x >= left && x < left+width && y >= top && y < top+height
}

// recorderFrame builds the frame the brain accepts. The envelope matters:
// the brain's validator drops any frame whose `type` is not one of
// rpc_result / rpc_progress / sidecar_event before it reaches a listener, so
// an event built with only EventType and Payload is silently lost. Every
// observer sets these three fields; the recorder must too.
func recorderFrame(eventType string, payload map[string]any) SidecarEvent {
	return SidecarEvent{
		Type:      "sidecar_event",
		EventType: eventType,
		Timestamp: time.Now().UnixMilli(),
		Priority:  "normal",
		Payload:   payload,
	}
}

func recorderEmit(eventType string, payload map[string]any) {
	recorderMu.Lock()
	ctx, send := recorderCtx, recorderSend
	recorderMu.Unlock()
	if send == nil || ctx == nil {
		return
	}
	if err := send(ctx, recorderFrame(eventType, payload), nil); err != nil {
		log.Printf("[recorder] send %s failed: %v", eventType, err)
	}
}

// emitInteraction sends one ui_interaction event to the brain. The payload
// shape matches src/skills/recorder.ts RawInteraction. Secret redaction is
// done brain-side at push time; the sidecar marks secure fields via `secure`
// and never includes their value.
func emitInteraction(payload map[string]any) {
	recorderEmit("ui_interaction", payload)
}

// recorderIndicator shows or clears the visible recording state. Runs under
// recorderOpMu; the pebble calls are cheap and the notification is async.
func recorderIndicator(on bool, capDur time.Duration) {
	if on {
		if recorderPebble != nil {
			_ = recorderPebble.SetText("Recording a skill")
			_ = recorderPebble.SetState(PebbleWorking)
		}
		go showNotification(Notification{
			ID:    "skill-recording",
			Kind:  "recording",
			Title: "Jarvis is recording a skill",
			Body:  fmt.Sprintf("Your clicks and typing in every app are being watched until you stop the recording or %d minutes pass.", int(capDur/time.Minute)),
		})
		return
	}
	if recorderPebble != nil {
		_ = recorderPebble.SetText("")
		_ = recorderPebble.SetState(PebbleIdle)
	}
	go showNotification(Notification{
		ID:    "skill-recording",
		Kind:  "recording",
		Title: "Recording stopped",
		Body:  "Jarvis is no longer watching your clicks and typing.",
	})
}

// recorderCapFromParams reads max_ms and clamps it to the allowed window.
func recorderCapFromParams(params map[string]any) time.Duration {
	capDur := recorderDefaultCap
	switch v := params["max_ms"].(type) {
	case float64:
		capDur = time.Duration(v) * time.Millisecond
	case int:
		capDur = time.Duration(v) * time.Millisecond
	case int64:
		capDur = time.Duration(v) * time.Millisecond
	}
	if capDur < recorderMinCap {
		capDur = recorderMinCap
	}
	if capDur > recorderMaxCap {
		capDur = recorderMaxCap
	}
	return capDur
}

// handleRecorderStart installs the platform input hook and arms the cap.
// A failed install is reported as an error, never as {"recording": true}.
func handleRecorderStart(params map[string]any) (*RPCResult, error) {
	recorderOpMu.Lock()
	defer recorderOpMu.Unlock()

	capDur := recorderCapFromParams(params)
	if recorderActive {
		return &RPCResult{Result: map[string]any{"recording": true, "note": "already recording", "max_ms": capDur.Milliseconds()}}, nil
	}
	if inputHookStart == nil {
		return nil, fmt.Errorf("skill recording is not available in this build")
	}
	if err := inputHookStart(); err != nil {
		return nil, fmt.Errorf("could not install the input hook: %w", err)
	}
	recorderActive = true
	recorderTimer = time.AfterFunc(capDur, func() { stopRecording("cap") })
	recorderIndicator(true, capDur)
	log.Printf("[recorder] recording started (cap %s)", capDur)
	return &RPCResult{Result: map[string]any{"recording": true, "max_ms": capDur.Milliseconds()}}, nil
}

func handleRecorderStop(params map[string]any) (*RPCResult, error) {
	stopRecording("rpc")
	return &RPCResult{Result: map[string]any{"recording": false}}, nil
}

// stopRecording removes the hooks if they are installed and tells the brain.
// reason is "rpc" (recorder_stop), "cap" (timer) or "shutdown".
func stopRecording(reason string) {
	recorderOpMu.Lock()
	defer recorderOpMu.Unlock()
	if !recorderActive {
		return
	}
	recorderActive = false
	if recorderTimer != nil {
		recorderTimer.Stop()
		recorderTimer = nil
	}
	if inputHookStop != nil {
		inputHookStop()
	}
	recorderIndicator(false, 0)
	log.Printf("[recorder] recording stopped (%s)", reason)
	recorderEmit("ui_recording", map[string]any{"state": "stopped", "reason": reason, "ts": time.Now().UnixMilli()})
}

// recorderIsActive reports whether hooks are installed (tests, shutdown).
func recorderIsActive() bool {
	recorderOpMu.Lock()
	defer recorderOpMu.Unlock()
	return recorderActive
}
