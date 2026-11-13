package main

// Acting at a place on the screen instead of on an element.
//
// Every other desktop action names an element from a read of the window.
// Many windows have none to name: a game, Steam's own pages, a canvas, a
// video player. There was no way to click, scroll or drag in them at all.
//
// The place arrives as two fractions of the main display (0 at its left or
// top edge, 1 at its right or bottom edge), not as pixels: the agent reads a
// place off a picture of the screen, and that picture is often smaller than
// the screen. The brain turns the picture's pixels into fractions; this side
// turns fractions into the display's own pixels.
//
// This file is the reading of a request and the arithmetic. It has no
// platform calls in it, so it is tested on every platform.

import (
	"fmt"
	"math"
)

// desktopPointerRefusedCode marks a pointer action refused before anything was
// done: a request that cannot be read, a place on one of Jarvis's own windows,
// a system this is not built for. The daemon may report it as not started
// (NOT_STARTED_RPC_CODES in src/actions/tools/sidecar-route.ts).
const desktopPointerRefusedCode = "DESKTOP_POINTER_REFUSED"

type pointerRequest struct {
	Action     string
	FX, FY     float64
	ToFX, ToFY float64 // drag: where it ends
	Amount     int     // scroll: how many notches of the wheel
}

// pointerScrollMax is the most one call scrolls. A notch is about three lines.
const pointerScrollMax = 30

func pointerFraction(params map[string]any, key string) (float64, error) {
	raw, ok := params[key].(float64)
	if !ok {
		return 0, fmt.Errorf("missing required parameter: %s", key)
	}
	if math.IsNaN(raw) || raw < 0 || raw > 1 {
		return 0, fmt.Errorf("%s must be between 0 and 1 (a fraction of the main display), got %v", key, raw)
	}
	return raw, nil
}

// parsePointerRequest reads a request, or says what is wrong with it. Nothing
// has been done when it fails.
func parsePointerRequest(params map[string]any) (pointerRequest, error) {
	req := pointerRequest{Action: "click", Amount: 3}
	if action, ok := params["action"].(string); ok && action != "" {
		req.Action = action
	}
	switch req.Action {
	case "click", "double_click", "right_click", "scroll_up", "scroll_down", "drag":
	default:
		return req, fmt.Errorf("unsupported action: %s (supported: click, double_click, right_click, scroll_up, scroll_down, drag)", req.Action)
	}
	var err error
	if req.FX, err = pointerFraction(params, "fx"); err != nil {
		return req, err
	}
	if req.FY, err = pointerFraction(params, "fy"); err != nil {
		return req, err
	}
	if req.Action == "drag" {
		if req.ToFX, err = pointerFraction(params, "to_fx"); err != nil {
			return req, err
		}
		if req.ToFY, err = pointerFraction(params, "to_fy"); err != nil {
			return req, err
		}
	}
	if amount, ok := params["amount"].(float64); ok {
		if math.IsNaN(amount) || amount < 1 || amount > pointerScrollMax || amount != math.Trunc(amount) {
			return req, fmt.Errorf("amount must be a whole number from 1 to %d, got %v", pointerScrollMax, amount)
		}
		req.Amount = int(amount)
	}
	return req, nil
}

// pointerPixel is the pixel a fraction of a display means: always one that is
// on the display, so 1 is the last pixel and not the one after it.
func pointerPixel(fraction float64, size int) int {
	if size <= 0 {
		return 0
	}
	pixel := int(math.Floor(fraction * float64(size)))
	if pixel < 0 {
		return 0
	}
	if pixel > size-1 {
		return size - 1
	}
	return pixel
}

// pointerDragSteps is the path of a drag: every place the pointer is put on
// its way, ending exactly where it was told to. An app follows a drag by the
// moves in between; one jump from start to end is often not seen as a drag.
func pointerDragSteps(x, y, toX, toY int) [][2]int {
	const steps = 12
	path := make([][2]int, 0, steps)
	for i := 1; i <= steps; i++ {
		path = append(path, [2]int{
			x + int(math.Round(float64(toX-x)*float64(i)/steps)),
			y + int(math.Round(float64(toY-y)*float64(i)/steps)),
		})
	}
	return path
}

// pointerOnOwnWindow is the refusal for a place that is on a window of Jarvis
// itself. Its windows ask the person things; the agent must never be the one
// who answers them.
func pointerOnOwnWindow(x, y int) string {
	return fmt.Sprintf("the place (%d, %d) is on one of Jarvis's own windows, so nothing was done. "+
		"Jarvis does not click, scroll or drag in its own windows", x, y)
}
