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
	"log"
	"sync"
	"time"
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

type lookTaken struct {
	line   *lookLine
	points []lookPoint
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
// it does: an app on the person's list, a bank, or any window at all while a
// password is being typed (notch_where.go).
func notchLookAway(app, title string) string {
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
// down, or the button that began a line has not come up yet.
func (l *NotchLook) Wants() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.hands != nil && (l.pen.Armed() || l.pen.Busy())
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
	l.mu.Unlock()
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
		job = &lookTaken{line: l.line, points: v.Taken}
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
	return things
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
			l.mu.Unlock()
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
	if line.refused != "" {
		ink("", notchLookInkDropped)
		send(notchLookPayload("taken", line.id, how, line.refused, 0, bounds, lookRect{}), nil)
		return
	}
	things := lookHolds(hands, job.points, false)
	ink(lookTag(things), notchLookInkStay)
	// What was circled is where the things are, when any were found: a sloppy
	// circle round the left end of three rows is a picture of the three rows.
	seen := bounds
	for _, thing := range things {
		seen = lookUnion(seen, thing.Rect)
	}
	middle := lookPoint{bounds.X + bounds.W/2, bounds.Y + bounds.H/2}
	app, title := hands.Front(middle)
	var picture []byte
	part := lookRect{}
	if line.snapshot != nil {
		part = lookPictureRect(seen, line.screen)
		picture = line.snapshot.Cut(part)
		if picture == nil {
			part = lookRect{}
		}
		// The copy of the whole display is let go as soon as the picture is cut.
		line.snapshot = nil
	}
	body, err := notchLookBody(notchLookTold{App: app, Title: lookClean(title), Things: things}, picture)
	if err != nil {
		log.Printf("[notch] look: what was read could not be packed: %v", err)
		return
	}
	// Counts and sizes, never what was read.
	log.Printf("[notch] look: %s, %d thing(s), picture %d bytes", how, len(things), len(picture))
	send(notchLookPayload("taken", line.id, how, "", len(things), bounds, part), body)
}
