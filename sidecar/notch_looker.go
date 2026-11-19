package main

// The look, from the first press to what the brain is told.
//
// Three things meet here and none of them may wait on another:
//
//   - the watch on the pointer, which Windows is timing: it is told at once
//     whether a press is kept from the app, and nothing else is done there;
//   - the ink, which must follow the hand;
//   - the reading of what is inside the line, which asks another program and
//     can take a quarter of a second.
//
// So the pen decides under a lock, the ink is handed straight to the platform,
// and the reading has a goroutine of its own. While a line is drawn that
// goroutine reads what the line holds so far, a few times a second, for the
// tag. When the line is finished it reads once more and tells the brain.
//
// The brain is told with one event type, `notch.look`, in three phases:
//
//	begun    a line was begun                         {look_id}
//	taken    here is what it held                     {look_id, how, things, rect, picture} + the words and the picture
//	         or nothing was looked at                 {look_id, how, refused}
//	dropped  the line was thrown away (Esc)           {look_id}
//
// `begun` is said at the press, before anything is read, so that the brain
// knows a look is under way when the talk keys come up a moment later: a
// circle drawn without a word is not "I did not catch that".
//
// No platform calls in this file.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"sync"
	"time"
	"unicode/utf8"
)

// lookHands is what a platform does for a look.
type lookHands interface {
	// Watch asks the platform to look again at whether the pointer is to be
	// watched (NotchLook.Wants): it is watched only while the talk pair is
	// down or a line is being drawn, and at no other time.
	Watch()
	// The display a place is on: its rectangle in screen pixels and its scale
	// (1 at 100%, 1.5 at 150%).
	Screen(at lookPoint) (lookRect, float64)
	// Whether a place is on one of this program's own windows.
	Own(at lookPoint) bool
	// The program and the window at a place.
	Front(at lookPoint) (app, title string)
	// A copy of a display as it is now, before any ink is on it. Nil when it
	// could not be taken.
	Snapshot(screen lookRect) lookSnapshot
	// The ink. None of these wait.
	InkBegin(at lookPoint, screen lookRect, scale float64)
	InkLine(from, to lookPoint)
	InkTag(text string, bounds lookRect)
	// InkEnd takes the ink away after it has stayed this long.
	InkEnd(stay time.Duration)
	// Point sends Jarvis's own pointer to a rectangle of the screen: from
	// the notch, or from where it is when it is already out. When it has
	// landed a ring is drawn round the rectangle, with a few words beside it.
	// Ring and words stay for that long; then the pointer goes home.
	Point(r lookRect, label string, stay time.Duration)
	// PointHit: the thing pointed at was clicked. Its ring and words go at
	// once. The pointer waits where it is for the next thing a while, and
	// goes home when none comes.
	PointHit()
	// PointEnd takes ring and words away and sends the pointer home now.
	PointEnd()
	// HandTo sends one of Jarvis's pointers (0, 1 or 2) to a place, with no
	// ring: a job is being done there, and what happens is what is seen. It
	// comes back with how long the way takes. beside: a pointer that is not
	// out yet comes up at the place itself instead of out of the notch.
	HandTo(n int, at lookPoint, beside bool) time.Duration
	// HandsHome sends every pointer home.
	HandsHome()
	// Hover puts a few words beside a place, or takes them away with "".
	Hover(text string, at lookPoint)
	// The window a place is in: its rectangle in screen pixels (empty when
	// it cannot be told), and the names of what stands round that place, from
	// the nearest outwards (the panel, the list, the page).
	WindowRect(at lookPoint) lookRect
	Around(at lookPoint) []string
	// What is at a place, and what a line holds. Both may take a while.
	// light: only what the tag needs (what kind of thing, and the name of
	// one), not what is written inside each.
	ThingAt(at lookPoint, light bool) (lookThing, bool)
	ThingsIn(line []lookPoint, light bool) []lookThing
}

// lookSnapshot is a copy of a display that a picture can be cut from.
type lookSnapshot interface {
	// Cut gives a part of it as an image file (PNG), or nil.
	Cut(part lookRect) []byte
	// CutSmall is Cut, made smaller when its longest side would be more than
	// most pixels.
	CutSmall(part lookRect, most int) []byte
}

const (
	// How long the ink stays after the line is finished, and after it is
	// thrown away.
	notchLookInkStay    = 900 * time.Millisecond
	notchLookInkDropped = 120 * time.Millisecond
	// The tag is read again no sooner than this after the last reading.
	notchLookTagEvery = 180 * time.Millisecond
)

// NotchLook is the look on one machine.
type NotchLook struct {
	mu    sync.Mutex
	pen   notchLookPen
	hands lookHands
	send  func(payload map[string]any, body []byte)
	// Why this program is not looking at a window, or "": notch_where.go.
	away func(app, title string) string

	// The line being drawn, or the last one, and where the pointer last was
	// on it.
	line *lookLine
	last lookPoint
	// An Esc that dropped a line is still down: its coming up is ours too.
	escHeld bool
	// Something was pointed at and the person's click is waited for.
	waiting *lookWait
	// A thing the person showed is held to be put somewhere (notch.hold): the
	// words that say so, until when, and where the pointer last was while the
	// talk pair was down. With the pair down those words stand beside the
	// pointer over a place that can take the thing.
	held    string
	heldTil time.Time
	hoverAt lookPoint

	// Something changed in the line being drawn: the tag is due a reading.
	changed chan struct{}
	// Finished lines, to be read and told.
	taken chan lookTaken
	once  sync.Once
}

// lookLine is one line from its press on. What the press found out (which
// display, whether this program may look there, the copy of the screen) is
// found out beside the watch on the pointer, not inside it, so a quick hand
// can be done before it is known. Nothing is read, and nothing is told, until
// ready is closed.
type lookLine struct {
	id    string
	ready chan struct{}
	// Thrown away, or the look was ended under it: it is never told. Written
	// and read with the look's lock held.
	gone bool
	// Known once ready is closed.
	screen   lookRect
	refused  string
	snapshot lookSnapshot
}

// lookClick is what came of waiting for a click on a thing that was pointed
// at: whether a button of the pointer came up at all, whether that was on
// the thing, and otherwise why the wait ended ("time", "replaced", "gone").
type lookClick struct {
	Clicked bool
	Inside  bool
	Why     string
}

// lookWait is one wait for such a click.
type lookWait struct {
	rect lookRect
	done chan lookClick
}

// A click this close to the thing counts as on it: its ring is drawn that far out.
const notchPointSlack = 8

type lookTaken struct {
	line   *lookLine
	points []lookPoint
	// When the button came up.
	at time.Time
}

// How long a finished line waits for what its press was finding out.
const notchLookReadyWait = 3 * time.Second

// The one look of this program, and its hands, which are made once.
var (
	notchLooker    = newNotchLook()
	notchLookHands lookHands
	notchLookStart sync.Once
)

// notchLookAway says why this program does not look at a window, or "" when
// it does: watching is switched off or Jarvis is asleep (observers_pause.go:
// the person's "stop looking" covers every way of looking, this one too), an
// app on the person's list, a bank, or any window at all while a password is
// being typed (notch_where.go).
func notchLookAway(app, title string) string {
	if screenObserversPaused.Load() {
		return "off"
	}
	if look := notchWhere.Look(); look != notchLooking {
		return string(look)
	}
	if notchWhere.Refuses(app, title) {
		return "private"
	}
	return ""
}

func newNotchLook() *NotchLook {
	return &NotchLook{changed: make(chan struct{}, 1), taken: make(chan lookTaken, 4)}
}

func newNotchLookID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "l" + hex.EncodeToString([]byte(time.Now().Format("150405.000000000")))
	}
	return "l" + hex.EncodeToString(b[:])
}

// Use gives the look its hands and the way to the brain. Until then, and
// after Forget, the pointer is nobody's but the app's.
func (l *NotchLook) Use(hands lookHands, away func(app, title string) string, send func(payload map[string]any, body []byte)) {
	l.mu.Lock()
	l.hands, l.away, l.send = hands, away, send
	l.mu.Unlock()
	l.once.Do(func() { go l.read() })
}

// Forget ends it: the connection to the brain is gone, or the notch is off.
func (l *NotchLook) Forget() {
	l.mu.Lock()
	hands := l.hands
	l.pen.Reset()
	l.endWait("gone")
	l.held, l.heldTil = "", time.Time{}
	if hands != nil {
		hands.PointEnd()
		hands.Hover("", lookPoint{})
	}
	l.hands, l.send, l.away = nil, nil, nil
	if l.line != nil {
		l.line.gone = true
		l.line = nil
		if hands != nil {
			// Under the lock, like every word to the ink about a line: so that
			// they reach it in the order they were meant.
			hands.InkEnd(0)
		}
	}
	l.mu.Unlock()
	if hands != nil {
		hands.Watch()
	}
}

// Wants reports whether the pointer is to be watched now: the talk pair is
// down, the button that began a line has not come up yet, or something was
// pointed at and the person's click on it is waited for.
func (l *NotchLook) Wants() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.hands != nil && (l.pen.Armed() || l.pen.Busy() || l.waiting != nil)
}

// Keys is the keyboard saying whether the talk pair, and nothing else, is
// down.
func (l *NotchLook) Keys(armed bool) {
	l.mu.Lock()
	hands := l.hands
	was := l.pen.Armed()
	l.pen.Arm(armed && hands != nil)
	now := l.pen.Armed()
	l.mu.Unlock()
	if hands != nil && was != now {
		hands.Watch()
		if !now {
			// The keys are up: nothing is being pointed at any more.
			hands.Hover("", lookPoint{})
		}
	}
}

// Hold is the brain saying that a thing the person showed is held to be put
// somewhere, in a few words ("3 rows"), and for how long. With no words
// nothing is held.
func (l *NotchLook) Hold(what string, stay time.Duration) {
	l.mu.Lock()
	hands := l.hands
	if what == "" || stay <= 0 {
		l.held, l.heldTil = "", time.Time{}
	} else {
		l.held, l.heldTil = "Put "+what+" here", time.Now().Add(stay)
	}
	l.mu.Unlock()
	if hands != nil && what == "" {
		hands.Hover("", lookPoint{})
	}
}

// lookTakes says whether a thing is a place something can be put: a field, a
// cell of a table, or a page of writing.
func lookTakes(thing lookThing) bool {
	if thing.Kind == "field" || thing.Kind == "cell" {
		return true
	}
	return thing.Role == "Document" || thing.Role == "Edit" || thing.Role == "ComboBox" || thing.Role == "DataItem"
}

// How long a thing may be held, at the most.
const notchHoldMax = 5 * time.Minute

// makeNotchHoldHandler serves notch.hold: {what, ms}, or {} to hold nothing.
func makeNotchHoldHandler(l *NotchLook) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		what, _ := params["what"].(string)
		what = lookClean(what)
		if utf8.RuneCountInString(what) > 40 {
			what = string([]rune(what)[:39]) + "…"
		}
		ms, _ := params["ms"].(float64)
		if math.IsNaN(ms) || ms < 0 {
			ms = 0
		}
		l.Hold(what, min(time.Duration(ms)*time.Millisecond, notchHoldMax))
		return &RPCResult{Result: map[string]any{"held": what != "" && ms > 0}}, nil
	}
}

// Esc is Esc going down. True when it threw a line away: then the key is
// kept from the app, and so is its coming up (EscUp).
func (l *NotchLook) Esc() bool {
	l.mu.Lock()
	if l.escHeld {
		// The key repeating while it is held: still the look's.
		l.mu.Unlock()
		return true
	}
	v := l.pen.Esc()
	hands, send, line := l.hands, l.send, l.line
	if !v.Dropped || line == nil {
		l.mu.Unlock()
		return v.Dropped
	}
	line.gone = true
	line.snapshot = nil
	l.escHeld = true
	if hands != nil {
		hands.InkEnd(notchLookInkDropped)
	}
	l.mu.Unlock()
	if send != nil {
		send(map[string]any{"phase": "dropped", "look_id": line.id}, nil)
	}
	return true
}

// EscUp is Esc coming up. True when its going down was taken here.
func (l *NotchLook) EscUp() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	held := l.escHeld
	l.escHeld = false
	return held
}

// Down is the left button going down. True when it is kept from the app.
func (l *NotchLook) Down(x, y int) bool {
	at := lookPoint{x, y}
	l.mu.Lock()
	hands := l.hands
	// A press on one of this program's own windows is that window's.
	if hands == nil || (!l.pen.Busy() && l.pen.Armed() && hands.Own(at)) {
		l.mu.Unlock()
		return false
	}
	v := l.pen.Down(x, y)
	if !v.Begin {
		l.mu.Unlock()
		return v.Swallow
	}
	// A line is begun: whatever was being pointed at is over.
	l.endWait("replaced")
	hands.Hover("", lookPoint{})
	line := &lookLine{id: newNotchLookID(), ready: make(chan struct{})}
	l.line = line
	l.last = at
	send, away := l.send, l.away
	l.mu.Unlock()

	// The rest is not for the watch on the pointer to wait on.
	go func() {
		defer close(line.ready)
		screen, scale := hands.Screen(at)
		refused := ""
		if away != nil {
			refused = away(hands.Front(at))
		}
		var snapshot lookSnapshot
		if refused == "" {
			// Before the ink: the picture is of the screen, not of the line.
			snapshot = hands.Snapshot(screen)
		}
		l.mu.Lock()
		if line.gone {
			l.mu.Unlock()
			return
		}
		line.screen, line.refused, line.snapshot = screen, refused, snapshot
		hands.InkBegin(at, screen, scale)
		if l.line == line {
			// The hand did not wait for the ink: what it drew meanwhile is laid down now.
			for i := 1; i < len(l.pen.points); i++ {
				hands.InkLine(l.pen.points[i-1], l.pen.points[i])
			}
		}
		l.mu.Unlock()
		if send != nil {
			send(map[string]any{"phase": "begun", "look_id": line.id}, nil)
		}
	}()
	return true
}

// Move is the pointer moving. It is never kept from anything.
func (l *NotchLook) Move(x, y int) {
	l.mu.Lock()
	v := l.pen.Move(x, y)
	hands, from := l.hands, l.last
	if v.Extend {
		l.last = lookPoint{x, y}
	}
	// The talk pair is down, no line is being drawn, and a thing is held: the
	// place under the pointer is read, to say whether the thing can go there.
	hover := !v.Extend && hands != nil && l.held != "" && l.pen.Armed() && !l.pen.Busy()
	if hover {
		l.hoverAt = lookPoint{x, y}
	}
	l.mu.Unlock()
	if hover {
		select {
		case l.changed <- struct{}{}:
		default:
		}
		return
	}
	if !v.Extend || hands == nil {
		return
	}
	hands.InkLine(from, lookPoint{x, y})
	select {
	case l.changed <- struct{}{}:
	default:
	}
}

// Up is the left button coming up. True when it is kept from the app.
func (l *NotchLook) Up(x, y int) bool {
	l.mu.Lock()
	v := l.pen.Up(x, y)
	hands, from := l.hands, l.last
	var job *lookTaken
	if v.Taken != nil && l.line != nil {
		job = &lookTaken{line: l.line, points: v.Taken, at: time.Now()}
	}
	l.mu.Unlock()
	if hands != nil && v.Swallow {
		// The button is up: with the keys up too, the pointer is nobody's again.
		hands.Watch()
	}
	if job == nil {
		return v.Swallow
	}
	if hands != nil && (from.X != x || from.Y != y) && !lookIsClick(job.points) {
		hands.InkLine(from, lookPoint{x, y})
	}
	select {
	case l.taken <- *job:
	default:
		// Four looks are waiting to be read. This one is let go.
		l.mu.Lock()
		job.line.gone = true
		if hands != nil && l.line == job.line {
			hands.InkEnd(0)
		}
		l.mu.Unlock()
	}
	return true
}

// holds reads what a line holds: the one thing under a click, or the things
// inside a line, gathered into rows where they are the cells of rows.
func lookHolds(hands lookHands, points []lookPoint, light bool) []lookThing {
	if lookIsClick(points) {
		if thing, ok := hands.ThingAt(points[len(points)-1], light); ok {
			return []lookThing{thing}
		}
		return nil
	}
	things := lookGather(hands.ThingsIn(points, light))
	if len(things) > notchLookMaxThings {
		things = things[:notchLookMaxThings]
	}
	for i := range things {
		things[i].Over = lookOver(points, things[i].Rect)
	}
	return things
}

// notchLookStraySamples is at how many places along a line it is asked
// whether this program may look there.
const notchLookStraySamples = 12

// lookStrays says why a line must not be read, by where it went: at up to
// notchLookStraySamples places along it and at its middle, the window there
// is asked about as the window under the press was. "" when it may be read.
func lookStrays(hands lookHands, away func(app, title string) string, points []lookPoint) string {
	if away == nil || len(points) == 0 {
		return ""
	}
	bounds := lookBounds(points)
	places := []lookPoint{{bounds.X + bounds.W/2, bounds.Y + bounds.H/2}, points[len(points)-1]}
	step := len(points) / notchLookStraySamples
	if step < 1 {
		step = 1
	}
	for i := 0; i < len(points); i += step {
		places = append(places, points[i])
	}
	// One window is asked about once, however many places lie on it.
	asked := map[[2]string]bool{}
	for _, at := range places {
		app, title := hands.Front(at)
		if asked[[2]string{app, title}] {
			continue
		}
		asked[[2]string{app, title}] = true
		if why := away(app, title); why != "" {
			return why
		}
	}
	return ""
}

// lookCornersAway says whether a rectangle of the screen reaches into a
// window this program looks away from: asked at its four corners.
func lookCornersAway(hands lookHands, away func(app, title string) string, r lookRect) bool {
	if away == nil || r.W <= 0 || r.H <= 0 {
		return false
	}
	for _, at := range []lookPoint{{r.X + 1, r.Y + 1}, {r.X + r.W - 2, r.Y + 1}, {r.X + 1, r.Y + r.H - 2}, {r.X + r.W - 2, r.Y + r.H - 2}} {
		if away(hands.Front(at)) != "" {
			return true
		}
	}
	return false
}

// read is the goroutine that reads: for the tag while a line is drawn, and
// once more when it is finished.
func (l *NotchLook) read() {
	var lastRead time.Time
	for {
		select {
		case job := <-l.taken:
			l.tell(job)
			lastRead = time.Now()
		case <-l.changed:
			if wait := notchLookTagEvery - time.Since(lastRead); wait > 0 {
				// A finished line does not wait behind the tag of an unfinished one.
				select {
				case job := <-l.taken:
					l.tell(job)
					lastRead = time.Now()
					continue
				case <-time.After(wait):
				}
			}
			l.mu.Lock()
			hands, line := l.hands, l.line
			drawing := l.pen.Drawing()
			points := append([]lookPoint(nil), l.pen.points...)
			held, at := l.held, l.hoverAt
			pointing := held != "" && l.pen.Armed() && !l.pen.Busy()
			if held != "" && time.Now().After(l.heldTil) {
				// Held too long ago: it is forgotten.
				l.held, held, pointing = "", "", false
			}
			away := l.away
			l.mu.Unlock()
			if hands != nil && !drawing && pointing {
				// Nothing is read where this program looks away.
				words := ""
				if away == nil || away(hands.Front(at)) == "" {
					if thing, ok := hands.ThingAt(at, true); ok && lookTakes(thing) {
						words = held
					}
				}
				lastRead = time.Now()
				l.mu.Lock()
				if l.pen.Armed() && !l.pen.Busy() && l.hands != nil {
					hands.Hover(words, at)
				}
				l.mu.Unlock()
				continue
			}
			if hands == nil || line == nil || !drawing || len(points) < 2 || lookIsClick(points) {
				continue
			}
			// Nothing is read before it is known that this program may look there.
			select {
			case <-line.ready:
			default:
				continue
			}
			if line.refused != "" {
				continue
			}
			// Nor where the line has gone since: it began in one window and
			// may be over another by now.
			if lookStrays(hands, away, points) != "" {
				continue
			}
			tag := lookTag(lookHolds(hands, points, true))
			lastRead = time.Now()
			l.mu.Lock()
			if l.line == line && !line.gone && l.pen.Drawing() {
				hands.InkTag(tag, lookBounds(points))
			}
			l.mu.Unlock()
		}
	}
}

// tell reads a finished line and tells the brain.
func (l *NotchLook) tell(job lookTaken) {
	line := job.line
	// What the press was finding out, first: above all whether this program
	// may look there at all.
	select {
	case <-line.ready:
	case <-time.After(notchLookReadyWait):
		l.mu.Lock()
		line.gone = true
		if l.hands != nil && l.line == line {
			l.hands.InkEnd(0)
		}
		l.mu.Unlock()
		log.Printf("[notch] look: a line was let go, its press never finished finding out where it was")
		return
	}
	l.mu.Lock()
	hands, send, gone := l.hands, l.send, line.gone
	l.mu.Unlock()
	if hands == nil || send == nil || gone {
		return
	}
	// The ink is told only while this line is still the one on the screen: a
	// new line may have been begun while this one was read.
	ink := func(tag string, stay time.Duration) {
		l.mu.Lock()
		if l.line == line && l.hands != nil {
			if tag != "" {
				l.hands.InkTag(tag, lookBounds(job.points))
			}
			l.hands.InkEnd(stay)
		}
		l.mu.Unlock()
	}
	how := lookHowLoop
	if lookIsClick(job.points) {
		how = lookHowClick
	}
	bounds := lookBounds(job.points)
	refused := line.refused
	if refused == "" {
		// The press said where the line began. Where it went is asked now:
		// begun on the desktop or in a document, it can go round a figure in
		// a bank's window beside it, and that window was never asked about.
		l.mu.Lock()
		away := l.away
		l.mu.Unlock()
		refused = lookStrays(hands, away, job.points)
	}
	if refused != "" {
		l.mu.Lock()
		line.snapshot = nil
		l.mu.Unlock()
		ink("", notchLookInkDropped)
		send(notchLookPayload("taken", line.id, how, refused, 0, bounds, lookRect{}), nil)
		return
	}
	reading := time.Now()
	things := lookHolds(hands, job.points, false)
	readMs := time.Since(reading).Milliseconds()
	ink(lookTag(things), notchLookInkStay)
	// What was circled is where the things are, when any were found: a sloppy
	// circle round the left end of three rows is a picture of the three rows.
	seen := bounds
	for _, thing := range things {
		seen = lookUnion(seen, thing.Rect)
	}
	middle := lookPoint{bounds.X + bounds.W/2, bounds.Y + bounds.H/2}
	app, title := hands.Front(middle)
	own := ""
	if len(things) > 0 {
		own = things[0].Name
	}
	around := lookAroundNames(hands.Around(middle), own, title)
	var picture, window []byte
	part := lookRect{}
	if line.snapshot != nil {
		part = lookPictureRect(seen, line.screen)
		// The picture has room round what was circled, and that room can
		// reach into the window next to it. Where it would take in a window
		// this program looks away from, no picture is made: the words are
		// enough.
		l.mu.Lock()
		away := l.away
		l.mu.Unlock()
		if lookCornersAway(hands, away, part) {
			line.snapshot = nil
			part = lookRect{}
		}
	}
	if line.snapshot != nil {
		picture = line.snapshot.Cut(part)
		if picture == nil {
			part = lookRect{}
		}
		// And the whole window round it, smaller: what a thing means is told
		// by what stands round it, and a close picture leaves that out.
		if whole := lookWithin(hands.WindowRect(middle), line.screen); lookWindowWorthIt(whole, part) {
			window = line.snapshot.CutSmall(whole, notchLookWindowSide)
		}
		// The copy of the whole display is let go as soon as the pictures are cut.
		line.snapshot = nil
	}
	body, err := notchLookBody(notchLookTold{App: app, Title: lookClean(title), Around: around, Things: things}, picture, window)
	if err != nil {
		log.Printf("[notch] look: what was read could not be packed: %v", err)
		return
	}
	// Counts, sizes and how long it took, never what was read. The times are
	// there because a look is joined to what is said in the same hold: one
	// that is told long after the button came up keeps the answer waiting.
	sinceUp := int64(0)
	if !job.at.IsZero() {
		sinceUp = time.Since(job.at).Milliseconds()
	}
	log.Printf("[notch] look: %s, %d thing(s), %d name(s) round them, picture %d bytes, window %d bytes; the things were read in %d ms, and it is told %d ms after the button came up",
		how, len(things), len(around), len(picture), len(window), readMs, sinceUp)
	send(notchLookPayload("taken", line.id, how, "", len(things), bounds, part), body)
}

// How long a ring may stay, at the least and at the most.
const (
	notchPointMinStay = 500 * time.Millisecond
	notchPointMaxStay = 15 * time.Second
)

// parseNotchPoint reads a request to point at a rectangle of the screen:
// where it is in the screen's own pixels, a few words to put beside it, and
// how long it stays.
func parseNotchPoint(params map[string]any) (lookRect, string, time.Duration, error) {
	number := func(key string) (int, error) {
		raw, ok := params[key].(float64)
		if !ok || math.IsNaN(raw) || math.Abs(raw) > 200000 {
			return 0, fmt.Errorf("notch.point: %s must be a number of screen pixels", key)
		}
		return int(math.Round(raw)), nil
	}
	var r lookRect
	var err error
	if r.X, err = number("x"); err != nil {
		return lookRect{}, "", 0, err
	}
	if r.Y, err = number("y"); err != nil {
		return lookRect{}, "", 0, err
	}
	if r.W, err = number("w"); err != nil {
		return lookRect{}, "", 0, err
	}
	if r.H, err = number("h"); err != nil {
		return lookRect{}, "", 0, err
	}
	if r.empty() {
		return lookRect{}, "", 0, fmt.Errorf("notch.point: the rectangle has no size")
	}
	label, _ := params["label"].(string)
	label = lookClean(label)
	if utf8.RuneCountInString(label) > 60 {
		label = string([]rune(label)[:59]) + "…"
	}
	stay := 5 * time.Second
	if ms, ok := params["ms"].(float64); ok && !math.IsNaN(ms) {
		stay = time.Duration(ms) * time.Millisecond
	}
	stay = max(notchPointMinStay, min(stay, notchPointMaxStay))
	return r, label, stay, nil
}

// endWait ends the wait for a click, if there is one, and says why. Called
// with the lock held.
func (l *NotchLook) endWait(why string) {
	if w := l.waiting; w != nil {
		l.waiting = nil
		w.done <- lookClick{Why: why}
	}
}

// Point sends the pointer to a rectangle of the screen and rings it. An error
// when there is nothing to draw with here, or a line is being drawn by the
// person.
func (l *NotchLook) Point(r lookRect, label string, stay time.Duration) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hands == nil {
		return fmt.Errorf("pointing is not available on this computer")
	}
	if l.pen.Busy() {
		return fmt.Errorf("the person is drawing a line")
	}
	l.endWait("replaced")
	// A line that was finished is no longer the one on the screen: the ring takes its place.
	l.line = nil
	l.hands.Point(r, label, stay)
	return nil
}

// PointWait points at a rectangle and waits for the person to click: there,
// or anywhere else. It comes back when a button of the pointer has come up,
// when the wait is over, or when something else took the pointing's place.
// The click itself is never kept from the app: it is only seen.
func (l *NotchLook) PointWait(r lookRect, label string, wait time.Duration) (lookClick, error) {
	l.mu.Lock()
	hands := l.hands
	if hands == nil {
		l.mu.Unlock()
		return lookClick{}, fmt.Errorf("pointing is not available on this computer")
	}
	if l.pen.Busy() {
		l.mu.Unlock()
		return lookClick{}, fmt.Errorf("the person is drawing a line")
	}
	l.endWait("replaced")
	l.line = nil
	w := &lookWait{rect: r, done: make(chan lookClick, 1)}
	l.waiting = w
	// Ring and words stay for the whole wait: what ends the wait takes them down.
	hands.Point(r, label, wait+time.Second)
	l.mu.Unlock()
	hands.Watch()
	select {
	case got := <-w.done:
		return got, nil
	case <-time.After(wait):
	}
	l.mu.Lock()
	if l.waiting == w {
		l.waiting = nil
		hands.PointEnd()
	}
	l.mu.Unlock()
	hands.Watch()
	// The click may have come in the same moment.
	select {
	case got := <-w.done:
		return got, nil
	default:
		return lookClick{Why: "time"}, nil
	}
}

// lookMarker is a pair of hands that can also lay a mark over a thing
// (notch_mark.go). Not every system's hands can: where they cannot, marking
// is not available and the line it belongs to comes without one.
type lookMarker interface {
	Mark(r lookRect, stay time.Duration)
	MarkEnd()
}

// Mark sweeps a mark over a rectangle of the screen. An error when there is
// nothing to draw it with here, or the person is drawing a line.
func (l *NotchLook) Mark(r lookRect, stay time.Duration) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	marker, ok := l.hands.(lookMarker)
	if l.hands == nil || !ok {
		return fmt.Errorf("marking is not available on this computer")
	}
	if l.pen.Busy() {
		return fmt.Errorf("the person is drawing a line")
	}
	marker.Mark(r, stay)
	return nil
}

// MarkClear takes the mark away, if one is up.
func (l *NotchLook) MarkClear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if marker, ok := l.hands.(lookMarker); ok && l.hands != nil {
		marker.MarkEnd()
	}
}

// makeNotchMarkHandler serves notch.mark: a mark over the thing a line on the
// notch is about, in the window the person is in.
//
// It is drawn only over the window that was looked at, as it was looked at:
// the brain says where that window was (`in`), and when the window in front
// is no longer there, the mark would lie over something else and is not
// drawn. Nor is it drawn where this program looks away, or outside that
// window, or over more than a mark covers.
func makeNotchMarkHandler(l *NotchLook) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		if clear, _ := params["clear"].(bool); clear {
			l.MarkClear()
			return &RPCResult{Result: map[string]any{"cleared": true}}, nil
		}
		number := func(from map[string]any, key string) (int, bool) {
			raw, ok := from[key].(float64)
			if !ok || math.IsNaN(raw) || math.Abs(raw) > 200000 {
				return 0, false
			}
			return int(math.Round(raw)), true
		}
		rect := func(from map[string]any) (lookRect, bool) {
			var r lookRect
			var okX, okY, okW, okH bool
			r.X, okX = number(from, "x")
			r.Y, okY = number(from, "y")
			r.W, okW = number(from, "w")
			r.H, okH = number(from, "h")
			return r, okX && okY && okW && okH
		}
		r, ok := rect(params)
		if !ok {
			return nil, fmt.Errorf("notch.mark: x, y, w and h must be numbers of screen pixels")
		}
		in, _ := params["in"].(map[string]any)
		was, ok := rect(in)
		if !ok {
			return nil, fmt.Errorf("notch.mark: the window that was looked at must be given")
		}
		if platformNotchFront == nil {
			return nil, fmt.Errorf("notch.mark: %w", errNotchLookNotHere)
		}
		window, app, title, err := platformNotchFront()
		if err != nil {
			return nil, fmt.Errorf("notch.mark: %w", err)
		}
		// Decided before anything is drawn (notch_where.go).
		if away := notchLookAway(notchAppKey(app), title); away != "" {
			return &RPCResult{Result: map[string]any{"marked": false, "why": "away"}}, nil
		}
		if hands := notchActHands(); hands != nil {
			// As a picture of it is cut: only what is on the display the window is on.
			screen, _ := hands.Screen(lookPoint{window.X + window.W/2, window.Y + window.H/2})
			window = shotClip(window, screen)
		}
		if !notchMarkSame(window.X, window.Y, window.W, window.H, was.X, was.Y, was.W, was.H) {
			return &RPCResult{Result: map[string]any{"marked": false, "why": "moved"}}, nil
		}
		if !notchMarkFits(r.X, r.Y, r.W, r.H, window.X, window.Y, window.W, window.H) {
			return &RPCResult{Result: map[string]any{"marked": false, "why": "size"}}, nil
		}
		ms, _ := params["ms"].(float64)
		if err := l.Mark(r, notchMarkStay(ms)); err != nil {
			return nil, fmt.Errorf("notch.mark: %w", err)
		}
		// That one was drawn, and how large: never where, and never over what.
		log.Printf("[notch] a mark was drawn over a thing of %d by %d", r.W, r.H)
		return &RPCResult{Result: map[string]any{"marked": true}}, nil
	}
}

// PointClear takes away whatever is being pointed at and sends the pointer
// home. A wait for a click ends with "replaced".
func (l *NotchLook) PointClear() {
	l.mu.Lock()
	hands := l.hands
	l.endWait("replaced")
	if hands != nil {
		hands.PointEnd()
	}
	l.mu.Unlock()
	if hands != nil {
		hands.Watch()
	}
}

// Clicked is a button of the pointer coming up that the look did not keep
// for itself. When a click is waited for, this is it.
func (l *NotchLook) Clicked(x, y int) {
	l.mu.Lock()
	w, hands := l.waiting, l.hands
	if w == nil || hands == nil {
		l.mu.Unlock()
		return
	}
	// A click on the notch itself (to stop, to read what it says) is not a step.
	if hands.Own(lookPoint{x, y}) {
		l.mu.Unlock()
		return
	}
	l.waiting = nil
	// The ring goes at once: it is not left lying over the menu or the window the click opened.
	hands.PointHit()
	l.mu.Unlock()
	w.done <- lookClick{Clicked: true, Inside: lookGrown(w.rect, notchPointSlack).holds(x, y), Why: "click"}
	hands.Watch()
}

// How long a click on a thing that was pointed at is waited for, at the most.
const notchPointMaxWait = 90 * time.Second

// makeNotchPointHandler serves notch.point: the brain asks for the pointer to
// go to something it found in a window's own description of itself.
//
//	{x, y, w, h, label, ms}            go there and ring it for ms
//	{x, y, w, h, label, wait_ms}       the same, and answer only when the
//	                                   person has clicked, or wait_ms is over
//	{clear: true}                      take it away
func makeNotchPointHandler(l *NotchLook) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		if clear, _ := params["clear"].(bool); clear {
			l.PointClear()
			return &RPCResult{Result: map[string]any{"cleared": true}}, nil
		}
		r, label, stay, err := parseNotchPoint(params)
		if err != nil {
			return nil, err
		}
		if ms, ok := params["wait_ms"].(float64); ok && !math.IsNaN(ms) && ms > 0 {
			wait := min(time.Duration(ms)*time.Millisecond, notchPointMaxWait)
			got, err := l.PointWait(r, label, wait)
			if err != nil {
				return nil, fmt.Errorf("notch.point: %w", err)
			}
			// Whether, never where: the place of a click is the person's own.
			log.Printf("[notch] point: waited for a click: %s (clicked %v, on the thing %v)", got.Why, got.Clicked, got.Inside)
			return &RPCResult{Result: map[string]any{"pointed": true, "clicked": got.Clicked, "inside": got.Inside, "why": got.Why}}, nil
		}
		if err := l.Point(r, label, stay); err != nil {
			return nil, fmt.Errorf("notch.point: %w", err)
		}
		return &RPCResult{Result: map[string]any{"pointed": true}}, nil
	}
}

// errNotchLookNotHere is the answer where the look has no platform under it.
var errNotchLookNotHere = fmt.Errorf("looking at the screen is not built for this system yet")

// platformNotchLookWhyNot is the platform's own reason for a look that
// cannot be used, where it has one: on macOS the look is built, and what is
// missing is a permission. Nil where there is no such reason to give.
var platformNotchLookWhyNot func() error

// notchLookMissing is the answer when the look cannot be used: the platform's
// reason when it has one, else that it is not built here. The fourth run on
// a real Mac (19 November 2026) was told "not built for this system yet" for
// what was a missing permission, which sent the reader looking for code that
// was there all along.
func notchLookMissing() error {
	if platformNotchLookWhyNot != nil {
		if err := platformNotchLookWhyNot(); err != nil {
			return err
		}
	}
	return errNotchLookNotHere
}

// makeNotchWindowHandler serves notch.window: what the window the person is
// in says about itself, for "where is...?". Where this program looks away the
// answer says so and holds nothing else.
func makeNotchWindowHandler() RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		result, err := platformNotchWindowRead()
		if err != nil {
			return nil, fmt.Errorf("notch.window: %w", err)
		}
		return &RPCResult{Result: result}, nil
	}
}
