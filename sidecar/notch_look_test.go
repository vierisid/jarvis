package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/png"
	"math"
	"reflect"
	"strings"
	"testing"
)

// A circle drawn by hand: not round, not closed, and begun anywhere.
func lookRing(cx, cy, rx, ry float64, n int) []lookPoint {
	points := make([]lookPoint, 0, n)
	for i := 0; i < n; i++ {
		t := -2.4 + float64(i)/float64(n)*math.Pi*2.05
		points = append(points, lookPoint{
			int(math.Round(cx + rx*math.Cos(t)*(1+0.06*math.Sin(t*3)))),
			int(math.Round(cy + ry*math.Sin(t))),
		})
	}
	return points
}

func TestLookPenTakesThePressOnlyWhileTheTalkPairIsHeld(t *testing.T) {
	var pen notchLookPen
	// Not held: the press is the app's, and so is its letting go.
	if v := pen.Down(10, 10); v.Swallow || v.Begin {
		t.Fatalf("a press without the keys was taken: %+v", v)
	}
	if v := pen.Up(10, 10); v.Swallow || v.Taken != nil {
		t.Fatalf("a letting go without the keys was taken: %+v", v)
	}
	pen.Arm(true)
	if v := pen.Down(10, 10); !v.Swallow || !v.Begin {
		t.Fatalf("a press with the keys held was not taken: %+v", v)
	}
	// Moving is never kept from anything, and a move too small adds nothing.
	if v := pen.Move(11, 10); v.Swallow || v.Extend {
		t.Fatalf("a move of one pixel: %+v", v)
	}
	if v := pen.Move(40, 30); v.Swallow || !v.Extend {
		t.Fatalf("a real move: %+v", v)
	}
	v := pen.Up(60, 10)
	if !v.Swallow || !reflect.DeepEqual(v.Taken, []lookPoint{{10, 10}, {40, 30}, {60, 10}}) {
		t.Fatalf("letting go did not finish the line: %+v", v)
	}
	if pen.Busy() {
		t.Fatal("the pen is still busy after the line was taken")
	}
}

func TestLookPenFinishesALineWhenTheKeysComeUpFirst(t *testing.T) {
	var pen notchLookPen
	pen.Arm(true)
	pen.Down(0, 0)
	pen.Move(50, 0)
	// The hand on the keys is faster than the hand that draws.
	pen.Arm(false)
	pen.Move(50, 50)
	v := pen.Up(0, 50)
	if !v.Swallow || len(v.Taken) != 4 {
		t.Fatalf("the line was not finished: %+v", v)
	}
	// And the next press, with no keys, is the app's again.
	if v := pen.Down(5, 5); v.Swallow {
		t.Fatal("a press after the keys came up was taken")
	}
}

func TestLookPenEscThrowsTheLineAwayAndStillKeepsTheLettingGo(t *testing.T) {
	var pen notchLookPen
	pen.Arm(true)
	// Esc with no line is not the pen's.
	if v := pen.Esc(); v.Swallow || v.Dropped {
		t.Fatalf("Esc with nothing drawn: %+v", v)
	}
	pen.Down(0, 0)
	pen.Move(30, 30)
	if v := pen.Esc(); !v.Swallow || !v.Dropped {
		t.Fatalf("Esc did not drop the line: %+v", v)
	}
	// Nothing more is drawn, and the button coming up reaches no app: it never saw it go down.
	if v := pen.Move(60, 60); v.Extend {
		t.Fatal("a dropped line grew")
	}
	if v := pen.Up(60, 60); !v.Swallow || v.Taken != nil {
		t.Fatalf("the letting go after Esc: %+v", v)
	}
	// A second Esc is not the pen's.
	if v := pen.Esc(); v.Swallow {
		t.Fatal("a second Esc was taken")
	}
}

func TestLookPenKeepsALongLineFromGrowingWithoutEnd(t *testing.T) {
	var pen notchLookPen
	pen.Arm(true)
	pen.Down(0, 0)
	for i := 1; i < 3*notchLookMaxPoints; i++ {
		pen.Move(i*notchLookStepPx, (i%7)*notchLookStepPx)
	}
	v := pen.Up(1, 1)
	if len(v.Taken) > notchLookMaxPoints+1 {
		t.Fatalf("%d points were kept", len(v.Taken))
	}
	if v.Taken[0] != (lookPoint{0, 0}) || v.Taken[len(v.Taken)-1] != (lookPoint{1, 1}) {
		t.Fatal("the line lost its first or last point")
	}
}

func TestLookPenResetDropsWhatWasBeingDrawn(t *testing.T) {
	var pen notchLookPen
	pen.Arm(true)
	pen.Down(0, 0)
	if !pen.Reset() {
		t.Fatal("a reset during a line did not say it was dropped")
	}
	if pen.Armed() || pen.Busy() {
		t.Fatal("the pen kept something after a reset")
	}
	if pen.Reset() {
		t.Fatal("a reset with nothing drawn said a line was dropped")
	}
}

func TestLookClickAndBounds(t *testing.T) {
	if !lookIsClick([]lookPoint{{100, 100}, {103, 102}}) {
		t.Fatal("a press that hardly moved is a click")
	}
	if lookIsClick([]lookPoint{{100, 100}, {100, 110}}) {
		t.Fatal("a stroke ten pixels long is not a click")
	}
	if got := lookBounds([]lookPoint{{5, 9}, {-3, 4}, {20, 6}}); got != (lookRect{-3, 4, 23, 5}) {
		t.Fatalf("bounds: %+v", got)
	}
}

func TestLookInsideAClosedLineThatWasNotClosedByHand(t *testing.T) {
	ring := lookRing(500, 300, 200, 80, 40)
	if !lookInside(ring, 500, 300) {
		t.Fatal("the middle of the circle is not inside it")
	}
	for _, p := range [][2]float64{{250, 300}, {760, 300}, {500, 150}, {500, 420}} {
		if lookInside(ring, p[0], p[1]) {
			t.Fatalf("%v is outside the circle", p)
		}
	}
	if lookInside([]lookPoint{{0, 0}, {10, 10}}, 5, 5) {
		t.Fatal("two points hold nothing")
	}
}

// The owner's rule for the prototype (11 November 2026): a circle is drawn
// fast and sloppy. Round the left end of three rows it means those rows.
func TestLookCoversRowsCircledAtOneEndAndNotTheRowItsEdgeRunsThrough(t *testing.T) {
	// Rows 24 high and 900 wide, from y = 200. The circle is round the left
	// 300 pixels of rows 1, 2 and 3, and its top edge runs into row 0.
	row := func(i int) lookRect { return lookRect{100, 200 + 24*i, 900, 24} }
	ring := lookRing(250, 200+24*2+12, 150, 44, 48)
	for i := 1; i <= 3; i++ {
		if !lookCovers(ring, row(i)) {
			t.Fatalf("row %d is inside the circle and was not held", i)
		}
	}
	for _, i := range []int{0, 4, 5} {
		if lookCovers(ring, row(i)) {
			t.Fatalf("row %d is not meant and was held", i)
		}
	}
	// A small thing wholly inside is held; one beside the circle is not.
	if !lookCovers(ring, lookRect{240, 250, 10, 10}) {
		t.Fatal("a small thing inside was not held")
	}
	if lookCovers(ring, lookRect{600, 250, 40, 20}) {
		t.Fatal("a thing beside the circle was held")
	}
	// A tall thing circled across its middle from top to bottom is held by its other axis.
	if !lookCovers(lookRing(300, 400, 30, 200, 48), lookRect{100, 380, 400, 40}) {
		t.Fatal("a wide thing crossed by a tall circle was not held")
	}
	if lookCovers(ring, lookRect{}) {
		t.Fatal("nothing was held")
	}
}

func TestLookSamplePointsAreInsideTheLineAndFew(t *testing.T) {
	ring := lookRing(500, 300, 200, 80, 40)
	points := lookSamplePoints(ring, notchLookSamples)
	if len(points) < 9 || len(points) > notchLookSamples {
		t.Fatalf("%d places", len(points))
	}
	for _, p := range points {
		if !lookInside(ring, float64(p.X), float64(p.Y)) {
			t.Fatalf("%+v is not inside the circle", p)
		}
	}
	// A stroke under a word has no inside: the places are along the stroke.
	under := []lookPoint{{100, 500}, {150, 501}, {200, 500}, {260, 502}}
	along := lookSamplePoints(under, notchLookSamples)
	if len(along) == 0 {
		t.Fatal("a stroke gave no places")
	}
	for _, p := range along {
		if p.Y < 500 || p.Y > 502 || p.X < 100 || p.X > 260 {
			t.Fatalf("%+v is not on the stroke", p)
		}
	}
	if lookSamplePoints(nil, 10) != nil {
		t.Fatal("no line gave places")
	}
}

func TestLookKindIsWhatAPersonWouldCallIt(t *testing.T) {
	wide, square := lookRect{0, 0, 600, 22}, lookRect{0, 0, 90, 80}
	for _, c := range []struct {
		role, local string
		r           lookRect
		want        string
	}{
		{"ListItem", "", wide, "row"},
		{"ListItem", "", square, "item"},
		{"DataItem", "", lookRect{0, 0, 80, 20}, "cell"},
		{"DataItem", "", lookRect{0, 0, 900, 20}, "row"},
		{"Custom", "row", wide, "row"},
		{"DataItem", "Cell", wide, "cell"},
		{"Hyperlink", "", wide, "link"},
		{"Text", "link", wide, "link"},
		{"Button", "", square, "button"},
		{"Edit", "", wide, "field"},
		{"Image", "", square, "picture"},
		{"Pane", "", square, "thing"},
	} {
		if got := lookKindOf(c.role, c.local, c.r); got != c.want {
			t.Errorf("%s (%q): %q, want %q", c.role, c.local, got, c.want)
		}
	}
}

func TestLookRowOfAWordIsAboutAsTallAsTheWord(t *testing.T) {
	word := lookRect{300, 400, 180, 18}
	if !lookRowOf(lookRect{100, 396, 1200, 26}, word) {
		t.Fatal("the row a word is in was not taken for its row")
	}
	// A tile of a grid of icons, with its name under the picture.
	if !lookRowOf(lookRect{280, 330, 96, 92}, lookRect{284, 400, 88, 16}) {
		t.Fatal("a tile was not taken for the thing its name is in")
	}
	// A whole section of a page that calls itself a list item.
	if lookRowOf(lookRect{100, 200, 1200, 700}, word) {
		t.Fatal("a section of a page was taken for a row")
	}
	// The climb goes through a group, and stops at the place the things are in.
	if lookEdgeRoles["Group"] || lookEdgeRoles["Custom"] || !lookEdgeRoles["List"] || !lookEdgeRoles["Window"] {
		t.Fatal("where the climb stops")
	}
}

func TestLookCleanMakesATextFitToCarry(t *testing.T) {
	if got := lookClean("  Acme\tLtd \n overdue\x00 "); got != "Acme Ltd overdue" {
		t.Fatalf("%q", got)
	}
	long := lookClean(strings.Repeat("é", 500))
	if n := len([]rune(long)); n != notchLookTextRunes {
		t.Fatalf("%d runes", n)
	}
}

func TestLookGatherMakesRowsOfTheCellsOfARow(t *testing.T) {
	cell := func(x, y int, text string) lookThing {
		return lookThing{Kind: "cell", Role: "DataItem", Name: "A1", Value: text, Rect: lookRect{x, y, 100, 20}}
	}
	// Given out of order, as the screen gives them.
	rows := lookGather([]lookThing{
		cell(200, 140, "430.50"), cell(100, 100, "Acme"), cell(200, 100, "120"),
		cell(100, 120, "Lumen"), cell(200, 120, "740.50"), cell(100, 140, "Northwind"),
	})
	if len(rows) != 3 {
		t.Fatalf("%d rows", len(rows))
	}
	want := [][]string{{"Acme", "120"}, {"Lumen", "740.50"}, {"Northwind", "430.50"}}
	for i, row := range rows {
		if row.Kind != "row" || !reflect.DeepEqual(row.Parts, want[i]) {
			t.Fatalf("row %d: %+v", i, row)
		}
	}
	if rows[0].Rect != (lookRect{100, 100, 200, 20}) {
		t.Fatalf("the row's place: %+v", rows[0].Rect)
	}
	if got := lookTag(rows); got != "3 rows" {
		t.Fatalf("tag %q", got)
	}
	// One cell to a line is a column of cells, not rows.
	column := lookGather([]lookThing{cell(100, 100, "1"), cell(100, 120, "2")})
	if len(column) != 2 || column[0].Kind != "cell" {
		t.Fatalf("a column was gathered: %+v", column)
	}
	// Things that are not cells are left alone, in reading order.
	mixed := lookGather([]lookThing{
		{Kind: "button", Name: "Send", Rect: lookRect{300, 100, 60, 24}},
		{Kind: "field", Name: "To", Rect: lookRect{100, 100, 180, 24}},
	})
	if mixed[0].Name != "To" || mixed[1].Name != "Send" {
		t.Fatalf("reading order: %+v", mixed)
	}
}

func TestLookTagNamesOneThingAndCountsSeveral(t *testing.T) {
	if got := lookTag(nil); got != "" {
		t.Fatalf("nothing: %q", got)
	}
	if got := lookTag([]lookThing{{Kind: "row", Name: "Budget.xlsx"}}); got != "Budget.xlsx" {
		t.Fatalf("%q", got)
	}
	if got := lookTag([]lookThing{{Kind: "button"}}); got != "a button" {
		t.Fatalf("%q", got)
	}
	if got := lookTag([]lookThing{{Kind: "row", Parts: []string{"Acme", "120"}}}); got != "Acme · 120" {
		t.Fatalf("%q", got)
	}
	if got := lookTag([]lookThing{{Kind: "text", Name: strings.Repeat("a", 90)}}); len([]rune(got)) != 48 {
		t.Fatalf("a long name was not cut: %d", len([]rune(got)))
	}
	if got := lookTag([]lookThing{{Kind: "row"}, {Kind: "row"}, {Kind: "row"}}); got != "3 rows" {
		t.Fatalf("%q", got)
	}
	if got := lookTag([]lookThing{{Kind: "row"}, {Kind: "button"}}); got != "2 things" {
		t.Fatalf("%q", got)
	}
}

func TestLookBodyCarriesTheWordsBesideThePictures(t *testing.T) {
	picture := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	window := []byte{0x89, 'P', 'N', 'G', 9, 9}
	body, err := notchLookBody(notchLookTold{App: "excel", Title: "Payouts", Around: []string{"Payouts by customer"},
		Things: []lookThing{{Kind: "row", Name: "Acme", Parts: []string{"Acme", "120"}, Rect: lookRect{1, 2, 3, 4}}}}, picture, window)
	if err != nil {
		t.Fatal(err)
	}
	n := int(binary.BigEndian.Uint32(body))
	var told map[string]any
	if err := json.Unmarshal(body[4:4+n], &told); err != nil {
		t.Fatal(err)
	}
	if told["app"] != "excel" || told["title"] != "Payouts" || told["around"].([]any)[0] != "Payouts by customer" {
		t.Fatalf("%v", told)
	}
	thing := told["things"].([]any)[0].(map[string]any)
	// Where a thing is on the screen is not part of what is said about it.
	if _, has := thing["rect"]; has || thing["kind"] != "row" || thing["name"] != "Acme" {
		t.Fatalf("%v", thing)
	}
	// The words say where the first picture ends, and the second follows it.
	if told["picture_bytes"] != float64(len(picture)) {
		t.Fatalf("picture_bytes: %v", told["picture_bytes"])
	}
	if !reflect.DeepEqual(body[4+n:4+n+len(picture)], picture) || !reflect.DeepEqual(body[4+n+len(picture):], window) {
		t.Fatal("the pictures did not follow the words in their order")
	}
	// Nothing read is still a list, not null, and no picture is none.
	empty, _ := notchLookBody(notchLookTold{}, nil, nil)
	if got := string(empty[4:]); got != `{"things":[],"picture_bytes":0}` {
		t.Fatalf("%s", got)
	}
}

func TestLookAroundNamesAreKeptOnceEachWithoutTheThingAndTheTitle(t *testing.T) {
	got := lookAroundNames([]string{"1,284", "Installs", "", "Installs", " Telemetry  overview ", "Telemetry - Grafana", strings.Repeat("x", 200), "a", "b", "c"}, "1,284", "Telemetry - Grafana")
	want := []string{"Installs", "Telemetry overview", strings.Repeat("x", 79) + "…", "a", "b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%q", got)
	}
	if lookAroundNames(nil, "", "") != nil {
		t.Fatal("no names gave names")
	}
}

func TestLookWindowPictureOnlyWhenItSaysMoreThanTheCloseOne(t *testing.T) {
	close := lookRect{400, 400, 300, 240}
	if !lookWindowWorthIt(lookRect{0, 0, 1800, 1000}, close) {
		t.Fatal("a window far larger than the close picture was left out")
	}
	if lookWindowWorthIt(lookRect{380, 380, 340, 280}, close) {
		t.Fatal("a window hardly larger than the close picture was added")
	}
	if lookWindowWorthIt(lookRect{}, close) {
		t.Fatal("no window was a window")
	}
	if !lookWindowWorthIt(lookRect{0, 0, 800, 600}, lookRect{}) {
		t.Fatal("with no close picture the window is all there is")
	}
	// The window is cut to the display it is shown on.
	if got := lookWithin(lookRect{-200, -8, 2200, 1100}, lookRect{0, 0, 1920, 1080}); got != (lookRect{0, 0, 1920, 1080}) {
		t.Fatalf("%+v", got)
	}
	if !lookWithin(lookRect{3000, 0, 100, 100}, lookRect{0, 0, 1920, 1080}).empty() {
		t.Fatal("a window on another display was kept")
	}
}

func TestLookPayloadHasNoWordsInIt(t *testing.T) {
	payload := notchLookPayload("taken", "L1", lookHowLoop, "", 3, lookRect{10, 20, 300, 80}, lookRect{0, 0, 420, 240})
	if payload["phase"] != "taken" || payload["look_id"] != "L1" || payload["how"] != "loop" || payload["things"] != 3 {
		t.Fatalf("%v", payload)
	}
	if _, has := payload["refused"]; has {
		t.Fatal("a look that was made says it was refused")
	}
	for key := range payload {
		switch key {
		case "phase", "look_id", "how", "things", "rect", "picture":
		default:
			t.Fatalf("the payload carries %q", key)
		}
	}
	// Nothing was looked at: why, and nothing about what was there.
	refused := notchLookPayload("taken", "L2", lookHowClick, "password", 0, lookRect{5, 5, 0, 0}, lookRect{})
	if refused["refused"] != "password" || len(refused) != 4 {
		t.Fatalf("%v", refused)
	}
	// No picture was taken: none is spoken of.
	if _, has := notchLookPayload("taken", "L3", lookHowClick, "", 1, lookRect{5, 5, 0, 0}, lookRect{})["picture"]; has {
		t.Fatal("a picture that was not taken is in the payload")
	}
}

func TestLookPictureIsWhatWasCircledWithRoomAndInsideTheScreen(t *testing.T) {
	screen := lookRect{0, 0, 1920, 1080}
	// Room round a row.
	if got := lookPictureRect(lookRect{400, 500, 600, 24}, screen); got != (lookRect{340, 392, 720, 240}) {
		t.Fatalf("%+v", got)
	}
	// A click near the corner stays on the screen.
	got := lookPictureRect(lookRect{1900, 5, 0, 0}, screen)
	if got.X+got.W > 1920 || got.Y < 0 || got.W != 240 || got.H != 240 {
		t.Fatalf("%+v", got)
	}
	// A circle round the whole screen is not a picture larger than a model reads.
	if got := lookPictureRect(lookRect{0, 0, 1920, 1080}, lookRect{0, 0, 3840, 2160}); got.W > 1600 || got.H > 1600 {
		t.Fatalf("%+v", got)
	}
	// A second screen to the left of the first has places below zero.
	left := lookPictureRect(lookRect{-1900, 100, 50, 20}, lookRect{-1920, 0, 3840, 1080})
	if left.X < -1920 || left.X+left.W > 1920 {
		t.Fatalf("%+v", left)
	}
}

func TestInkIsOneStrengthWhereTheLineCrossesItself(t *testing.T) {
	ink := newNotchInk(200, 120)
	touched := ink.stroke(20, 60.5, 180, 60.5, 6)
	if touched.X > 14 || touched.Y > 54 || touched.X+touched.W < 186 || touched.Y+touched.H < 66 {
		t.Fatalf("touched %+v", touched)
	}
	// Across it, through the same pixels.
	ink.stroke(100, 10, 100, 110, 6)
	middle, arm, outside := ink.cover[60*200+100], ink.cover[60*200+40], ink.cover[20*200+40]
	if middle != 255 || arm != 255 || outside != 0 {
		t.Fatalf("crossing %d, arm %d, outside %d", middle, arm, outside)
	}
	// The edge is soft: a pixel half way out of the marker is neither full nor clear.
	edge := ink.cover[(60+6)*200+40]
	if edge == 0 || edge == 255 {
		t.Fatalf("edge %d", edge)
	}
	// A piece that misses the sheet touches nothing and breaks nothing.
	if !ink.stroke(-500, -500, -400, -400, 6).empty() {
		t.Fatal("a piece off the sheet touched it")
	}
}

func TestInkPaintsOnlyTheRectangleAskedForInTheMarkersColour(t *testing.T) {
	ink := newNotchInk(64, 64)
	ink.stroke(10, 32, 54, 32, 5)
	pixels := make([]uint32, 64*64)
	ink.paint(pixels, lookRect{0, 0, 32, 64})
	full := pixels[32*64+20]
	a, r, g, b := full>>24, full>>16&0xff, full>>8&0xff, full&0xff
	if a < 150 || a > 166 {
		t.Fatalf("strength %d", a)
	}
	// Multiplied by its own strength, as a layered window wants it: no channel above the strength.
	if r > a || g > a || b > a || g < r || r < b {
		t.Fatalf("colour %d %d %d under %d", r, g, b, a)
	}
	if pixels[32*64+40] != 0 {
		t.Fatal("a pixel outside the rectangle was painted")
	}
	if pixels[5*64+20] != 0 {
		t.Fatal("a pixel the marker never touched has colour")
	}
	ink.clear()
	ink.paint(pixels, lookRect{0, 0, 64, 64})
	if pixels[32*64+20] != 0 {
		t.Fatal("the sheet was not wiped")
	}
}

func TestTagPlateIsSolidInsideAndClearAtItsCorners(t *testing.T) {
	const w, h = 120, 28
	pixels := make([]uint32, w*h)
	notchTagPill(pixels, w, h, 8)
	if pixels[14*w+60] != notchTagFill {
		t.Fatalf("the middle is %08x", pixels[14*w+60])
	}
	if pixels[0] != 0 || pixels[w-1] != 0 || pixels[(h-1)*w] != 0 {
		t.Fatal("a corner is not clear")
	}
	if a := pixels[2*w+2] >> 24; a == 0 || a == 255 {
		t.Fatalf("the corner's curve is hard: %d", a)
	}
}

func TestTagIsPlacedAboveWhatWasCircledAndStaysOnTheScreen(t *testing.T) {
	screen := lookRect{0, 0, 1920, 1080}
	if x, y := notchTagPlace(lookRect{400, 300, 500, 80}, 160, 28, screen, 8); x != 400 || y != 264 {
		t.Fatalf("%d, %d", x, y)
	}
	// No room above: under it.
	if _, y := notchTagPlace(lookRect{400, 10, 500, 80}, 160, 28, screen, 8); y != 98 {
		t.Fatalf("y %d", y)
	}
	// At the right edge it moves in.
	if x, _ := notchTagPlace(lookRect{1850, 300, 60, 80}, 160, 28, screen, 8); x != 1760 {
		t.Fatalf("x %d", x)
	}
	// On a screen to the left of the first.
	if x, y := notchTagPlace(lookRect{-1800, 300, 100, 40}, 160, 28, lookRect{-1920, 0, 1920, 1080}, 8); x != -1800 || y != 264 {
		t.Fatalf("%d, %d", x, y)
	}
}

func TestLookShotCutsAPartOfTheScreenAsAPicture(t *testing.T) {
	// A display of 8 by 4 whose corner is at (-8, 0): one to the left of the first.
	shot := &lookShot{pixels: make([]byte, 8*4*4), w: 8, h: 4, x: -8, y: 0}
	for i := 0; i < 8*4; i++ {
		// Blue, green, red: the pixel at column 5 of row 2 is pure red.
		if i == 2*8+5 {
			shot.pixels[i*4+2] = 0xFF
		}
	}
	file := shot.Cut(lookRect{-4, 1, 3, 2})
	img, err := png.Decode(bytes.NewReader(file))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 3 || img.Bounds().Dy() != 2 {
		t.Fatalf("%v", img.Bounds())
	}
	if r, g, b, a := img.At(1, 1).RGBA(); r != 0xFFFF || g != 0 || b != 0 || a != 0xFFFF {
		t.Fatalf("the red pixel came out as %x %x %x %x", r, g, b, a)
	}
	// What lies outside the display is left out, and nothing left is no picture.
	if edge, _ := png.Decode(bytes.NewReader(shot.Cut(lookRect{-2, 2, 50, 50}))); edge.Bounds().Dx() != 2 || edge.Bounds().Dy() != 2 {
		t.Fatalf("%v", edge.Bounds())
	}
	if shot.Cut(lookRect{100, 100, 10, 10}) != nil {
		t.Fatal("a part off the display gave a picture")
	}
	var none *lookShot
	if none.Cut(lookRect{0, 0, 1, 1}) != nil {
		t.Fatal("no copy gave a picture")
	}
}

func TestRingPathGoesRoundTheThingALittleOutsideIt(t *testing.T) {
	r := lookRect{100, 200, 80, 24}
	path := lookRingPath(r, 6, 10)
	if len(path) < 16 {
		t.Fatalf("%d points", len(path))
	}
	b := lookBounds(path)
	if b != (lookRect{94, 194, 92, 36}) {
		t.Fatalf("bounds %+v", b)
	}
	// Closed, it holds the thing whole: every corner of it is inside.
	for _, corner := range [][2]float64{{101, 201}, {179, 201}, {101, 223}, {179, 223}, {140, 212}} {
		if !lookInside(path, corner[0], corner[1]) {
			t.Fatalf("%v is not inside the ring", corner)
		}
	}
	// No point is on the thing itself.
	for _, p := range path {
		if r.holds(p.X, p.Y) {
			t.Fatalf("%+v is on the thing", p)
		}
	}
	// A thing smaller than the corners would be: the ring is still a ring.
	small := lookRingPath(lookRect{10, 10, 2, 2}, 4, 30)
	if sb := lookBounds(small); sb.W != 10 || sb.H != 10 || len(small) < 8 {
		t.Fatalf("%+v, %d points", sb, len(small))
	}
}

func TestLookShotMakesALargePartSmaller(t *testing.T) {
	const w, h = 400, 200
	shot := &lookShot{pixels: make([]byte, w*h*4), w: w, h: h, x: 100, y: 50}
	// Left half red, right half blue, as Windows keeps them: blue, green, red.
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := (y*w + x) * 4
			if x < w/2 {
				shot.pixels[i+2] = 255
			} else {
				shot.pixels[i] = 255
			}
		}
	}
	decode := func(data []byte) image.Image {
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		return img
	}
	small := decode(shot.CutSmall(lookRect{100, 50, 400, 200}, 100))
	if b := small.Bounds(); b.Dx() != 100 || b.Dy() != 50 {
		t.Fatalf("%v", b)
	}
	if r, _, bl, _ := small.At(10, 10).RGBA(); r>>8 != 255 || bl>>8 != 0 {
		t.Fatal("the left is not red")
	}
	if r, _, bl, _ := small.At(90, 40).RGBA(); r>>8 != 0 || bl>>8 != 255 {
		t.Fatal("the right is not blue")
	}
	// Small enough already: as it is.
	if b := decode(shot.CutSmall(lookRect{100, 50, 80, 40}, 100)).Bounds(); b.Dx() != 80 || b.Dy() != 40 {
		t.Fatalf("%v", b)
	}
	// A longest side that does not divide evenly is never made larger than asked.
	if b := decode(shot.CutSmall(lookRect{100, 50, 399, 200}, 150)).Bounds(); b.Dx() > 150 || b.Dy() > 150 {
		t.Fatalf("%v", b)
	}
}

// The owner's first "put it there", 16 November 2026: he circled five numbers
// on a dashboard in a browser, and what was put was the name of the browser's
// window. A browser says nothing about what is on its page, so all there was
// at that place was the page.
func TestAThingTheCircleWasDrawnInsideIsNotWhatWasCircled(t *testing.T) {
	// A circle about 300 wide and 120 high, drawn at (400, 300).
	circle := []lookPoint{{400, 300}, {550, 290}, {700, 300}, {705, 360}, {700, 420}, {550, 425}, {400, 420}, {395, 360}}
	// The page it was drawn on.
	if !lookOver(circle, lookRect{0, 80, 2560, 1300}) {
		t.Fatal("a page many times the size of the circle was taken for what was circled")
	}
	// A tile of the dashboard that holds the circle and more.
	if !lookOver(circle, lookRect{350, 150, 500, 420}) {
		t.Fatal("a tile the circle was drawn inside was taken for what was circled")
	}
	// What a circle does hold: a number inside it, a thing about its own size.
	for _, held := range []lookRect{{450, 330, 120, 40}, {390, 285, 320, 150}} {
		if lookOver(circle, held) {
			t.Fatalf("%+v is inside the circle and was called larger than it", held)
		}
	}
	// Rows that run on past a circle drawn round their left end are what was meant.
	for row := 0; row < 4; row++ {
		if lookOver(circle, lookRect{380, 300 + row*30, 1400, 30}) {
			t.Fatalf("row %d runs on past the circle and was not taken as circled", row)
		}
	}
	// A click has no inside: the thing clicked is the thing.
	if lookOver([]lookPoint{{400, 300}, {401, 301}}, lookRect{0, 80, 2560, 1300}) {
		t.Fatal("a click was treated as a circle")
	}
}
