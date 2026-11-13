package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"sync"
	"sync/atomic"
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

// The window is as large as the notch can ever grow, in logical pixels: the
// widest line is 700 across with a flared shoulder each side, and the tallest
// sheet is 600 down with room for the lower edge to swing. The page draws the
// notch inside it and reports the outline; the rest of the window is cut away.
const (
	notchWindowW = 800
	notchWindowH = 680
)

// An outline is a few closed polygons in window pixels: the notch's body, and
// any small shapes on the screen's top edge beside it.
const (
	notchOutlineMaxPolygons = 16
	notchOutlineMinPoints   = 3
	// Over all the polygons of one outline.
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

// notchOutline checks one polygon of an outline against the window it is for.
func notchOutline(points [][]float64, winW, winH int) ([]notchVertex, error) {
	if len(points) < notchOutlineMinPoints {
		return nil, fmt.Errorf("a polygon needs at least %d points, got %d", notchOutlineMinPoints, len(points))
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

// notchOutlines checks an outline the page reported against the window it is
// for. A page is not trusted to cut the window to any shape it likes: too many
// polygons, too few or too many points, or a point far outside the window, and
// the outline is refused whole and the previous shape stays.
//
// Every polygon comes back turning the same way. The shapes are joined as one
// silhouette wherever they overlap, and that only works when none of them
// cancels another.
func notchOutlines(polygons [][][]float64, winW, winH int) ([][]notchVertex, error) {
	if len(polygons) > notchOutlineMaxPolygons {
		return nil, fmt.Errorf("an outline may have at most %d polygons, got %d", notchOutlineMaxPolygons, len(polygons))
	}
	total := 0
	out := make([][]notchVertex, 0, len(polygons))
	for i, points := range polygons {
		total += len(points)
		if total > notchOutlineMaxPoints {
			return nil, fmt.Errorf("an outline may have at most %d points", notchOutlineMaxPoints)
		}
		polygon, err := notchOutline(points, winW, winH)
		if err != nil {
			return nil, fmt.Errorf("polygon %d: %w", i, err)
		}
		if notchSignedArea(polygon) < 0 {
			for a, b := 0, len(polygon)-1; a < b; a, b = a+1, b-1 {
				polygon[a], polygon[b] = polygon[b], polygon[a]
			}
		}
		out = append(out, polygon)
	}
	return out, nil
}

// notchSignedArea is positive for a polygon that turns clockwise on a screen,
// where y grows downwards.
func notchSignedArea(polygon []notchVertex) float64 {
	sum := 0.0
	for i, a := range polygon {
		b := polygon[(i+1)%len(polygon)]
		sum += a.X*b.Y - b.X*a.Y
	}
	return sum / 2
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

// notchShouldHide is the whole fullscreen rule: the notch hides for a
// fullscreen video and for nothing else. All three must hold: a fullscreen app
// is in front, something is keeping the display awake (every player does while
// it plays, so without it there is no need to look further), and the picture
// is seen to be moving by itself (notch_video.go). A browser in fullscreen
// that is only being read keeps the notch.
//
// And never while it is asking something: a question that waits for a yes or a
// no (an approval, a question back) on a notch that cannot be seen is a task
// that stands still until it times out. So the notch comes back for the
// question, over the video, and goes again once it is answered.
func notchShouldHide(fullscreenAppInFront, displayKeptAwake, videoPlaying, asking bool) bool {
	return fullscreenAppInFront && displayKeptAwake && videoPlaying && !asking
}

// bindNotch gives the page its calls, opens the line between the page and the
// brain, and starts feeding the page the pointer's position. The calls run on the window's own thread, like every other panel
// binding. The function it returns stops the feed and releases what the
// platform set up; the panel calls it on the window's thread once the window's
// loop has ended and before the web view is destroyed.
func bindNotch(wv webview.WebView, handle unsafe.Pointer) (stop func()) {
	// Everything sent into the page is queued for the window's own thread, and
	// a queue can still hold something when the window is on its way out. On
	// Windows what is left in it runs while the web view is being taken apart,
	// after its engine is gone: a script run then is a crash that nothing here
	// can catch. So every queued call looks at this first, and stop sets it
	// before anything else.
	var stopped atomic.Bool
	inPage := func(script string) {
		wv.Dispatch(func() {
			if stopped.Load() {
				return
			}
			wv.Eval(script)
		})
	}
	bind := func(name string, fn any) {
		if err := wv.Bind(name, fn); err != nil {
			log.Printf("[notch] Bind(%s) failed: %v", name, err)
		}
	}
	// __notch_set_outline(shapes, cuts): two lists of closed polygons in device
	// pixels of the window, fractions allowed. shapes is the notch's true
	// silhouette: its body, and any small shapes beside it. cuts is the same a
	// little way in: where a platform draws the edge with a second window, the
	// web view ends there. A platform that masks the web view itself uses
	// shapes. cuts may hold fewer polygons, or none: a shape thinner than the
	// way in has no inside. No shapes at all means nothing is on screen: the
	// notch before it is born, or between two ways of appearing.
	bind("__notch_set_outline", func(shapes, cuts [][][]float64) error {
		w, h := platformNotchWindowSize(handle)
		outer, err := notchOutlines(shapes, w, h)
		if err != nil {
			log.Printf("[notch] outline refused: %v", err)
			return err
		}
		inner, err := notchOutlines(cuts, w, h)
		if err != nil {
			log.Printf("[notch] inner outline refused: %v", err)
			return err
		}
		whole := make([][]notchPoint, len(inner))
		for i, polygon := range inner {
			whole[i] = notchWhole(polygon)
		}
		return platformNotchSetOutline(handle, outer, whole)
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

	// __notch_send(text) sends the brain one message, as JSON text. Messages
	// the other way arrive as the argument of window.__notch_receive.
	bind("__notch_send", func(text string) error {
		return notch.fromPage(text)
	})
	// __notch_esc(want): whether Esc would do anything on the notch right now.
	// Only then is it taken from the app in front.
	bind("__notch_esc", func(want bool) {
		notch.wantEsc(want)
	})
	// __notch_asking(asking): whether the notch is showing something that
	// waits for the person's yes or no. While it is, it does not hide for a
	// fullscreen video (notchShouldHide).
	bind("__notch_asking", func(asking bool) {
		platformNotchAsking(handle, asking)
	})
	// __notch_keys(): the two pairs of keys on this machine, for the hints.
	bind("__notch_keys", func() map[string][]string {
		pairs := notch.KeyPairs()
		return map[string][]string{
			"talk": {notchModName(pairs.Talk[0]), notchModName(pairs.Talk[1])},
			"yes":  {notchModName(pairs.Yes[0]), notchModName(pairs.Yes[1])},
		}
	})
	notch.attachPage(inPage)
	notch.watchKeys()

	// The page only hears the mouse inside its own outline, so the pointer's
	// position and its main button everywhere else have to be told to it.
	// That is what lets the eyes follow the cursor across the whole screen,
	// and a click in the app underneath close a sheet.
	quit := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(33 * time.Millisecond)
		defer ticker.Stop()
		lastX, lastY, lastDown, sent := 0, 0, false, false
		for {
			select {
			case <-quit:
				return
			case <-ticker.C:
			}
			x, y, down, ok := platformNotchCursor(handle)
			if !ok || (sent && x == lastX && y == lastY && down == lastDown) {
				continue
			}
			lastX, lastY, lastDown, sent = x, y, down, true
			inPage(notchCursorScript(x, y, down))
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			stopped.Store(true)
			notch.detachPage()
			close(quit)
			<-finished
			platformNotchTearDown(handle)
		})
	}
}

// notchCursorScript is what the page is told: the pointer's place in the
// page's own pixels, from the window's top left corner, and whether the main
// mouse button is down. The button is how the page hears a click that landed
// outside its outline, in the app underneath: a click away from a sheet.
func notchCursorScript(x, y int, down bool) string {
	pressed := 0
	if down {
		pressed = 1
	}
	return fmt.Sprintf("window.__notch_cursor&&window.__notch_cursor(%d,%d,%d);", x, y, pressed)
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
