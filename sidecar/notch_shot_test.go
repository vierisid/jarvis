package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func shotTestPNG(t *testing.T, w, h int, fill color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = fill.R, fill.G, fill.B, 255
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// shotHands copies the screen as the real hands do: the copy knows which
// part of the screen it is.
type shotHands struct{ *fakeHands }

func (h shotHands) Snapshot(screen lookRect) lookSnapshot {
	h.note("snapshot")
	return &lookShot{pixels: make([]byte, screen.W*screen.H*4), w: screen.W, h: screen.H, x: screen.X, y: screen.Y}
}

func TestOnlyTheWindowThePersonIsInIsEverShown(t *testing.T) {
	window := lookRect{100, 50, 1200, 800}
	// Nothing named: the whole window.
	part, close, err := shotPart(map[string]any{}, window)
	if err != nil || close || part != window {
		t.Fatalf("the whole window: %+v, %v, %v", part, close, err)
	}
	// A part of it, close up.
	part, close, err = shotPart(map[string]any{"x": float64(300), "y": float64(200), "w": float64(400), "h": float64(300)}, window)
	if err != nil || !close || part != (lookRect{300, 200, 400, 300}) {
		t.Fatalf("a part: %+v, %v, %v", part, close, err)
	}
	// A part that reaches past the window is cut to it.
	part, _, err = shotPart(map[string]any{"x": float64(0), "y": float64(0), "w": float64(400), "h": float64(300)}, window)
	if err != nil || part != (lookRect{100, 50, 300, 250}) {
		t.Fatalf("a part over the edge: %+v, %v", part, err)
	}
	// One that is not in the window at all is refused: another window is nobody's to show.
	for _, params := range []map[string]any{
		{"x": float64(2000), "y": float64(2000), "w": float64(400), "h": float64(300)},
		{"x": float64(300), "y": float64(200), "w": float64(10), "h": float64(300)},
		{"x": float64(300), "y": float64(200)},
		{"w": float64(400), "h": float64(300)},
	} {
		if _, _, err := shotPart(params, window); err == nil {
			t.Errorf("%v was taken", params)
		}
	}
	if got := shotClip(lookRect{-8, -8, 2576, 1456}, lookRect{0, 0, 2560, 1440}); got != (lookRect{0, 0, 2560, 1440}) {
		t.Fatalf("a window as large as its display: %+v", got)
	}
}

// The numbers a model reads off the ruler are turned back into the screen's
// pixels by the brain, so the ruler must be where it says it is: 0 at the
// picture's first pixel, 100 at its last, a line at every ten between.
func TestTheRulerIsWhereItSaysItIs(t *testing.T) {
	const w, h = 801, 401
	src := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(src.Pix); i += 4 {
		src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3] = 40, 40, 40, 255
	}
	out := shotRuler(src)
	if got := out.Bounds(); got.Dx() != w+notchShotBandLeft || got.Dy() != h+notchShotBandTop {
		t.Fatalf("the picture with its ruler is %v", got)
	}
	grey := color.RGBA{40, 40, 40, 255}
	at := func(x, y int) color.RGBA { return out.RGBAAt(notchShotBandLeft+x, notchShotBandTop+y) }
	// A line down the picture at every ten across: at 80, 160, ... of 800.
	for ten := 1; ten <= 9; ten++ {
		x := ten * 80
		marked := 0
		for y := 0; y < h; y++ {
			if at(x, y) != grey {
				marked++
			}
		}
		// Dotted: half of it is drawn, and half is left for what is under it.
		if marked < h/3 || marked > h*2/3 {
			t.Fatalf("the line at %d across marks %d of %d pixels", ten*10, marked, h)
		}
		// Nothing beside it is touched.
		if at(x+3, 7) != grey || at(x-3, 7) != grey {
			t.Fatalf("the line at %d across is wider than a pixel", ten*10)
		}
	}
	for ten := 1; ten <= 9; ten++ {
		y := ten * 40
		marked := 0
		for x := 0; x < w; x++ {
			if at(x, y) != grey {
				marked++
			}
		}
		if marked < w/3 || marked > w*2/3 {
			t.Fatalf("the line at %d down marks %d of %d pixels", ten*10, marked, w)
		}
	}
	// The edges of the picture are 0 and 100, and no line is drawn over them.
	for _, y := range []int{0, h - 1} {
		for x := 5; x < w; x += 80 {
			if x%80 != 0 && at(x, y) != grey {
				t.Fatalf("the edge at y=%d is drawn over", y)
			}
		}
	}
	// The numbers stand in the bands, in black on white, and nowhere in the picture.
	ink := 0
	for y := 0; y < notchShotBandTop; y++ {
		for x := 0; x < out.Bounds().Dx(); x++ {
			if out.RGBAAt(x, y) == (color.RGBA{0, 0, 0, 255}) {
				ink++
			}
		}
	}
	if ink < 200 {
		t.Fatalf("the band above the picture has %d pixels of numbers", ink)
	}
}

func TestACloseUpOfSomethingSmallIsDrawnLarger(t *testing.T) {
	read := func(data []byte) image.Rectangle {
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		return img.Bounds()
	}
	// A close-up 400 wide: at twice its size, so one pixel of the screen is two of the picture.
	small, err := shotPicture(shotTestPNG(t, 400, 300, color.RGBA{250, 250, 250, 255}), true)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(small); got.Dx() != 800+notchShotBandLeft || got.Dy() != 600+notchShotBandTop {
		t.Fatalf("a small close-up: %v", got)
	}
	// A wide close-up, and a whole window, as they are.
	for _, close := range []bool{true, false} {
		wide, err := shotPicture(shotTestPNG(t, 900, 500, color.RGBA{250, 250, 250, 255}), close)
		if err != nil {
			t.Fatal(err)
		}
		if got := read(wide); got.Dx() != 900+notchShotBandLeft || got.Dy() != 500+notchShotBandTop {
			t.Fatalf("close=%v: %v", close, got)
		}
	}
	if _, err := shotPicture([]byte("not a picture"), false); err == nil {
		t.Fatal("something that is no picture was drawn a ruler on")
	}
}

func TestAPictureOfTheWindowSaysWhichPartOfTheScreenItShows(t *testing.T) {
	hands := shotHands{&fakeHands{}}
	prevHands, prevFront := notchLookHands, platformNotchFront
	defer func() { notchLookHands, platformNotchFront = prevHands, prevFront }()
	notchLookHands = hands
	// A window as large as its display reaches eight pixels past every edge.
	platformNotchFront = func() (lookRect, string, string, error) {
		return lookRect{-8, -8, 1936, 1096}, "chrome.exe", "A page", nil
	}
	handler := makeNotchShotHandler()
	whole, err := handler(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	told := whole.Result.(map[string]any)
	// Cut to the display it is on, and said in the screen's own pixels.
	if told["x"] != 0 || told["y"] != 0 || told["w"] != 1920 || told["h"] != 1080 || told["close"] != false || told["app"] != "chrome" {
		t.Fatalf("the whole window: %v", told)
	}
	if whole.BinaryMime != "image/png" || len(whole.BinaryRaw) == 0 {
		t.Fatal("no picture travels beside the answer")
	}
	img, err := png.Decode(bytes.NewReader(whole.BinaryRaw))
	if err != nil {
		t.Fatal(err)
	}
	// Made exactly as small as asked: its longest side is notchShotMost, with
	// the ruler's bands round it. (It used to be made smaller by a whole
	// number only: a display 1920 wide was halved to 960, and small writing
	// was read at half its size.)
	if got := img.Bounds(); got.Dx() != notchShotMost+notchShotBandLeft || got.Dy() != 1080*notchShotMost/1920+notchShotBandTop {
		t.Fatalf("the picture is %v", got)
	}
	part, err := handler(map[string]any{"x": float64(600), "y": float64(300), "w": float64(480), "h": float64(320)})
	if err != nil {
		t.Fatal(err)
	}
	told = part.Result.(map[string]any)
	if told["x"] != 600 || told["y"] != 300 || told["w"] != 480 || told["h"] != 320 || told["close"] != true {
		t.Fatalf("a part: %v", told)
	}
	// With no window of another program there is nothing to show.
	platformNotchFront = func() (lookRect, string, string, error) {
		return lookRect{}, "", "", errNotchLookNotHere
	}
	if _, err := handler(map[string]any{}); err == nil || !strings.Contains(err.Error(), "notch.shot") {
		t.Fatalf("no window: %v", err)
	}
}

// Where this program looks away it copies nothing, as it reads nothing.
func TestNoPictureIsMadeWhereItLooksAway(t *testing.T) {
	hands := shotHands{&fakeHands{}}
	prevHands, prevFront := notchLookHands, platformNotchFront
	defer func() { notchLookHands, platformNotchFront = prevHands, prevFront }()
	notchLookHands = hands
	platformNotchFront = func() (lookRect, string, string, error) {
		return lookRect{0, 0, 1200, 800}, "chrome.exe", "A page", nil
	}
	screenObserversPaused.Store(true)
	defer screenObserversPaused.Store(false)
	got, err := makeNotchShotHandler()(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if told := got.Result.(map[string]any); told["away"] != "off" || len(got.BinaryRaw) != 0 {
		t.Fatalf("with watching off: %v, %d bytes of picture", told, len(got.BinaryRaw))
	}
	if hands.has("snapshot") {
		t.Fatal("the screen was copied all the same")
	}
}
