package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// recorderHarness swaps the platform hook functions for stubs and captures
// what the recorder sends to the brain, so the start/stop/cap state machine
// is tested on every platform.
type recorderHarness struct {
	mu       sync.Mutex
	starts   int
	stops    int
	startErr error
	events   []SidecarEvent
}

func newRecorderHarness(t *testing.T) *recorderHarness {
	t.Helper()
	h := &recorderHarness{}
	prevStart, prevStop := inputHookStart, inputHookStop
	inputHookStart = func() error {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.startErr != nil {
			return h.startErr
		}
		h.starts++
		return nil
	}
	inputHookStop = func() {
		h.mu.Lock()
		h.stops++
		h.mu.Unlock()
	}
	setRecorderSender(context.Background(), func(ctx context.Context, ev SidecarEvent, _ []byte) error {
		h.mu.Lock()
		h.events = append(h.events, ev)
		h.mu.Unlock()
		return nil
	})
	setRecorderIndicator(nil)
	t.Cleanup(func() {
		stopRecording("test")
		inputHookStart, inputHookStop = prevStart, prevStop
		setRecorderSender(context.Background(), nil)
	})
	return h
}

func (h *recorderHarness) counts() (int, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.starts, h.stops
}

func (h *recorderHarness) stoppedReasons() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, ev := range h.events {
		if ev.EventType == "ui_recording" {
			if r, _ := ev.Payload["reason"].(string); r != "" {
				out = append(out, r)
			}
		}
	}
	return out
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestRecorderStartInstallsHooksAndStopRemovesThem(t *testing.T) {
	h := newRecorderHarness(t)

	res, err := handleRecorderStart(map[string]any{"max_ms": float64(60_000)})
	if err != nil {
		t.Fatal(err)
	}
	m := res.Result.(map[string]any)
	if m["recording"] != true {
		t.Fatalf("expected recording:true, got %v", m)
	}
	if got := m["max_ms"]; got != int64(60_000) {
		t.Fatalf("cap must echo the accepted max_ms, got %v (%T)", got, got)
	}
	if !recorderIsActive() {
		t.Fatal("recorder must be active after start")
	}
	if starts, _ := h.counts(); starts != 1 {
		t.Fatalf("expected one hook install, got %d", starts)
	}

	// A second start while active is a no-op on the hooks.
	if _, err := handleRecorderStart(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if starts, _ := h.counts(); starts != 1 {
		t.Fatalf("second start must not install again, got %d installs", starts)
	}

	if _, err := handleRecorderStop(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if recorderIsActive() {
		t.Fatal("recorder must be inactive after stop")
	}
	if _, stops := h.counts(); stops != 1 {
		t.Fatalf("expected one hook removal, got %d", stops)
	}
	if got := h.stoppedReasons(); len(got) != 1 || got[0] != "rpc" {
		t.Fatalf("brain must hear the stop with reason rpc, got %v", got)
	}

	// Stop when idle is a no-op: no second removal, no second event.
	if _, err := handleRecorderStop(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if _, stops := h.counts(); stops != 1 {
		t.Fatalf("idle stop must not touch the hooks, got %d removals", stops)
	}
	if got := h.stoppedReasons(); len(got) != 1 {
		t.Fatalf("idle stop must not emit again, got %v", got)
	}
}

func TestRecorderFailedInstallIsAnErrorNotRecordingTrue(t *testing.T) {
	h := newRecorderHarness(t)
	h.startErr = errors.New("SetWindowsHookEx(WH_MOUSE_LL): access denied")

	res, err := handleRecorderStart(map[string]any{})
	if err == nil {
		t.Fatalf("expected an error, got %v", res.Result)
	}
	if recorderIsActive() {
		t.Fatal("a failed install must leave the recorder inactive")
	}
	if got := h.stoppedReasons(); len(got) != 0 {
		t.Fatalf("nothing started, so nothing should report a stop: %v", got)
	}
}

func TestRecorderCapStopsTheHooksWithoutABrainStop(t *testing.T) {
	h := newRecorderHarness(t)

	// max_ms below the floor is clamped up to recorderMinCap; shrink the
	// floor for the test so the cap fires quickly.
	prevMin := recorderMinCap
	defer func() { recorderMinCapOverride(prevMin) }()
	recorderMinCapOverride(20 * time.Millisecond)

	if _, err := handleRecorderStart(map[string]any{"max_ms": float64(20)}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return !recorderIsActive() })
	if _, stops := h.counts(); stops != 1 {
		t.Fatalf("cap must remove the hooks exactly once, got %d", stops)
	}
	if got := h.stoppedReasons(); len(got) != 1 || got[0] != "cap" {
		t.Fatalf("brain must hear the cap, got %v", got)
	}
}

func TestRecorderCapIsClamped(t *testing.T) {
	if got := recorderCapFromParams(map[string]any{}); got != recorderDefaultCap {
		t.Fatalf("default cap: got %s", got)
	}
	if got := recorderCapFromParams(map[string]any{"max_ms": float64(1)}); got != recorderMinCap {
		t.Fatalf("below floor must clamp to %s, got %s", recorderMinCap, got)
	}
	if got := recorderCapFromParams(map[string]any{"max_ms": float64(48 * 60 * 60 * 1000)}); got != recorderMaxCap {
		t.Fatalf("above ceiling must clamp to %s, got %s", recorderMaxCap, got)
	}
}

func TestRecorderEventsCarryTheEnvelopeTheBrainAccepts(t *testing.T) {
	// The brain's validator (src/sidecar/validator.ts) rejects any frame whose
	// type is not rpc_result, rpc_progress or sidecar_event, so a recorder
	// event without the envelope is dropped before any listener sees it.
	h := newRecorderHarness(t)
	emitInteraction(map[string]any{"action": "click"})
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.events) != 1 {
		t.Fatalf("expected one event, got %d", len(h.events))
	}
	ev := h.events[0]
	if ev.Type != "sidecar_event" {
		t.Fatalf("type must be sidecar_event, got %q", ev.Type)
	}
	if ev.EventType != "ui_interaction" {
		t.Fatalf("event_type: %q", ev.EventType)
	}
	if ev.Timestamp == 0 {
		t.Fatal("timestamp must be set")
	}
	if ev.Priority != "normal" {
		t.Fatalf("priority: %q", ev.Priority)
	}
}

func TestOwnWindowVerdictIdentifiesJarvisPanelsAndFailsClosed(t *testing.T) {
	const own = uint32(4242)
	const webview = uint32(9001) // msedgewebview2.exe hosting a panel's content
	const otherApp = uint32(777)

	cases := []struct {
		name      string
		elemPid   uint32
		hostPid   uint32
		hostKnown bool
		want      bool
	}{
		// A native control of one of our own windows (the connect window).
		{"own process", own, own, true, true},
		// The reported defect: the chat panel is WebView2, so the element
		// belongs to msedgewebview2.exe and only the hosting window is ours.
		{"webview content hosted by our window", webview, own, true, true},
		// An ordinary app: record it.
		{"another app", otherApp, otherApp, true, false},
		// A webview belonging to somebody else's app (Teams, Spotify): record it.
		{"webview hosted by another app", webview, otherApp, true, false},
		// Fail closed: an element whose hosting window could not be
		// established cannot be shown NOT to be one of our panels.
		{"unknown host", webview, 0, false, true},
		{"unknown host, ordinary-looking element", otherApp, 0, false, true},
	}
	for _, c := range cases {
		if got := ownWindowVerdict(c.elemPid, c.hostPid, own, c.hostKnown); got != c.want {
			t.Errorf("%s: ownWindowVerdict(elem=%d, host=%d, own=%d, known=%v) = %v, want %v",
				c.name, c.elemPid, c.hostPid, own, c.hostKnown, got, c.want)
		}
	}
}

func TestOwnWindowReasonNamesWhichOfTheTwoDropsItWas(t *testing.T) {
	const own = uint32(4242)
	// A drop the person should read as working as intended.
	panel := ownWindowReason(9001, own, own, true)
	if !strings.Contains(panel, "Jarvis's own window") {
		t.Errorf("a panel drop must say so, got %q", panel)
	}
	// A drop caused by a UIA read this machine would not answer. Saying
	// "Jarvis's own window" here would send someone looking in the wrong
	// place for why their typing was ignored.
	unknown := ownWindowReason(777, 0, own, false)
	if strings.Contains(unknown, "Jarvis's own window") {
		t.Errorf("an unreadable-host drop must not be reported as a panel, got %q", unknown)
	}
	if !strings.Contains(unknown, "hosting window could not be read") {
		t.Errorf("an unreadable-host drop must say what failed, got %q", unknown)
	}
}

func TestOwnWindowErrorIsDistinguishableFromACaptureFailure(t *testing.T) {
	// The capture paths log a fault but drop an own-window element quietly,
	// so the two must not be conflated.
	if !errors.Is(errOwnWindow, errOwnWindow) {
		t.Fatal("errOwnWindow must match itself")
	}
	if errors.Is(errors.New("ElementFromPoint failed"), errOwnWindow) {
		t.Fatal("an unrelated capture failure must not read as an own-window drop")
	}
	if errors.Is(fmt.Errorf("wrapped: %w", errOwnWindow), errOwnWindow) != true {
		t.Fatal("a wrapped errOwnWindow must still be recognised")
	}
}

// The cast the attribution table is written against. Pids and hwnds are
// arbitrary but fixed, so a failure names a recognisable actor.
const (
	pidJarvis   = uint32(4242) // the sidecar itself
	pidWebview  = uint32(9001) // msedgewebview2.exe, hosting WebView2 content
	pidNotepad  = uint32(1001) // the app the person was in
	pidChrome   = uint32(1002) // the app they switched to
	pidExplorer = uint32(1003) // the taskbar
	pidOverlay  = uint32(1004) // an NVIDIA-style overlay drawn on top
	pidAppFrame = uint32(1005) // ApplicationFrameHost.exe, owner of UWP frames
	pidTeams    = uint32(1006) // a WebView2 app that is not ours

	hwndNotepad  = uintptr(0x1001)
	hwndChrome   = uintptr(0x1002)
	hwndTaskbar  = uintptr(0x1003)
	hwndMenu     = uintptr(0x1004)
	hwndOwnPanel = uintptr(0x1005)
	hwndOverlay  = uintptr(0x1006)
	hwndUWP      = uintptr(0x1007)
	hwndTeams    = uintptr(0x1008)
	hwndPebble   = uintptr(0x1009)
	hwndNotepad2 = uintptr(0x100a) // a second window of the same app
)

func TestClickAttributionUsesTheClickTimeWindowNotTheCurrentForeground(t *testing.T) {
	cases := []struct {
		name  string
		facts clickFacts
		want  clickTarget
	}{
		{
			// The ordinary case: nothing on top, nothing moved.
			name: "normal click in the foreground window",
			facts: clickFacts{
				HostHwnd: hwndNotepad, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: pidNotepad, HitHostHwnd: hwndNotepad,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetHit,
		},
		{
			// A UWP app (Calculator, Settings): the top-level frame belongs
			// to ApplicationFrameHost.exe, the content to the app. Different
			// processes, one window, an ordinary click. Comparing pids would
			// call this an overlay.
			name: "UWP content inside an ApplicationFrameHost window",
			facts: clickFacts{
				HostHwnd: hwndUWP, HostPid: pidAppFrame,
				FgHwnd: hwndUWP, FgPid: pidAppFrame,
				HostStillExists: true, HostPidNow: pidAppFrame,
				HitPid: pidChrome, HitHostHwnd: hwndUWP,
				CurrentFgPid: pidAppFrame, OwnPid: pidJarvis,
			},
			want: clickTargetHit,
		},
		{
			// Somebody else's WebView2 app (Teams, Spotify): the window is
			// the app's, the content is msedgewebview2.exe's.
			name: "WebView2 content inside another app's window",
			facts: clickFacts{
				HostHwnd: hwndTeams, HostPid: pidTeams,
				FgHwnd: hwndTeams, FgPid: pidTeams,
				HostStillExists: true, HostPidNow: pidTeams,
				HitPid: pidWebview, HitHostHwnd: hwndTeams,
				CurrentFgPid: pidTeams, OwnPid: pidJarvis,
			},
			want: clickTargetHit,
		},
		{
			// #493: a transparent GPU overlay is what UIA's hit test returns,
			// but the click went to the app underneath -- a different window,
			// which is what makes this an overlay rather than hosted content.
			name: "overlay covering the foreground window",
			facts: clickFacts{
				HostHwnd: hwndNotepad, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: pidOverlay, HitHostHwnd: hwndOverlay,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetHostWindow,
		},
		{
			// #499, the reported case: clicking Chrome's taskbar button while
			// Notepad was foreground. The taskbar received the click and is
			// still what is under the pointer, so the step is the taskbar
			// button -- whoever won the activation race.
			name: "app switch mid-settle, taskbar still under the pointer",
			facts: clickFacts{
				HostHwnd: hwndTaskbar, HostPid: pidExplorer,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidExplorer,
				HitPid: pidExplorer, HitHostHwnd: hwndTaskbar,
				CurrentFgPid: pidChrome, OwnPid: pidJarvis,
			},
			want: clickTargetHit,
		},
		{
			// Same click, but the window that came up now covers the point.
			// Resolved against the taskbar, never against Notepad (the old
			// foreground) or Chrome (the new one).
			name: "app switch mid-settle, the new window now covers the point",
			facts: clickFacts{
				HostHwnd: hwndTaskbar, HostPid: pidExplorer,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidExplorer,
				HitPid: pidChrome, HitHostHwnd: hwndChrome,
				CurrentFgPid: pidChrome, OwnPid: pidJarvis,
			},
			want: clickTargetHostWindow,
		},
		{
			// A menu item: the popup is its own top-level window and is
			// destroyed by the time the COM thread arrives. Nothing of it
			// survives to attribute to.
			name: "hosting window destroyed before resolution",
			facts: clickFacts{
				HostHwnd: hwndMenu, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: false, HostPidNow: 0,
				HitPid: pidNotepad, HitHostHwnd: hwndNotepad,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetDrop,
		},
		{
			// Windows recycles HWNDs. A handle that still answers IsWindow
			// but belongs to another process now is a different window
			// wearing the dead one's number.
			name: "hosting hwnd reused by another process",
			facts: clickFacts{
				HostHwnd: hwndMenu, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidChrome,
				HitPid: pidChrome, HitHostHwnd: hwndMenu,
				CurrentFgPid: pidChrome, OwnPid: pidJarvis,
			},
			want: clickTargetDrop,
		},
		{
			// It answered IsWindow and then died between the two reads.
			name: "hosting window dies between the existence and pid reads",
			facts: clickFacts{
				HostHwnd: hwndMenu, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: 0,
				HitPid: pidNotepad, HitHostHwnd: hwndNotepad,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetDrop,
		},
		{
			// The hook saw no window under the pointer at all.
			name: "no hosting window recorded",
			facts: clickFacts{
				HostHwnd: 0, HostPid: 0,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: false, HostPidNow: 0,
				HitPid: pidNotepad, HitHostHwnd: hwndNotepad,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetDrop,
		},
		{
			// A window with no pid is just as unknown: nothing can be
			// checked against it later.
			name: "hosting window recorded without a pid",
			facts: clickFacts{
				HostHwnd: hwndNotepad, HostPid: 0,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: pidNotepad, HitHostHwnd: hwndNotepad,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetDrop,
		},
		{
			// A pid with no window is equally unusable.
			name: "hosting pid recorded without a window",
			facts: clickFacts{
				HostHwnd: 0, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: pidNotepad, HitHostHwnd: hwndNotepad,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetDrop,
		},
		{
			// #493's panel rule, now decided from the click-time window:
			// the chat panel takes its own clicks, so it is what
			// WindowFromPoint named, whatever process its WebView2 content
			// belongs to.
			name: "Jarvis chat panel (WebView2 content in our own window)",
			facts: clickFacts{
				HostHwnd: hwndOwnPanel, HostPid: pidJarvis,
				FgHwnd: hwndOwnPanel, FgPid: pidJarvis,
				HostStillExists: true, HostPidNow: pidJarvis,
				HitPid: pidWebview, HitHostHwnd: hwndOwnPanel,
				CurrentFgPid: pidJarvis, OwnPid: pidJarvis,
			},
			want: clickTargetOwnWindow,
		},
		{
			// A panel is topmost without being foreground: the person clicks
			// it while their app keeps the foreground. Still not a step, and
			// above all not re-pointed at the app behind it.
			name: "Jarvis panel clicked while another app is foreground",
			facts: clickFacts{
				HostHwnd: hwndOwnPanel, HostPid: pidJarvis,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidJarvis,
				HitPid: pidWebview, HitHostHwnd: hwndOwnPanel,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetOwnWindow,
		},
		{
			// A native control of one of our own windows (the connect window).
			name: "Jarvis's own native window",
			facts: clickFacts{
				HostHwnd: hwndOwnPanel, HostPid: pidJarvis,
				FgHwnd: hwndOwnPanel, FgPid: pidJarvis,
				HostStillExists: true, HostPidNow: pidJarvis,
				HitPid: pidJarvis, HitHostHwnd: hwndOwnPanel,
				CurrentFgPid: pidJarvis, OwnPid: pidJarvis,
			},
			want: clickTargetOwnWindow,
		},
		{
			// Our own recording indicator sits on screen for the whole
			// recording and is click-through, so the click went past it to
			// the app. UIA's hit test still returns it. #493 had to drop
			// this click; the click-time window makes it recordable.
			name: "Jarvis's click-through indicator drawn over the app",
			facts: clickFacts{
				HostHwnd: hwndNotepad, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: pidJarvis, HitHostHwnd: hwndPebble,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetHostWindow,
		},
		{
			// The same, with the indicator's WebView2 content as the hit
			// element: not our pid, not our window, still re-pointed at the
			// window that took the click.
			name: "Jarvis's click-through panel content drawn over the app",
			facts: clickFacts{
				HostHwnd: hwndNotepad, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: pidWebview, HitHostHwnd: hwndPebble,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetHostWindow,
		},
		{
			// UIA would not say which window hosts the element it returned.
			// The recorded window is alive and is not ours, so the click can
			// still be placed in it without guessing.
			name: "hit element's hosting window unknown",
			facts: clickFacts{
				HostHwnd: hwndNotepad, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: pidOverlay, HitHostHwnd: 0,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetHostWindow,
		},
		{
			// No pid on the hit element, but its window is the one that got
			// the click. The window is what the rule is about, so this is an
			// ordinary click.
			name: "hit element reports no process but the right window",
			facts: clickFacts{
				HostHwnd: hwndNotepad, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: 0, HitHostHwnd: hwndNotepad,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetHit,
		},
		{
			// An overlay that takes its clicks IS the window that received
			// this one, so it is recorded as itself. Accurate, if not
			// useful; documented on clickAttribution.
			name: "interactive overlay that actually took the click",
			facts: clickFacts{
				HostHwnd: hwndOverlay, HostPid: pidOverlay,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidOverlay,
				HitPid: pidOverlay, HitHostHwnd: hwndOverlay,
				CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
			},
			want: clickTargetHit,
		},
		{
			// With no own pid to compare against (a build that never
			// established one), the own-window rules simply do not fire and
			// the ordinary rules still decide.
			name: "own pid unknown",
			facts: clickFacts{
				HostHwnd: hwndNotepad, HostPid: pidNotepad,
				FgHwnd: hwndNotepad, FgPid: pidNotepad,
				HostStillExists: true, HostPidNow: pidNotepad,
				HitPid: pidNotepad, HitHostHwnd: hwndNotepad,
				CurrentFgPid: pidNotepad, OwnPid: 0,
			},
			want: clickTargetHit,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, reason := clickAttribution(c.facts)
			if got != c.want {
				t.Errorf("got %s, want %s (reason: %s)", got, c.want, reason)
			}
			if reason == "" {
				t.Error("every verdict must carry a reason for the log")
			}
		})
	}
}

func TestClickAttributionDropsAClickAnotherWindowHadCaptured(t *testing.T) {
	// A window holding the mouse capture receives the click wherever the
	// pointer is. The classic case is dismissing an open menu by clicking
	// away: the window under the pointer gets nothing, and recording a step
	// against the control that happened to be there is an invention -- a
	// more plausible-looking one than before, because that control really
	// is under the pointer.
	away := clickFacts{
		HostHwnd: hwndNotepad, HostPid: pidNotepad,
		FgHwnd: hwndNotepad, FgPid: pidNotepad,
		CaptureHwnd: hwndMenu, MenuUp: true,
		HostStillExists: true, HostPidNow: pidNotepad,
		HitPid: pidNotepad, HitHostHwnd: hwndNotepad,
		CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
	}
	got, reason := clickAttribution(away)
	if got != clickTargetDrop {
		t.Errorf("a click that went to the capturing window must drop, got %s (%s)", got, reason)
	}
	if !strings.Contains(reason, "mouse capture") || !strings.Contains(reason, "menu open") {
		t.Errorf("the reason must name the capture and the menu, got %q", reason)
	}

	// The capturing window IS the clicked window: an ordinary click inside
	// something that captures the mouse (a scrollbar, a slider).
	own := away
	own.CaptureHwnd = hwndNotepad
	own.MenuUp = false
	if got, reason := clickAttribution(own); got != clickTargetHit {
		t.Errorf("a click on the capturing window itself must record, got %s (%s)", got, reason)
	}

	// Nothing captured: the guard must not fire. This is the common case,
	// and a guard that suppresses it would silently empty every recording.
	none := away
	none.CaptureHwnd = 0
	none.MenuUp = false
	if got, reason := clickAttribution(none); got != clickTargetHit {
		t.Errorf("with no capture the click must record, got %s (%s)", got, reason)
	}

	// The reader must see capture drops as their own cause, not as a menu
	// one, when no menu was involved (a drag in another app, say).
	silent := away
	silent.MenuUp = false
	got, reason = clickAttribution(silent)
	if got != clickTargetDrop {
		// Not just the wording: the rule must be about the capture, not
		// about the menu. Narrowed to menus it would silently record every
		// other captured click against the window under the pointer.
		t.Errorf("a captured click with no menu must still drop, got %s (%s)", got, reason)
	}
	if strings.Contains(reason, "menu") {
		t.Errorf("a capture drop with no menu must not mention one, got %q", reason)
	}
}

func TestPressSiteStillAppliesBoundsTheClickToWhatWasPressed(t *testing.T) {
	// The press point and the release point have to describe the same
	// place, because the window comes from the first and the hit test
	// resolves at the second.
	cases := []struct {
		name    string
		px, py  int
		sampled bool
		rx, ry  int
		want    bool
	}{
		{"same point", 500, 400, true, 500, 400, true},
		{"within the slop", 500, 400, true, 504, 396, true},
		{"one pixel past the slop in x", 500, 400, true, 505, 400, false},
		{"one pixel past the slop in y", 500, 400, true, 500, 405, false},
		{"a drag across the screen", 500, 400, true, 900, 700, false},
		{"no press was seen", 0, 0, false, 500, 400, false},
		// The same point, so only the flag can say there was no press.
		{"no press was seen, release at the zero point", 0, 0, false, 0, 0, false},
		// A press whose coordinates happen to be the zero point is still a
		// press: sampled, not the zero value, is what says so.
		{"press at the origin", 0, 0, true, 0, 0, true},
		// Negative coordinates are a monitor left of or above the primary.
		{"negative coordinates, within the slop", -1200, -300, true, -1198, -302, true},
		{"negative coordinates, a drag", -1200, -300, true, -1100, -300, false},
		{"across the origin, past the slop", -3, 0, true, 3, 0, false},
	}
	for _, c := range cases {
		if got := pressSiteStillApplies(c.px, c.py, c.sampled, c.rx, c.ry); got != c.want {
			t.Errorf("%s: pressSiteStillApplies(%d,%d,%v,%d,%d) = %v, want %v",
				c.name, c.px, c.py, c.sampled, c.rx, c.ry, got, c.want)
		}
	}
}

func TestPackPointKeepsBothHalvesAndTheirSigns(t *testing.T) {
	// A Win32 POINT passed by value: x in the low dword, y in the high one.
	// Sign-extending x into y's half would hit-test a point on another
	// screen, which is what a monitor placed left of or above the primary
	// produces.
	cases := []struct{ x, y int }{
		{0, 0}, {1, 2}, {1920, 1080}, {-1, -1}, {-1200, -300}, {-1, 1}, {1, -1},
		{2147483647, -2147483648}, {-2147483648, 2147483647},
	}
	for _, c := range cases {
		p := uint64(packPoint(c.x, c.y))
		gotX := int32(uint32(p & 0xffffffff))
		gotY := int32(uint32(p >> 32))
		if int(gotX) != c.x || int(gotY) != c.y {
			t.Errorf("packPoint(%d, %d) unpacked to (%d, %d)", c.x, c.y, gotX, gotY)
		}
	}
}

func TestPointInRectIsHalfOpenAndRejectsEmptyRects(t *testing.T) {
	// Half-open on purpose: UIA rectangles of adjacent controls share an
	// edge, and counting both as containing it would make the choice
	// between two neighbouring buttons depend on enumeration order.
	const l, t0, w, h = 100, 200, 50, 20
	cases := []struct {
		name string
		x, y int
		w, h int
		want bool
	}{
		{"inside", 120, 210, w, h, true},
		{"top-left corner is inside", 100, 200, w, h, true},
		{"right edge is outside", 150, 210, w, h, false},
		{"bottom edge is outside", 120, 220, w, h, false},
		{"left of the rect", 99, 210, w, h, false},
		{"above the rect", 120, 199, w, h, false},
		// An offscreen element reports an empty rectangle, and every point
		// would otherwise be "inside" a zero-width one at that origin.
		{"zero width contains nothing", 100, 200, 0, h, false},
		{"zero height contains nothing", 100, 200, w, 0, false},
		{"negative size contains nothing", 100, 200, -10, -10, false},
	}
	for _, c := range cases {
		if got := pointInRect(c.x, c.y, l, t0, c.w, c.h); got != c.want {
			t.Errorf("%s: pointInRect(%d,%d, %d,%d,%d,%d) = %v, want %v",
				c.name, c.x, c.y, l, t0, c.w, c.h, got, c.want)
		}
	}
}

func TestClickAttributionNeverReactsToTheForegroundAtResolutionTime(t *testing.T) {
	// The whole of #499 in one assertion: what is in front now is not
	// evidence about a click that happened 60ms or more ago, so varying it
	// must not move any verdict. If a future rule reads CurrentFgPid, this
	// fails.
	bases := []clickFacts{
		{HostHwnd: hwndNotepad, HostPid: pidNotepad, FgHwnd: hwndNotepad, FgPid: pidNotepad, HostStillExists: true, HostPidNow: pidNotepad, HitPid: pidNotepad, HitHostHwnd: hwndNotepad, OwnPid: pidJarvis},
		{HostHwnd: hwndNotepad, HostPid: pidNotepad, FgHwnd: hwndNotepad, FgPid: pidNotepad, HostStillExists: true, HostPidNow: pidNotepad, HitPid: pidOverlay, HitHostHwnd: hwndOverlay, OwnPid: pidJarvis},
		{HostHwnd: hwndTaskbar, HostPid: pidExplorer, FgHwnd: hwndNotepad, FgPid: pidNotepad, HostStillExists: true, HostPidNow: pidExplorer, HitPid: pidExplorer, HitHostHwnd: hwndTaskbar, OwnPid: pidJarvis},
		{HostHwnd: hwndMenu, HostPid: pidNotepad, FgHwnd: hwndNotepad, FgPid: pidNotepad, HostStillExists: false, HitPid: pidNotepad, HitHostHwnd: hwndNotepad, OwnPid: pidJarvis},
		{HostHwnd: hwndOwnPanel, HostPid: pidJarvis, FgHwnd: hwndNotepad, FgPid: pidNotepad, HostStillExists: true, HostPidNow: pidJarvis, HitPid: pidWebview, HitHostHwnd: hwndOwnPanel, OwnPid: pidJarvis},
		{HostHwnd: hwndNotepad, HostPid: pidNotepad, FgHwnd: hwndNotepad, FgPid: pidNotepad, HostStillExists: true, HostPidNow: pidNotepad, HitPid: pidJarvis, HitHostHwnd: hwndPebble, OwnPid: pidJarvis},
	}
	for i, base := range bases {
		want, _ := clickAttribution(base)
		for _, fg := range []uint32{0, pidNotepad, pidChrome, pidExplorer, pidJarvis, pidOverlay} {
			f := base
			f.CurrentFgPid = fg
			if got, reason := clickAttribution(f); got != want {
				t.Errorf("case %d: current foreground pid %d changed the verdict to %s (want %s): %s", i, fg, got, want, reason)
			}
		}
	}
}

func TestClickAttributionFailsClosedByDefault(t *testing.T) {
	// A clickTarget nobody assigned must be the one that records nothing.
	var unset clickTarget
	if unset != clickTargetDrop {
		t.Fatalf("the zero clickTarget must be %s, got %s", clickTargetDrop, unset)
	}
	// And the zero clickFacts -- which is what a click the hook never
	// managed to sample arrives as -- must drop.
	if got, reason := clickAttribution(clickFacts{}); got != clickTargetDrop {
		t.Fatalf("unsampled facts must drop, got %s: %s", got, reason)
	}
}

func TestClickAttributionReasonsNameWhatWentWrong(t *testing.T) {
	// A dropped step is invisible on the approval card, so the log line is
	// the only way a person finds out why it is missing.
	_, gone := clickAttribution(clickFacts{
		HostHwnd: hwndMenu, HostPid: pidNotepad,
		FgHwnd: hwndNotepad, FgPid: pidNotepad,
		HostStillExists: false,
		HitPid:          pidNotepad, HitHostHwnd: hwndNotepad,
		CurrentFgPid: pidChrome, OwnPid: pidJarvis,
	})
	if !strings.Contains(gone, "no longer exists") {
		t.Errorf("a destroyed hosting window must say so, got %q", gone)
	}
	if !strings.Contains(gone, "foreground moved") {
		t.Errorf("a drop during an app switch must mention the switch, got %q", gone)
	}

	// A reused handle is a different failure from a destroyed window and
	// sends a reader somewhere else; it must not be reported as the same.
	_, reused := clickAttribution(clickFacts{
		HostHwnd: hwndMenu, HostPid: pidNotepad,
		FgHwnd: hwndNotepad, FgPid: pidNotepad,
		HostStillExists: true, HostPidNow: pidChrome,
		HitPid: pidChrome, HitHostHwnd: hwndMenu,
		CurrentFgPid: pidChrome, OwnPid: pidJarvis,
	})
	if !strings.Contains(reused, "has been reused") {
		t.Errorf("a recycled handle must say so, got %q", reused)
	}

	// The overlay reason names the intruder and the window it covers, which
	// is what identified the NVIDIA overlay in #493 from a log alone.
	_, overlay := clickAttribution(clickFacts{
		HostHwnd: hwndNotepad, HostPid: pidNotepad,
		FgHwnd: hwndNotepad, FgPid: pidNotepad,
		HostStillExists: true, HostPidNow: pidNotepad,
		HitPid: pidOverlay, HitHostHwnd: hwndOverlay,
		CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
	})
	if !strings.Contains(overlay, fmt.Sprintf("pid %d", pidOverlay)) {
		t.Errorf("the overlay reason must name the overlay's pid, got %q", overlay)
	}
	if !strings.Contains(overlay, "the foreground window at the time") {
		t.Errorf("the overlay reason must say the clicked window was foreground, got %q", overlay)
	}

	// Foreground is a window, not a process: another window of the same app
	// held the foreground, so the clicked window was not the foreground one
	// even though the pids match.
	_, sibling := clickAttribution(clickFacts{
		HostHwnd: hwndNotepad, HostPid: pidNotepad,
		FgHwnd: hwndNotepad2, FgPid: pidNotepad,
		HostStillExists: true, HostPidNow: pidNotepad,
		HitPid: pidOverlay, HitHostHwnd: hwndOverlay,
		CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
	})
	if !strings.Contains(sibling, "not the foreground window at the time") {
		t.Errorf("a click on a non-foreground window of the foreground app must say so, got %q", sibling)
	}

	// No foreground window at all (the secure desktop came and went) is its
	// own thing again, and must not be reported as a background click.
	_, noFg := clickAttribution(clickFacts{
		HostHwnd: hwndNotepad, HostPid: pidNotepad,
		FgHwnd: 0, FgPid: 0,
		HostStillExists: true, HostPidNow: pidNotepad,
		HitPid: pidOverlay, HitHostHwnd: hwndOverlay,
		CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
	})
	if !strings.Contains(noFg, "no foreground window at the time") {
		t.Errorf("a click with no foreground window must say so, got %q", noFg)
	}

	// A click that went through one of our own surfaces must read as that,
	// not as a third-party overlay: the two send a reader to different code.
	_, ours := clickAttribution(clickFacts{
		HostHwnd: hwndNotepad, HostPid: pidNotepad,
		FgHwnd: hwndNotepad, FgPid: pidNotepad,
		HostStillExists: true, HostPidNow: pidNotepad,
		HitPid: pidJarvis, HitHostHwnd: hwndPebble,
		CurrentFgPid: pidNotepad, OwnPid: pidJarvis,
	})
	if !strings.Contains(ours, "Jarvis surface") {
		t.Errorf("a click through one of our own surfaces must say so, got %q", ours)
	}

	// An own-window drop names the window, so it can be told from every
	// other reason a step is missing.
	_, panel := clickAttribution(clickFacts{
		HostHwnd: hwndOwnPanel, HostPid: pidJarvis,
		FgHwnd: hwndOwnPanel, FgPid: pidJarvis,
		HostStillExists: true, HostPidNow: pidJarvis,
		HitPid: pidWebview, HitHostHwnd: hwndOwnPanel,
		CurrentFgPid: pidJarvis, OwnPid: pidJarvis,
	})
	if !strings.Contains(panel, "Jarvis's own windows") {
		t.Errorf("an own-window drop must say so, got %q", panel)
	}
}

func TestClickUnattributableErrorIsItsOwnKind(t *testing.T) {
	// A dropped click is not an own-window ignore and not a capture fault;
	// the three are logged differently on purpose.
	if errors.Is(errClickUnattributable, errOwnWindow) || errors.Is(errOwnWindow, errClickUnattributable) {
		t.Fatal("a dropped click and an own-window ignore must stay distinguishable")
	}
	if !errors.Is(fmt.Errorf("wrapped: %w", errClickUnattributable), errClickUnattributable) {
		t.Fatal("a wrapped errClickUnattributable must still be recognised")
	}
	if errors.Is(errors.New("ElementFromPoint failed"), errClickUnattributable) {
		t.Fatal("an unrelated capture failure must not read as a dropped click")
	}
}
