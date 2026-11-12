package main

import (
	"context"
	"math"
	"strings"
	"testing"
)

func TestNotchOutlineAcceptsAPolygonInsideTheWindow(t *testing.T) {
	got, err := notchOutline([][]float64{{100, 0}, {300, 0}, {300, 40}, {100, 40}}, 760, 600)
	if err != nil {
		t.Fatalf("a plain rectangle was refused: %v", err)
	}
	if len(got) != 4 || got[2] != (notchVertex{X: 300, Y: 40}) {
		t.Fatalf("unexpected outline: %v", got)
	}
	// The top corners may sit a little above the screen edge.
	if _, err := notchOutline([][]float64{{100, -16}, {300, -16}, {200, 40}}, 760, 600); err != nil {
		t.Fatalf("a point just above the window was refused: %v", err)
	}
}

// A curve needs points between pixels. They must arrive as sent, and only the
// window cut, which can do no better, moves them onto whole pixels.
func TestNotchOutlineKeepsFractionsAndTheCutRoundsThem(t *testing.T) {
	got, err := notchOutline([][]float64{{100.25, 0}, {300.5, 0.75}, {200.49, 40.51}}, 760, 600)
	if err != nil {
		t.Fatalf("an outline with fractions was refused: %v", err)
	}
	if got[0].X != 100.25 || got[1].Y != 0.75 {
		t.Fatalf("fractions were lost: %v", got)
	}
	whole := notchWhole(got)
	want := []notchPoint{{100, 0}, {301, 1}, {200, 41}}
	for i := range want {
		if whole[i] != want[i] {
			t.Fatalf("point %d rounded to %v, want %v", i, whole[i], want[i])
		}
	}
}

// The page is not trusted to cut the window to any shape it likes. Each of
// these must be refused whole, so the previous shape stays.
func TestNotchOutlineRefusesWhatAPageShouldNotSend(t *testing.T) {
	tooMany := make([][]float64, notchOutlineMaxPoints+1)
	for i := range tooMany {
		tooMany[i] = []float64{float64(i % 700), 10}
	}
	for name, points := range map[string][][]float64{
		"two points":       {{0, 0}, {10, 10}},
		"no points":        {},
		"too many points":  tooMany,
		"a point of three": {{0, 0}, {10, 10, 10}, {20, 0}},
		"far to the right": {{0, 0}, {5000, 10}, {20, 0}},
		"far below":        {{0, 0}, {10, 5000}, {20, 0}},
		"far above":        {{0, -500}, {10, 10}, {20, 0}},
		"not a number":     {{0, 0}, {math.NaN(), 10}, {20, 0}},
		"without end":      {{0, 0}, {10, math.Inf(1)}, {20, 0}},
	} {
		if _, err := notchOutline(points, 760, 600); err == nil {
			t.Errorf("%s: expected the outline to be refused", name)
		}
	}
}

func TestNotchSitsAtTheTopCentre(t *testing.T) {
	if x := notchTopCentre(1920, 760); x != 580 {
		t.Fatalf("on a 1920 display a 760 window starts at %d, want 580", x)
	}
	if x := notchTopCentre(700, 760); x != 0 {
		t.Fatalf("a window wider than the display starts at %d, want 0", x)
	}
}

// The fullscreen rule, whole: it hides for a fullscreen video and for nothing
// else. Every one of the three is needed. The third row from the end is the
// machine this was found on: a browser in fullscreen, being read, while some
// other program kept the display awake all day.
func TestNotchHidesOnlyForAFullscreenVideo(t *testing.T) {
	for _, c := range []struct {
		fullscreen, awake, playing, hide bool
	}{
		{false, false, false, false},
		{true, false, false, false}, // fullscreen browser, reading
		{false, true, false, false}, // a video in a window
		{false, true, true, false},  // the same, picture moving
		{true, false, true, false},  // a moving picture nothing keeps awake: not a player
		{true, true, false, false},  // fullscreen browser, reading, display held by another program
		{false, false, true, false}, // something moving in a window
		{true, true, true, true},    // a fullscreen video
	} {
		if got := notchShouldHide(c.fullscreen, c.awake, c.playing); got != c.hide {
			t.Errorf("fullscreen=%v awake=%v playing=%v: hide=%v, want %v", c.fullscreen, c.awake, c.playing, got, c.hide)
		}
	}
}

func notchTestSpawn(svc *NotchService, panels PanelService) RPCHandler {
	return makeNotchSpawnHandler(svc, panels, "ws://localhost:3143/sidecar/connect",
		func(context.Context) (string, error) { return "tok", nil })
}

func TestNotchSpawnOpensOneNotchPanelOnTheBrainsOrigin(t *testing.T) {
	svc := &NotchService{}
	panels := newFakePanelService()
	svc.usePanels(panels)
	svc.Configure(true)

	res, err := notchTestSpawn(svc, panels)(map[string]any{"url": "http://localhost:3143/api/notch/spike"})
	if err != nil {
		t.Fatalf("notch.spawn: %v", err)
	}
	if got := res.Result.(map[string]any); got["spawned"] != true || got["already"] != false {
		t.Fatalf("unexpected reply: %v", got)
	}
	spec, ok := panels.spawned[notchPanelID]
	if !ok || len(panels.spawned) != 1 {
		t.Fatalf("expected exactly the notch panel, got %v", panels.spawned)
	}
	if !spec.Notch || !spec.Frameless || !spec.AlwaysOnTop {
		t.Fatalf("the notch panel must be frameless, always on top and marked as the notch: %+v", spec)
	}
	if !strings.HasPrefix(spec.URL, "http://localhost:3143/api/notch/spike?") || !strings.Contains(spec.URL, "token=tok") {
		t.Fatalf("the page must be on the brain's origin and signed in, got %q", spec.URL)
	}
}

// Only the brain's own origin renders in the notch, like any panel. This
// fails if the URL is passed to Spawn without sanitizePanelURL.
func TestNotchSpawnRefusesAPageThatIsNotTheBrains(t *testing.T) {
	svc := &NotchService{}
	panels := newFakePanelService()
	svc.usePanels(panels)
	svc.Configure(true)
	for _, url := range []string{"http://evil.example/notch", "file:///C:/x.html", ""} {
		if _, err := notchTestSpawn(svc, panels)(map[string]any{"url": url}); err == nil {
			t.Errorf("%q: expected notch.spawn to be refused", url)
		}
	}
	if len(panels.spawned) != 0 {
		t.Fatalf("a refused spawn opened a window: %v", panels.spawned)
	}
}

// The switch comes first: with it off there is no window, whatever is asked.
func TestNotchSpawnIsRefusedWhileTheSwitchIsOff(t *testing.T) {
	svc := &NotchService{}
	panels := newFakePanelService()
	svc.usePanels(panels)
	if _, err := notchTestSpawn(svc, panels)(map[string]any{"url": "http://localhost:3143/api/notch/spike"}); err == nil {
		t.Fatal("notch.spawn succeeded with the switch off")
	}
	if len(panels.spawned) != 0 {
		t.Fatalf("a window opened with the switch off: %v", panels.spawned)
	}
}

func TestNotchSpawnTwiceIsStillOneWindow(t *testing.T) {
	svc := &NotchService{}
	panels := newFakePanelService()
	svc.usePanels(panels)
	svc.Configure(true)
	spawn := notchTestSpawn(svc, panels)
	if _, err := spawn(map[string]any{"url": "http://localhost:3143/api/notch/spike"}); err != nil {
		t.Fatal(err)
	}
	panels.spawnErr = formatPanelError("spawn", notchPanelID, ErrPanelExists)
	res, err := spawn(map[string]any{"url": "http://localhost:3143/api/notch/spike"})
	if err != nil {
		t.Fatalf("a second notch.spawn must not be an error: %v", err)
	}
	if got := res.Result.(map[string]any); got["already"] != true {
		t.Fatalf("the second spawn should say the window was already there: %v", got)
	}
}

// Turning the switch off, by request or by losing the connection, takes the
// window away. Without this a brain that came back with the notch off would
// leave the old window on the screen.
func TestTurningTheNotchOffClosesItsWindow(t *testing.T) {
	for name, off := range map[string]func(*NotchService){
		"configure false": func(s *NotchService) { s.Configure(false) },
		"disconnect":      func(s *NotchService) { s.Reset("disconnect") },
	} {
		svc := &NotchService{}
		panels := newFakePanelService()
		svc.usePanels(panels)
		svc.Configure(true)
		if _, err := notchTestSpawn(svc, panels)(map[string]any{"url": "http://localhost:3143/api/notch/spike"}); err != nil {
			t.Fatalf("%s: spawn: %v", name, err)
		}
		off(svc)
		if len(panels.closed) != 1 || panels.closed[0] != notchPanelID {
			t.Errorf("%s: the window was not closed: closed=%v", name, panels.closed)
		}
	}
}

func TestNotchConfigureNamesTheSurfaceItCanShow(t *testing.T) {
	with := &NotchService{}
	with.usePanels(newFakePanelService())
	res, err := makeNotchConfigureHandler(with)(map[string]any{"enabled": true})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Result.(map[string]any)["surface"]; got != notchSurfaceWindow {
		t.Fatalf("with panels the surface is %v, want %q", got, notchSurfaceWindow)
	}
	without := &NotchService{}
	res, err = makeNotchConfigureHandler(without)(map[string]any{"enabled": true})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Result.(map[string]any)["surface"]; got != notchSurfaceNone {
		t.Fatalf("without panels the surface is %v, want %q", got, notchSurfaceNone)
	}
}

func TestNotchWindowHandlersNeedTheWindowsCapability(t *testing.T) {
	cfg := defaultConfig()
	panels := newFakePanelService()
	token := func(context.Context) (string, error) { return "tok", nil }
	with := NewHandlerRegistry(&cfg, nil, []SidecarCapability{CapNotch, CapWindows}, panels, nil, nil, nil, nil, nil, "ws://localhost:3143/sidecar/connect", token)
	for _, method := range []string{"notch.configure", "notch.spawn", "notch.close"} {
		if _, ok := with[method]; !ok {
			t.Errorf("%s is missing although the notch and windows capabilities are available", method)
		}
	}
	without := NewHandlerRegistry(&cfg, nil, []SidecarCapability{CapNotch}, nil, nil, nil, nil, nil, nil, "", nil)
	if _, ok := without["notch.spawn"]; ok {
		t.Error("notch.spawn is registered without the windows capability")
	}
	if _, ok := without["notch.configure"]; !ok {
		t.Error("notch.configure must still be understood without windows")
	}
	notch.usePanels(nil)
	notch.Configure(false)
}

// A screen capture covers the screen and is in front, like a fullscreen app.
// It must not count as one, or the notch vanishes from under the capture.
func TestNotchLeavesItselfAloneUnderAScreenCapture(t *testing.T) {
	// "SnippingTool" is the name as the desktop app's log gave it on Windows 11.
	for _, program := range []string{"SnippingTool", "SnippingTool.exe", "snippingtool.exe", "ScreenClippingHost"} {
		if !notchIsCaptureOverlay(program) {
			t.Errorf("%s is a screen capture tool", program)
		}
	}
	for _, program := range []string{"chrome.exe", "vlc.exe", ""} {
		if notchIsCaptureOverlay(program) {
			t.Errorf("%q is not a screen capture tool", program)
		}
	}
}
