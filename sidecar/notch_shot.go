package main

// "Where is...?" on a window that says nothing about itself.
//
// notch.window reads what a program tells of its own buttons, and the pointer
// goes to one of those. That works where a program does tell: OBS, Notepad, a
// file window. It does not on a page in a browser, in the many apps built on
// a browser, in a game, in a remote desktop: there the program tells of
// nothing, or only of its frame. The owner, 16 November 2026, with Instagram
// open in Chrome: "it told me on the notch, but it should have pointed to it.
// [...] It should work everywhere."
//
// So the window can also be shown: notch.shot gives a picture of the window
// the person is in, with a ruler on it. Numbers from 0 to 100 run along its
// top and down its left side, with a faint line at every ten. A model that
// looks at the picture says where a thing is in the ruler's numbers, and the
// brain turns them back into the screen's own pixels: it knows which part of
// the screen the picture shows, because this file tells it. So a picture made
// smaller is still exact to the screen, whatever the display's scale.
//
// A part of the window can be asked for as well, close up: the brain asks for
// the place a model named, and has the model find the thing's edges there,
// where every pixel of the screen is at least one pixel of the picture.
//
// Where this program looks away (a password, a bank, an app on the never
// list) no picture is made, as nothing is read there.

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"

	"golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
)

const (
	// The longest side of a picture of a whole window, in pixels. Larger and
	// a model is slower and reads no better; smaller and small words blur.
	notchShotMost = 1568
	// A close-up narrower than this is drawn at twice its size, so that what
	// is small on the screen is not small in the picture.
	notchShotCloseDouble = 720
	// The least a close-up may be, in the screen's pixels.
	notchShotCloseLeast = 48
	// The heaviest picture that is sent. A window full of photographs makes a
	// heavy one; past this it is made again at half the size.
	notchShotHeavy = 3_000_000
	// The bands the ruler's numbers stand in, above and to the left.
	notchShotBandTop  = 18
	notchShotBandLeft = 30
)

// platformNotchFront gives the window the person is in: where it is on the
// screen, and what program and window it is. Set by the platform files.
var platformNotchFront func() (rect lookRect, app, title string, err error)

// shotClip is the part of a rectangle that lies inside another.
func shotClip(r, in lookRect) lookRect {
	x0, y0 := max(r.X, in.X), max(r.Y, in.Y)
	x1, y1 := min(r.X+r.W, in.X+in.W), min(r.Y+r.H, in.Y+in.H)
	if x1 <= x0 || y1 <= y0 {
		return lookRect{}
	}
	return lookRect{x0, y0, x1 - x0, y1 - y0}
}

// shotPart reads which part of the window is asked for. With no part named
// it is the whole window. A part is kept inside the window: nothing outside
// the window the person is in is ever shown.
func shotPart(params map[string]any, window lookRect) (part lookRect, close bool, err error) {
	number := func(key string) (int, bool) {
		v, ok := params[key].(float64)
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 1e6 {
			return 0, false
		}
		return int(math.Round(v)), true
	}
	x, hasX := number("x")
	y, hasY := number("y")
	w, hasW := number("w")
	h, hasH := number("h")
	if !hasX && !hasY && !hasW && !hasH {
		return window, false, nil
	}
	if !hasX || !hasY || !hasW || !hasH || w < notchShotCloseLeast || h < notchShotCloseLeast {
		return lookRect{}, false, fmt.Errorf("a part of the window needs x, y, w and h, and to be at least %d pixels each way", notchShotCloseLeast)
	}
	part = shotClip(lookRect{x, y, w, h}, window)
	if part.W < notchShotCloseLeast/2 || part.H < notchShotCloseLeast/2 {
		return lookRect{}, false, fmt.Errorf("that part is not in the window the person is in")
	}
	return part, true, nil
}

// shotRuler draws a picture with its ruler: a band above and a band to the
// left with the numbers 0 to 100, and a faint dotted line across the picture
// at every ten. The picture itself is not made smaller or larger here, and
// nothing of it is covered but those lines, which leave every other pixel
// alone so that a word under one can still be read.
func shotRuler(src image.Image) *image.RGBA {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	out := image.NewRGBA(image.Rect(0, 0, w+notchShotBandLeft, h+notchShotBandTop))
	draw.Draw(out, out.Bounds(), image.NewUniform(color.RGBA{255, 255, 255, 255}), image.Point{}, draw.Src)
	draw.Draw(out, image.Rect(notchShotBandLeft, notchShotBandTop, notchShotBandLeft+w, notchShotBandTop+h), src, b.Min, draw.Src)
	// A line is two colours by turns, so that it shows on a light window and on a dark one.
	dark, light := color.RGBA{200, 0, 160, 255}, color.RGBA{255, 190, 240, 255}
	dot := func(x, y, along int) {
		switch along % 4 {
		case 0:
			out.SetRGBA(x, y, dark)
		case 2:
			out.SetRGBA(x, y, light)
		}
	}
	face := basicfont.Face7x13
	text := func(s string, x, y int) {
		d := font.Drawer{Dst: out, Src: image.NewUniform(color.RGBA{0, 0, 0, 255}), Face: face, Dot: fixed.P(x, y)}
		d.DrawString(s)
	}
	for ten := 0; ten <= 10; ten++ {
		label := fmt.Sprintf("%d", ten*10)
		// Down the picture at this many tenths across.
		x := notchShotBandLeft + int(math.Round(float64(ten)/10*float64(w-1)))
		if ten > 0 && ten < 10 {
			for y := 0; y < h; y++ {
				dot(x, notchShotBandTop+y, y)
			}
		}
		for y := notchShotBandTop - 4; y < notchShotBandTop; y++ {
			out.SetRGBA(x, y, color.RGBA{0, 0, 0, 255})
		}
		lx := x - len(label)*7/2
		lx = max(notchShotBandLeft-6, min(lx, notchShotBandLeft+w-len(label)*7))
		text(label, lx, 12)
		// Across the picture at this many tenths down.
		y := notchShotBandTop + int(math.Round(float64(ten)/10*float64(h-1)))
		if ten > 0 && ten < 10 {
			for x := 0; x < w; x++ {
				dot(notchShotBandLeft+x, y, x)
			}
		}
		for x := notchShotBandLeft - 4; x < notchShotBandLeft; x++ {
			out.SetRGBA(x, y, color.RGBA{0, 0, 0, 255})
		}
		ly := max(notchShotBandTop+10, min(y+4, notchShotBandTop+h-2))
		text(label, notchShotBandLeft-5-len(label)*7, ly)
	}
	return out
}

// shotPicture makes the picture that is sent: the cut of the screen as a PNG,
// made twice as large when it is a narrow close-up, with its ruler.
func shotPicture(cut []byte, double bool) ([]byte, error) {
	src, err := png.Decode(bytes.NewReader(cut))
	if err != nil {
		return nil, fmt.Errorf("the copy of the screen could not be read: %w", err)
	}
	if b := src.Bounds(); double && b.Dx() < notchShotCloseDouble && b.Dx() > 0 && b.Dy() > 0 {
		large := image.NewRGBA(image.Rect(0, 0, b.Dx()*2, b.Dy()*2))
		draw.CatmullRom.Scale(large, large.Bounds(), src, b, draw.Src, nil)
		src = large
	}
	var out bytes.Buffer
	if err := png.Encode(&out, shotRuler(src)); err != nil {
		return nil, fmt.Errorf("the picture could not be made: %w", err)
	}
	return out.Bytes(), nil
}

// makeNotchShotHandler serves notch.shot: a picture of the window the person
// is in, or of a part of it, with a ruler. It answers which part of the
// screen the picture shows, in the screen's own pixels, and the picture
// travels beside the answer.
func makeNotchShotHandler() RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		hands := notchActHands()
		if hands == nil || platformNotchFront == nil {
			return nil, fmt.Errorf("notch.shot: %w", notchLookMissing())
		}
		window, app, title, err := platformNotchFront()
		if err != nil {
			return nil, fmt.Errorf("notch.shot: %w", err)
		}
		app = notchAppKey(app)
		// Decided before anything is copied (notch_where.go).
		if away := notchLookAway(app, title); away != "" {
			return &RPCResult{Result: map[string]any{"away": away}}, nil
		}
		// Only what is on the display the window is on: a window that is as
		// large as its display reaches a little past its edges.
		screen, _ := hands.Screen(lookPoint{window.X + window.W/2, window.Y + window.H/2})
		window = shotClip(window, screen)
		if window.empty() {
			return nil, fmt.Errorf("notch.shot: the window the person is in is not on a display")
		}
		part, close, err := shotPart(params, window)
		if err != nil {
			return nil, fmt.Errorf("notch.shot: %w", err)
		}
		shot := hands.Snapshot(part)
		if shot == nil {
			return nil, fmt.Errorf("notch.shot: the screen could not be copied")
		}
		var picture []byte
		// A whole window is made smaller to a side a model reads well; a
		// close-up is as it is on the screen, and twice that when it is
		// narrow. Too heavy either way, and it is made again smaller.
		for _, most := range []int{notchShotMost, notchShotMost / 2} {
			var cut []byte
			if close && most == notchShotMost {
				cut = shot.Cut(part)
			} else {
				cut = shot.CutSmall(part, most)
			}
			if len(cut) == 0 {
				return nil, fmt.Errorf("notch.shot: the screen could not be copied")
			}
			if picture, err = shotPicture(cut, close && most == notchShotMost); err != nil {
				return nil, fmt.Errorf("notch.shot: %w", err)
			}
			if len(picture) <= notchShotHeavy {
				break
			}
		}
		// Sizes, never what is in it.
		return &RPCResult{
			Result:     map[string]any{"x": part.X, "y": part.Y, "w": part.W, "h": part.H, "app": app, "close": close},
			BinaryRaw:  picture,
			BinaryMime: "image/png",
		}, nil
	}
}
