package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"time"
	"unsafe"

	webview "github.com/webview/webview_go"
)

// The notch's window.
//
// It is one panel (panels_runtime.go) with four differences from every other
// panel, all behind PanelSpec.Notch:
//
//   - It sits at the top centre of the main display and never moves.
//   - Its shape is the outline the page reports, so everything outside the
//     drawn notch belongs to the app underneath, clicks included.
//   - It appears without taking the keyboard, and takes it only when the page
//     asks (a text field in a sheet), then hands it back.
//   - It hides while a fullscreen video plays, and only then.
//
// The page is served by the brain and signed in the same way a panel is.

const notchPanelID PanelID = "notch"

// The window is as large as the notch can ever grow, in logical pixels. The
// page draws the notch inside it and reports the outline; the rest of the
// window is cut away.
const (
	notchWindowW = 760
	notchWindowH = 600
)

// An outline is a closed polygon in window pixels.
const (
	notchOutlineMinPoints = 3
	notchOutlineMaxPoints = 720
	// The page may run a little past the window edge (the top corners sit
	// above the screen), never far.
	notchOutlineSlack = 64
)

// notchVertex is a point of an outline as the page reports it. Fractions of a
// pixel are kept: a curve whose points are moved onto whole pixels turns into
// short straight runs, and reads as a polygon however softly its edge is drawn.
type notchVertex struct {
	X, Y float64
}

// notchPoint is a point on whole pixels, which is all a window region can be
// cut along. It has the layout of a Win32 POINT.
type notchPoint struct {
	X, Y int32
}

// notchOutline checks an outline the page reported against the window it is
// for. A page is not trusted to cut the window to any shape it likes: too few
// points, too many, or a point far outside the window is refused whole, and the
// previous shape stays.
func notchOutline(points [][]float64, winW, winH int) ([]notchVertex, error) {
	if len(points) < notchOutlineMinPoints {
		return nil, fmt.Errorf("an outline needs at least %d points, got %d", notchOutlineMinPoints, len(points))
	}
	if len(points) > notchOutlineMaxPoints {
		return nil, fmt.Errorf("an outline may have at most %d points, got %d", notchOutlineMaxPoints, len(points))
	}
	out := make([]notchVertex, 0, len(points))
	for i, p := range points {
		if len(p) != 2 {
			return nil, fmt.Errorf("outline point %d is not [x, y]", i)
		}
		x, y := p[0], p[1]
		// Written so that a value that is not a number fails it too: every
		// comparison with one is false.
		inside := x >= -notchOutlineSlack && x <= float64(winW)+notchOutlineSlack &&
			y >= -notchOutlineSlack && y <= float64(winH)+notchOutlineSlack
		if !inside {
			return nil, fmt.Errorf("outline point %d (%g, %g) is outside the %dx%d window", i, x, y, winW, winH)
		}
		out = append(out, notchVertex{X: x, Y: y})
	}
	return out, nil
}

// notchWhole moves an outline onto whole pixels, for the one use that needs
// them: cutting a window region.
func notchWhole(outline []notchVertex) []notchPoint {
	out := make([]notchPoint, len(outline))
	for i, v := range outline {
		out[i] = notchPoint{X: int32(math.Round(v.X)), Y: int32(math.Round(v.Y))}
	}
	return out
}

// notchTopCentre is the left edge that centres a window of width winW on a
// display of width screenW.
func notchTopCentre(screenW, winW int) int {
	if winW >= screenW {
		return 0
	}
	return (screenW - winW) / 2
}

// notchShouldHide is the whole fullscreen rule: the notch hides when a
// fullscreen app is in front AND something is keeping the display awake, which
// is what a playing video does. A browser in fullscreen that is only being
// read does not hold the display, so the notch stays.
func notchShouldHide(fullscreenAppInFront, displayKeptAwake bool) bool {
	return fullscreenAppInFront && displayKeptAwake
}

// notchIsCaptureOverlay reports whether the program in front is a screen
// capture tool choosing its area. While it does, it covers the whole screen
// and is in front, which is exactly what a fullscreen app looks like, and the
// notch would vanish from under the capture. The names are Windows' own tools.
func notchIsCaptureOverlay(program string) bool {
	switch strings.ToLower(program) {
	case "snippingtool.exe", "screenclippinghost.exe":
		return true
	}
	return false
}

// bindNotch gives the page its three calls and starts feeding it the pointer's
// position. The calls run on the window's own thread, like every other panel
// binding. The function it returns stops the feed and releases what the
// platform set up; the panel calls it on the window's thread once the window's
// loop has ended and before the web view is destroyed.
func bindNotch(wv webview.WebView, handle unsafe.Pointer) (stop func()) {
	bind := func(name string, fn any) {
		if err := wv.Bind(name, fn); err != nil {
			log.Printf("[notch] Bind(%s) failed: %v", name, err)
		}
	}
	// __notch_set_outline(shape, cut): two closed polygons in device pixels of
	// the window, fractions allowed. shape is the notch's true outline. cut is
	// the same outline a little way in: where a platform draws the edge with a
	// second window, the web view ends there. A platform that masks the web
	// view itself uses shape.
	bind("__notch_set_outline", func(shape, cut [][]float64) error {
		w, h := platformNotchWindowSize(handle)
		outer, err := notchOutline(shape, w, h)
		if err != nil {
			log.Printf("[notch] outline refused: %v", err)
			return err
		}
		inner, err := notchOutline(cut, w, h)
		if err != nil {
			log.Printf("[notch] inner outline refused: %v", err)
			return err
		}
		return platformNotchSetOutline(handle, outer, notchWhole(inner))
	})
	// __notch_focus(true) takes the keyboard for a text field,
	// __notch_focus(false) gives it back to whoever had it.
	bind("__notch_focus", func(take bool) bool {
		return platformNotchFocus(handle, take)
	})
	// __notch_log(text) writes one line to sidecar.log, so a test run leaves
	// what the page measured where it can be read afterwards.
	bind("__notch_log", func(text string) {
		if len(text) > 400 {
			text = text[:400]
		}
		log.Printf("[notch/page] %s", text)
	})

	// The page only hears the mouse inside its own outline, so the pointer's
	// position everywhere else has to be told to it. That is what lets the
	// eyes follow the cursor across the whole screen.
	quit := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(33 * time.Millisecond)
		defer ticker.Stop()
		lastX, lastY, sent := 0, 0, false
		for {
			select {
			case <-quit:
				return
			case <-ticker.C:
			}
			x, y, ok := platformNotchCursor(handle)
			if !ok || (sent && x == lastX && y == lastY) {
				continue
			}
			lastX, lastY, sent = x, y, true
			js := notchCursorScript(x, y)
			wv.Dispatch(func() { wv.Eval(js) })
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(quit)
			<-finished
			platformNotchTearDown(handle)
		})
	}
}

// notchCursorScript is what the page is told: the pointer's place in the
// page's own pixels, from the window's top left corner.
func notchCursorScript(x, y int) string {
	return fmt.Sprintf("window.__notch_cursor&&window.__notch_cursor(%d,%d);", x, y)
}

// notch.spawn - open the notch on the page the brain names.
//
//	Params: { "url": string }   a page on the brain's own origin
//	Result: { "spawned": true, "already": bool }
func makeNotchSpawnHandler(svc *NotchService, panels PanelService, brainURL string, panelToken func(context.Context) (string, error)) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		if !svc.Enabled() {
			return nil, fmt.Errorf("the notch is off: notch.configure {enabled: true} comes first")
		}
		rawURL, _ := params["url"].(string)
		if rawURL == "" {
			return nil, fmt.Errorf("missing required parameter: url")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		accessToken, err := panelToken(ctx)
		if err != nil {
			return nil, fmt.Errorf("notch auth token: %w", err)
		}
		// The same rule as any panel: only the brain's own origin renders.
		safeURL, err := sanitizePanelURL(rawURL, brainURL, accessToken)
		if err != nil {
			return nil, err
		}
		_, err = panels.Spawn(PanelSpec{
			ID:          notchPanelID,
			URL:         safeURL,
			Title:       "Jarvis",
			Bounds:      PanelBounds{X: -1, Y: -1, W: notchWindowW, H: notchWindowH},
			Frameless:   true,
			AlwaysOnTop: true,
			Notch:       true,
		})
		already := errors.Is(err, ErrPanelExists)
		if err != nil && !already {
			return nil, err
		}
		if !already {
			log.Printf("[notch] window opened")
		}
		return &RPCResult{Result: map[string]any{"spawned": true, "already": already}}, nil
	}
}

// notch.close - take the notch off the screen. The switch stays as it is.
func makeNotchCloseHandler(svc *NotchService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return &RPCResult{Result: map[string]any{"closed": svc.closeSurface()}}, nil
	}
}
