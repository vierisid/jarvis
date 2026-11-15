package main

// Looking at a thing on the screen.
//
// While the talk pair is held, the pointer is Jarvis's:
//
//   - press and draw: a line of ink follows the pointer, around what is meant;
//   - press and let go in one place: the one thing under the pointer;
//   - Esc while drawing: the line is thrown away and nothing happens.
//
// No press made this way reaches the app in front: the press and the letting
// go are both kept from it. Moving the pointer is never kept from anything.
//
// When the line is finished, what is inside it is read from the app's own
// description of itself (its elements: what each is, what it is called, where
// it is), a picture of the place is taken, and the brain is told once, with
// the event `notch.look`. While the line is drawn a tag beside it names what
// it holds so far.
//
// Nothing is read where this program is looking away (notch_where.go): a
// password field, a bank, an app on the person's list. The press is still
// kept from the app, and the brain is told that nothing was looked at.
//
// This file has no platform calls in it: the pen, the geometry, what counts
// as inside a line, what a thing is called. It is tested on every platform.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf8"
)

// notchLookEvent is the event that says what was looked at.
const notchLookEvent = "notch.look"

const (
	// A line that stays inside this many pixels each way is a click.
	notchLookClickPx = 6
	// A move shorter than this adds no point to the line.
	notchLookStepPx = 3
	// A line has at most this many points. Past it every other one is dropped.
	notchLookMaxPoints = 2400
	// How many places inside a line are asked "what is here".
	notchLookSamples = 24
	// The most things one look carries, the most texts inside one of them, and
	// how long a text may be.
	notchLookMaxThings = 60
	notchLookMaxParts  = 12
	notchLookTextRunes = 200
	// The most children of one container that are gone through.
	notchLookMaxSiblings = 400
)

// How a look was made.
const (
	lookHowClick = "click"
	lookHowLoop  = "loop"
	lookHowKeys  = "keys"
)

type lookPoint struct{ X, Y int }

type lookRect struct{ X, Y, W, H int }

func (r lookRect) empty() bool { return r.W <= 0 || r.H <= 0 }

func (r lookRect) holds(x, y int) bool {
	return x >= r.X && y >= r.Y && x < r.X+r.W && y < r.Y+r.H
}

// lookThing is one thing on the screen as its app describes it.
type lookThing struct {
	// What kind of thing a person would call it: "row", "cell", "button",
	// "link", "field", "text", "picture", "tab", "item", "thing".
	Kind string `json:"kind"`
	// What the system calls it ("ListItem").
	Role  string `json:"role,omitempty"`
	Name  string `json:"name,omitempty"`
	Value string `json:"value,omitempty"`
	// The texts inside it in reading order: the cells of a row.
	Parts []string `json:"parts,omitempty"`
	Rect  lookRect `json:"-"`
}

// ---------------------------------------------------------------------------
// The pen
// ---------------------------------------------------------------------------

type lookPhase uint8

const (
	lookIdle lookPhase = iota
	// The button is down and a line is being drawn.
	lookDrawing
	// The line was thrown away with the button still down: nothing more is
	// drawn, and the letting go is still kept from the app.
	lookDead
)

// notchLookPen turns what the pointer did into a line. It decides what is
// kept from the app in front, and nothing else.
type notchLookPen struct {
	armed  bool
	phase  lookPhase
	points []lookPoint
}

// lookVerdict is what the platform must do about what it just fed in.
type lookVerdict struct {
	// Keep the event from the app in front.
	Swallow bool
	// A line was begun, or a point was added to it.
	Begin, Extend bool
	// The line is finished: these are its points.
	Taken []lookPoint
	// The line was thrown away.
	Dropped bool
}

// Arm says whether the talk pair, and nothing else, is down. A line that is
// being drawn when the keys come up is still finished by letting go of the
// button: the hand that draws is slower than the hand on the keys.
func (p *notchLookPen) Arm(on bool) { p.armed = on }

// Armed reports whether a press would begin a line.
func (p *notchLookPen) Armed() bool { return p.armed }

// Drawing reports whether a line is being drawn.
func (p *notchLookPen) Drawing() bool { return p.phase == lookDrawing }

// Busy reports whether the button that began a line is still down.
func (p *notchLookPen) Busy() bool { return p.phase != lookIdle }

// Down is the left button going down.
func (p *notchLookPen) Down(x, y int) lookVerdict {
	if p.phase != lookIdle {
		// A second press without a letting go: the first one's letting go was
		// lost. It is still ours.
		return lookVerdict{Swallow: true}
	}
	if !p.armed {
		return lookVerdict{}
	}
	p.phase = lookDrawing
	p.points = append(p.points[:0], lookPoint{x, y})
	return lookVerdict{Swallow: true, Begin: true}
}

// Move is the pointer moving. It is never kept from anything.
func (p *notchLookPen) Move(x, y int) lookVerdict {
	if p.phase != lookDrawing {
		return lookVerdict{}
	}
	last := p.points[len(p.points)-1]
	dx, dy := x-last.X, y-last.Y
	if dx*dx+dy*dy < notchLookStepPx*notchLookStepPx {
		return lookVerdict{}
	}
	p.points = append(p.points, lookPoint{x, y})
	if len(p.points) > notchLookMaxPoints {
		// Every other point, keeping the first and the last: the line keeps
		// its shape and stops growing.
		kept := p.points[:0]
		for i, point := range p.points {
			if i%2 == 0 || i == len(p.points)-1 {
				kept = append(kept, point)
			}
		}
		p.points = kept
	}
	return lookVerdict{Extend: true}
}

// Up is the left button coming up.
func (p *notchLookPen) Up(x, y int) lookVerdict {
	switch p.phase {
	case lookDrawing:
		last := p.points[len(p.points)-1]
		if last.X != x || last.Y != y {
			p.points = append(p.points, lookPoint{x, y})
		}
		taken := append([]lookPoint(nil), p.points...)
		p.phase = lookIdle
		p.points = p.points[:0]
		return lookVerdict{Swallow: true, Taken: taken}
	case lookDead:
		p.phase = lookIdle
		return lookVerdict{Swallow: true}
	}
	return lookVerdict{}
}

// Esc throws the line away. It reports Dropped only when there was one.
func (p *notchLookPen) Esc() lookVerdict {
	if p.phase != lookDrawing {
		return lookVerdict{}
	}
	p.phase = lookDead
	p.points = p.points[:0]
	return lookVerdict{Swallow: true, Dropped: true}
}

// Reset forgets everything: the keyboard or the pointer can no longer be
// trusted. A line that was being drawn is thrown away.
func (p *notchLookPen) Reset() (dropped bool) {
	dropped = p.phase == lookDrawing
	p.armed = false
	p.phase = lookIdle
	p.points = p.points[:0]
	return dropped
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

// lookBounds is the smallest rectangle that holds every point.
func lookBounds(points []lookPoint) lookRect {
	if len(points) == 0 {
		return lookRect{}
	}
	x0, y0, x1, y1 := points[0].X, points[0].Y, points[0].X, points[0].Y
	for _, p := range points[1:] {
		x0, y0 = min(x0, p.X), min(y0, p.Y)
		x1, y1 = max(x1, p.X), max(y1, p.Y)
	}
	return lookRect{x0, y0, x1 - x0, y1 - y0}
}

// lookIsClick: the line never left the place where it began.
func lookIsClick(points []lookPoint) bool {
	b := lookBounds(points)
	return b.W < notchLookClickPx && b.H < notchLookClickPx
}

// lookCrossings is where the line, closed from its last point back to its
// first, crosses the height y: sorted, and always an even number of them.
// Between the first and the second is inside, between the second and the
// third is outside, and so on.
func lookCrossings(poly []lookPoint, y float64) []float64 {
	var xs []float64
	n := len(poly)
	for i := 0; i < n; i++ {
		a, b := poly[i], poly[(i+1)%n]
		ay, by := float64(a.Y), float64(b.Y)
		// Half open, so that a corner exactly at y is counted once.
		if (ay <= y) == (by <= y) {
			continue
		}
		t := (y - ay) / (by - ay)
		xs = append(xs, float64(a.X)+t*float64(b.X-a.X))
	}
	sort.Float64s(xs)
	return xs
}

// lookColumnCrossings is lookCrossings for a vertical line at x.
func lookColumnCrossings(poly []lookPoint, x float64) []float64 {
	turned := make([]lookPoint, len(poly))
	for i, p := range poly {
		turned[i] = lookPoint{p.Y, p.X}
	}
	return lookCrossings(turned, x)
}

// lookInside reports whether a place is inside the closed line.
func lookInside(poly []lookPoint, x, y float64) bool {
	if len(poly) < 3 {
		return false
	}
	inside := false
	for _, cross := range lookCrossings(poly, y) {
		if cross > x {
			break
		}
		inside = !inside
	}
	return inside
}

// lookCovered is how much of the stretch from a to b lies inside, given the
// crossings along it.
func lookCovered(crossings []float64, a, b float64) float64 {
	covered := 0.0
	for i := 0; i+1 < len(crossings); i += 2 {
		from, to := math.Max(crossings[i], a), math.Min(crossings[i+1], b)
		if to > from {
			covered += to - from
		}
	}
	return covered
}

// lookCovers reports whether the closed line holds a thing.
//
// A circle is drawn fast and not neatly: around the left end of three rows it
// still means those rows, and the row above that its top edge runs through is
// not meant. So a thing is held when the line's inside covers enough of the
// thing's middle: the line through its centre from left to right, or the one
// from top to bottom. Enough is twelve pixels, or half of a thing that is
// smaller than that.
func lookCovers(poly []lookPoint, r lookRect) bool {
	if len(poly) < 3 || r.empty() {
		return false
	}
	across := lookCovered(lookCrossings(poly, float64(r.Y)+float64(r.H)/2), float64(r.X), float64(r.X+r.W))
	if across >= math.Min(12, float64(r.W)/2) {
		return true
	}
	down := lookCovered(lookColumnCrossings(poly, float64(r.X)+float64(r.W)/2), float64(r.Y), float64(r.Y+r.H))
	return down >= math.Min(12, float64(r.H)/2)
}

// lookSamplePoints is the places inside a line where the screen is asked what
// is there: up to eight heights, and at each the quarter points of its widest
// stretch inside. A line with no inside (a stroke under a word) gives places
// along itself.
func lookSamplePoints(poly []lookPoint, most int) []lookPoint {
	if len(poly) == 0 || most <= 0 {
		return nil
	}
	var out []lookPoint
	seen := map[lookPoint]bool{}
	add := func(x, y float64) {
		p := lookPoint{int(math.Round(x)), int(math.Round(y))}
		if !seen[p] && len(out) < most {
			seen[p] = true
			out = append(out, p)
		}
	}
	b := lookBounds(poly)
	rows := min(8, max(1, most/3))
	if len(poly) >= 3 && b.H > 0 {
		for i := 0; i < rows; i++ {
			y := float64(b.Y) + (float64(i)+0.5)*float64(b.H)/float64(rows)
			xs := lookCrossings(poly, y)
			wide, from, to := 0.0, 0.0, 0.0
			for j := 0; j+1 < len(xs); j += 2 {
				if xs[j+1]-xs[j] > wide {
					wide, from, to = xs[j+1]-xs[j], xs[j], xs[j+1]
				}
			}
			if wide < 2 {
				continue
			}
			for _, part := range []float64{0.5, 0.25, 0.75} {
				add(from+part*(to-from), y)
			}
		}
	}
	if len(out) > 0 {
		return out
	}
	// No inside: what the line itself runs over.
	steps := min(12, most)
	for i := 0; i < steps; i++ {
		p := poly[(len(poly)-1)*i/max(1, steps-1)]
		add(float64(p.X), float64(p.Y))
	}
	return out
}

// ---------------------------------------------------------------------------
// The things
// ---------------------------------------------------------------------------

// lookItemRoles are the system's kinds that are a thing by themselves: what a
// person means when they point at a part of one. From a word inside a row the
// look climbs to the row.
var lookItemRoles = map[string]bool{
	"ListItem": true, "DataItem": true, "TreeItem": true, "TabItem": true, "MenuItem": true,
	"Button": true, "SplitButton": true, "Hyperlink": true, "CheckBox": true, "RadioButton": true,
	"ComboBox": true, "Edit": true, "Image": true, "HeaderItem": true,
}

// lookEdgeRoles are where the climb stops: past them is not a thing, it is
// the place the things are in. A group is not one of them: on a web page the
// words of a row sit inside groups inside its cells, and the climb goes
// through those.
var lookEdgeRoles = map[string]bool{
	"Window": true, "Pane": true, "Document": true, "List": true, "DataGrid": true, "Table": true,
	"Tree": true, "Tab": true, "ToolBar": true, "Menu": true, "MenuBar": true, "TitleBar": true,
}

// lookRowOf reports whether something above a word is the row that word is
// in, going by their sizes: a row is about as tall as its words. A whole
// section of a page that calls itself a list item is not what a click on one
// of its words means.
func lookRowOf(row, word lookRect) bool {
	return row.H <= max(4*word.H, 96)
}

// lookKindOf is what a person would call a thing. local is the system's own
// word for it in the person's language ("row", "cell"), which web pages give
// where the kind itself says only "Custom" or "DataItem".
func lookKindOf(role, local string, r lookRect) string {
	local = strings.ToLower(strings.TrimSpace(local))
	switch local {
	case "row":
		return "row"
	case "cell", "gridcell", "grid cell", "column header", "row header":
		return "cell"
	case "link":
		return "link"
	case "heading":
		return "heading"
	case "article":
		return "item"
	}
	switch role {
	case "ListItem", "TreeItem":
		// A line of a list is a row; a tile of a grid of icons is an item.
		if r.H > 0 && r.W >= 4*r.H {
			return "row"
		}
		return "item"
	case "DataItem":
		if r.H > 0 && r.W >= 8*r.H {
			return "row"
		}
		return "cell"
	case "HeaderItem":
		return "cell"
	case "Button", "SplitButton":
		return "button"
	case "Hyperlink":
		return "link"
	case "Edit", "ComboBox":
		return "field"
	case "CheckBox", "RadioButton":
		return "box"
	case "Image":
		return "picture"
	case "TabItem":
		return "tab"
	case "MenuItem":
		return "menu item"
	case "Text":
		return "text"
	}
	return "thing"
}

// lookClean makes a text fit to be carried: one line, no control characters,
// not longer than a text may be.
func lookClean(text string) string {
	text = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, text)), " ")
	if utf8.RuneCountInString(text) > notchLookTextRunes {
		runes := []rune(text)
		text = string(runes[:notchLookTextRunes-1]) + "…"
	}
	return text
}

// lookSort puts things in reading order: top to bottom, and left to right
// among those on one line.
func lookSort(things []lookThing) {
	sort.SliceStable(things, func(i, j int) bool {
		a, b := things[i].Rect, things[j].Rect
		// On one line when each one's middle is within the other's height.
		am, bm := a.Y+a.H/2, b.Y+b.H/2
		if am >= b.Y && am < b.Y+b.H && bm >= a.Y && bm < a.Y+a.H {
			return a.X < b.X
		}
		return am < bm
	})
}

// lookLines counts the lines things stand on, once they are in reading order.
func lookLines(things []lookThing) int {
	lines := 0
	for i, thing := range things {
		if i == 0 {
			lines = 1
			continue
		}
		prev := things[i-1].Rect
		mid := thing.Rect.Y + thing.Rect.H/2
		if mid < prev.Y || mid >= prev.Y+prev.H {
			lines++
		}
	}
	return lines
}

// lookGather turns cells into rows where the line took several cells of each
// row: three rows of a spreadsheet are three things, not twelve. Things that
// are not cells, or that stand one to a line, are left as they are.
func lookGather(things []lookThing) []lookThing {
	lookSort(things)
	cells := 0
	for _, thing := range things {
		if thing.Kind == "cell" {
			cells++
		}
	}
	lines := lookLines(things)
	if cells != len(things) || len(things) < 2 || lines == len(things) {
		return things
	}
	rows := make([]lookThing, 0, lines)
	for i, cell := range things {
		text := cell.Value
		if text == "" {
			text = cell.Name
		}
		prev := lookRect{}
		if i > 0 {
			prev = things[i-1].Rect
		}
		mid := cell.Rect.Y + cell.Rect.H/2
		if i == 0 || mid < prev.Y || mid >= prev.Y+prev.H {
			rows = append(rows, lookThing{Kind: "row", Role: "Row", Rect: cell.Rect})
		}
		row := &rows[len(rows)-1]
		if len(row.Parts) < notchLookMaxParts {
			row.Parts = append(row.Parts, text)
		}
		x1, y1 := max(row.Rect.X+row.Rect.W, cell.Rect.X+cell.Rect.W), max(row.Rect.Y+row.Rect.H, cell.Rect.Y+cell.Rect.H)
		row.Rect.X, row.Rect.Y = min(row.Rect.X, cell.Rect.X), min(row.Rect.Y, cell.Rect.Y)
		row.Rect.W, row.Rect.H = x1-row.Rect.X, y1-row.Rect.Y
	}
	return rows
}

var lookPlurals = map[string]string{
	"row": "rows", "cell": "cells", "button": "buttons", "link": "links", "field": "fields", "text": "texts",
	"picture": "pictures", "tab": "tabs", "item": "items", "menu item": "menu items", "box": "boxes",
	"heading": "headings", "thing": "things",
}

// lookTag is the few words beside the line that say what it holds: the name
// of one thing, or how many of what.
func lookTag(things []lookThing) string {
	switch len(things) {
	case 0:
		return ""
	case 1:
		thing := things[0]
		name := thing.Name
		if name == "" {
			name = thing.Value
		}
		if name == "" && len(thing.Parts) > 0 {
			name = strings.Join(thing.Parts, " · ")
		}
		if name == "" {
			return "a " + thing.Kind
		}
		if utf8.RuneCountInString(name) > 48 {
			name = string([]rune(name)[:47]) + "…"
		}
		return name
	}
	kind := things[0].Kind
	for _, thing := range things[1:] {
		if thing.Kind != kind {
			kind = "thing"
			break
		}
	}
	return fmt.Sprintf("%d %s", len(things), lookPlurals[kind])
}

// ---------------------------------------------------------------------------
// What the brain is told
// ---------------------------------------------------------------------------

// notchLookTold is everything about one look that is words: it travels beside
// the picture, not in the event's payload, because a payload is not private.
type notchLookTold struct {
	App    string      `json:"app,omitempty"`
	Title  string      `json:"title,omitempty"`
	Things []lookThing `json:"things"`
}

// notchLookBody packs what was read and the picture into one piece: four
// bytes saying how long the words are, the words as JSON, then the picture.
func notchLookBody(told notchLookTold, picture []byte) ([]byte, error) {
	if told.Things == nil {
		told.Things = []lookThing{}
	}
	words, err := json.Marshal(told)
	if err != nil {
		return nil, err
	}
	body := make([]byte, 4, 4+len(words)+len(picture))
	binary.BigEndian.PutUint32(body, uint32(len(words)))
	body = append(body, words...)
	return append(body, picture...), nil
}

// notchLookPayload is the part of the event that is not words: how the look
// was made, how many things it holds, where it was, and what part of the
// screen the picture shows. Or, when nothing was looked at, why not.
func notchLookPayload(phase, id, how, refused string, things int, bounds lookRect, picture lookRect) map[string]any {
	payload := map[string]any{"phase": phase, "look_id": id, "how": how}
	if refused != "" {
		payload["refused"] = refused
		return payload
	}
	payload["things"] = things
	payload["rect"] = map[string]any{"x": bounds.X, "y": bounds.Y, "w": bounds.W, "h": bounds.H}
	if !picture.empty() {
		payload["picture"] = map[string]any{"x": picture.X, "y": picture.Y, "w": picture.W, "h": picture.H}
	}
	return payload
}

// lookPictureRect is the part of the screen a look's picture shows: what was
// circled with some room round it, so that a row is seen with its neighbours
// and its header, kept inside the screen and not larger than a model reads
// well.
func lookPictureRect(bounds, screen lookRect) lookRect {
	const room, least, most = 60, 240, 1600
	r := lookRect{bounds.X - room, bounds.Y - room, bounds.W + 2*room, bounds.H + 2*room}
	if r.W < least {
		r.X -= (least - r.W) / 2
		r.W = least
	}
	if r.H < least {
		r.Y -= (least - r.H) / 2
		r.H = least
	}
	if r.W > most {
		r.X += (r.W - most) / 2
		r.W = most
	}
	if r.H > most {
		r.Y += (r.H - most) / 2
		r.H = most
	}
	// Inside the screen.
	if r.X < screen.X {
		r.X = screen.X
	}
	if r.Y < screen.Y {
		r.Y = screen.Y
	}
	if r.X+r.W > screen.X+screen.W {
		r.X = max(screen.X, screen.X+screen.W-r.W)
		r.W = min(r.W, screen.W)
	}
	if r.Y+r.H > screen.Y+screen.H {
		r.Y = max(screen.Y, screen.Y+screen.H-r.H)
		r.H = min(r.H, screen.H)
	}
	return r
}
