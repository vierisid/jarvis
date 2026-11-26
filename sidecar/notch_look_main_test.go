package main

import (
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// On a Mac the taps on the keyboard and on the pointer are served by the main
// thread, and inside them the main thread takes the look's lock, the hands'
// lock and the keyboard's. So a goroutine that holds one of those and waits
// for the main thread is the end: the main thread waits for the lock, the
// goroutine waits for the main thread, and the app, its tray and its page
// stand still for good, with nothing in the log.
//
// The Mac's hands did exactly that: sending a pointer home asked the system
// how tall the camera housing is, on the main thread, with both locks held.
//
// The Mac's own code cannot be built or run here, so these tests put the real
// look, the real keyboard and the real service round a pair of hands that
// takes its lock where the Mac's do (notch_look_darwin.go), and a goroutine
// that stands in for the main thread. Each case holds the main thread at the
// worst moment: inside home, with every lock home is called under.

// fakeMain runs what is put on it, one thing after another, as a main thread
// does its queue.
type fakeMain struct{ queue chan func() }

func newFakeMain() *fakeMain {
	m := &fakeMain{queue: make(chan func(), 64)}
	go func() {
		for run := range m.queue {
			run()
		}
	}()
	return m
}

// async is dispatch_async: put down and left.
func (m *fakeMain) async(run func()) { m.queue <- run }

// sync is dispatch_sync: put down and waited for.
func (m *fakeMain) sync(run func()) {
	done := make(chan struct{})
	m.queue <- func() { run(); close(done) }
	<-done
}

// idle reports whether the main thread gets round to something new in time.
func (m *fakeMain) idle(within time.Duration) bool {
	done := make(chan struct{})
	m.queue <- func() { close(done) }
	select {
	case <-done:
		return true
	case <-time.After(within):
		return false
	}
}

// macLikeHands takes its lock where lookMac does, and goes home where lookMac
// does. What it reads of the screen is fakeHands'.
type macLikeHands struct {
	*fakeHands
	look *NotchLook
	// lookMac.mu
	lock sync.Mutex
	gen  int
	// How long after a ring the pointer goes home by itself, when a test sets
	// it; otherwise as long as the ring was asked to stay.
	ringFor time.Duration
	// How home learns how tall the housing is.
	housing func()
	// Called inside home, so with every lock held that home is called under.
	atHome atomic.Pointer[func()]
	homes  atomic.Int32
	// Closed when a timer has gone home.
	timed chan struct{}
}

func (h *macLikeHands) home() {
	h.homes.Add(1)
	if hook := h.atHome.Load(); hook != nil {
		(*hook)()
	}
	h.housing()
}

func (h *macLikeHands) after(wait time.Duration, gen int, run func()) {
	time.AfterFunc(wait, func() {
		h.lock.Lock()
		defer h.lock.Unlock()
		if h.gen == gen {
			run()
			select {
			case h.timed <- struct{}{}:
			default:
			}
		}
	})
}

func (h *macLikeHands) Watch()                { h.look.Wants() }
func (h *macLikeHands) Own(at lookPoint) bool { return false }
func (h *macLikeHands) locked()               { h.lock.Lock(); h.lock.Unlock() }
func (h *macLikeHands) InkBegin(at lookPoint, screen lookRect, scale float64) {
	h.locked()
}
func (h *macLikeHands) InkLine(from, to lookPoint)          { h.locked() }
func (h *macLikeHands) InkTag(text string, bounds lookRect) { h.locked() }
func (h *macLikeHands) InkEnd(stay time.Duration)           { h.locked() }
func (h *macLikeHands) Hover(text string, at lookPoint)     {}
func (h *macLikeHands) Point(r lookRect, label string, stay time.Duration) {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.gen++
	h.home()
	if h.ringFor > 0 {
		stay = h.ringFor
	}
	h.after(stay, h.gen, h.home)
}
func (h *macLikeHands) PointHit() {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.gen++
	h.after(time.Hour, h.gen, h.home)
}
func (h *macLikeHands) PointEnd() {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.gen++
	h.home()
}
func (h *macLikeHands) HandTo(n int, at lookPoint, beside bool) time.Duration {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.gen++
	h.home()
	h.after(time.Hour, h.gen, h.home)
	return 0
}
func (h *macLikeHands) HandsHome() {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.gen++
	h.home()
}

// mainWorld is one look with its keyboard and its service, and a main thread.
type mainWorld struct {
	look  *NotchLook
	hands *macLikeHands
	kb    *notchKeyboard
	main  *fakeMain
}

// newMainWorld: asks says whether home asks the main thread for the housing
// and waits (what the Mac's hands did), or reads what was kept.
func newMainWorld(asks bool) *mainWorld {
	w := &mainWorld{look: newNotchLook(), main: newFakeMain()}
	w.hands = &macLikeHands{fakeHands: &fakeHands{}, look: w.look, timed: make(chan struct{}, 1)}
	if asks {
		w.hands.housing = func() { w.main.sync(func() {}) }
	} else {
		w.hands.housing = func() { notchHousingKept() }
	}
	w.look.Use(w.hands, nil, func(map[string]any, []byte) {})
	// The service as the keys tell it: a script for the page is put on the
	// main thread and left, as a web view's Dispatch does.
	svc := &NotchService{}
	svc.attachPage(func(string) { w.main.async(func() {}) })
	w.kb = newNotchKeyboard(notchDefaultPairs("darwin"), func(action notchKeyAction) {
		if action == notchKeyYes && svc.isHidden() {
			return
		}
		svc.runInPage(notchKeyScript(action))
	}, nil)
	w.kb.look = w.look
	return w
}

// waitedFor starts a wait for a click and comes back once it is waited for.
func (w *mainWorld) waitedFor(t *testing.T) {
	t.Helper()
	go w.look.PointWait(lookRect{100, 100, 40, 20}, "here", time.Hour)
	deadline := time.Now().Add(2 * time.Second)
	for !w.look.Wants() {
		if time.Now().After(deadline) {
			t.Fatal("the wait for a click never began")
		}
		time.Sleep(time.Millisecond)
	}
}

type mainOrder struct {
	name string
	// What is set up first, with nothing held.
	before func(t *testing.T, w *mainWorld)
	// Which going home is the one the main thread is busy at (1 is the first
	// after before).
	at int32
	// What a goroutine does: an RPC of the brain's, or nothing when a timer
	// set in before does it.
	goroutine func(w *mainWorld)
	// A timer goes home by itself.
	timer bool
	// What the main thread does meanwhile, inside a tap.
	mainDoes func(w *mainWorld)
}

var (
	mainMoves = func(w *mainWorld) { w.look.Move(5, 5) }
	mainEsc   = func(w *mainWorld) {
		w.kb.key(notchKeyEscDown, 0)
		w.kb.key(notchKeyEscUp, 0)
	}
	mainShift  = func(w *mainWorld) { w.kb.key(notchKeyModifiers, notchModShift) }
	mainClicks = func(w *mainWorld) { w.look.Clicked(900, 900) }
	aRect      = lookRect{100, 100, 40, 20}
)

// Every order the fix design names, and the taps each can meet.
func mainOrders() []mainOrder {
	var orders []mainOrder
	taps := map[string]func(*mainWorld){"the pointer moves": mainMoves, "Esc": mainEsc, "Shift goes down": mainShift, "a click": mainClicks}
	for tap, does := range taps {
		orders = append(orders,
			// The look's lock and the hands' lock, on a goroutine.
			mainOrder{name: "point while " + tap, at: 1, mainDoes: does,
				goroutine: func(w *mainWorld) { w.look.Point(aRect, "here", time.Hour) }},
			mainOrder{name: "a wait for a click begins while " + tap, at: 1, mainDoes: does,
				goroutine: func(w *mainWorld) { w.look.PointWait(aRect, "here", 30*time.Millisecond) }},
			mainOrder{name: "a wait for a click runs out while " + tap, at: 2, mainDoes: does,
				goroutine: func(w *mainWorld) { w.look.PointWait(aRect, "here", 30*time.Millisecond) }},
			mainOrder{name: "the pointing is cleared while " + tap, at: 1, mainDoes: does,
				goroutine: func(w *mainWorld) { w.look.PointClear() }},
			mainOrder{name: "the look is forgotten while " + tap, at: 1, mainDoes: does,
				goroutine: func(w *mainWorld) { w.look.Forget() }},
		)
	}
	// The hands' lock alone: a timer's goroutine, or a job's. The main thread
	// meets it in a click that is waited for (Clicked, then PointHit).
	orders = append(orders,
		mainOrder{name: "a ring's time is up while a waited click comes", at: 2, timer: true, mainDoes: mainClicks,
			before: func(t *testing.T, w *mainWorld) { w.hands.ringFor = 20 * time.Millisecond },
			goroutine: func(w *mainWorld) {
				go w.look.PointWait(aRect, "here", time.Hour)
			}},
		mainOrder{name: "a hand is sent out while a waited click comes", at: 1, mainDoes: mainClicks,
			before:    func(t *testing.T, w *mainWorld) { w.waitedFor(t) },
			goroutine: func(w *mainWorld) { w.hands.HandTo(0, lookPoint{300, 300}, false) }},
		mainOrder{name: "the hands go home while a waited click comes", at: 1, mainDoes: mainClicks,
			before:    func(t *testing.T, w *mainWorld) { w.waitedFor(t) },
			goroutine: func(w *mainWorld) { w.hands.HandsHome() }},
	)
	return orders
}

// run plays one order and reports whether everybody got through: the
// goroutine, the timer, and the main thread.
func (o mainOrder) run(t *testing.T, asks bool, within time.Duration) (through bool) {
	t.Helper()
	w := newMainWorld(asks)
	if o.before != nil {
		o.before(t, w)
	}
	base := w.hands.homes.Load()
	var met atomic.Bool
	hook := func() {
		if w.hands.homes.Load()-base != o.at || !met.CompareAndSwap(false, true) {
			return
		}
		// The main thread is given its tap now, and is inside it before home
		// goes on: it is waiting for a lock this goroutine holds, or about to.
		begun := make(chan struct{})
		w.main.async(func() {
			close(begun)
			o.mainDoes(w)
		})
		<-begun
		time.Sleep(5 * time.Millisecond)
	}
	w.hands.atHome.Store(&hook)
	done := make(chan struct{})
	go func() {
		o.goroutine(w)
		close(done)
	}()
	limit := time.After(within)
	select {
	case <-done:
	case <-limit:
		return false
	}
	if o.timer {
		select {
		case <-w.hands.timed:
		case <-limit:
			return false
		}
	}
	if !met.Load() {
		t.Fatalf("%s: the main thread was never given its tap: the case tests nothing", o.name)
	}
	return w.main.idle(within)
}

// The fix: nothing that holds the look's lock or the hands' lock waits for
// the main thread, whatever the main thread is doing at that moment.
func TestNotchLookHandsNeverWaitOnTheMainThread(t *testing.T) {
	for _, order := range mainOrders() {
		t.Run(order.name, func(t *testing.T) {
			t.Parallel()
			if !order.run(t, false, 5*time.Second) {
				t.Fatal("the goroutine and the main thread are waiting for each other")
			}
		})
	}
}

// And the same cases with hands that ask the main thread and wait, as the
// Mac's did: every one of them stands still. This is what says the cases
// above meet the main thread where it matters, and are not passing because
// they miss it.
func TestNotchLookHandsThatAskTheMainThreadStandStill(t *testing.T) {
	for _, order := range mainOrders() {
		t.Run(order.name, func(t *testing.T) {
			t.Parallel()
			if order.run(t, true, 300*time.Millisecond) {
				t.Fatal("hands that wait for the main thread under a lock got through: the case does not hold the main thread where it should")
			}
		})
	}
}

// The Mac's hands cannot be built here, so what they must not do is also held
// to in their text: home reads the housing as it was kept, and nothing in the
// file asks the system for it. It is asked on the main thread and waited for.
func TestNotchLookMacHomeAsksNobodyForTheHousing(t *testing.T) {
	raw, err := os.ReadFile("notch_look_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, "platformNotchHousing(") {
		t.Fatal("notch_look_darwin.go asks the system for the housing: that waits for the main thread, and it is called with the look's lock and the hands' lock held")
	}
	if !strings.Contains(text, "notchHousingKept()") {
		t.Fatal("notch_look_darwin.go no longer reads the housing as it was kept")
	}
	if strings.Contains(text, "dispatch_sync(") {
		t.Fatal("notch_look_darwin.go waits for the main thread: every one of its hands is called with a lock held")
	}
}

// What is kept is what was last read, and reading it back waits for nobody.
func TestNotchHousingIsKeptAsItWasRead(t *testing.T) {
	old := notchHousingSeen.Load()
	defer notchHousingSeen.Store(old)
	notchHousingSeen.Store(0)
	if w, h := notchHousingKept(); w != 0 || h != 0 {
		t.Fatalf("nothing read yet: %d, %d", w, h)
	}
	notchHousingSeen.Store(uint64(185)<<32 | uint64(32))
	if w, h := notchHousingKept(); w != 185 || h != 32 {
		t.Fatalf("kept %d, %d", w, h)
	}
	// A reading is kept. Not on a Mac: there the reading is asked of the main
	// thread and waited for, and a test has no main thread that answers.
	if runtime.GOOS == "darwin" {
		return
	}
	if w, h := notchHousingLook(); w != 0 || h != 0 {
		t.Fatalf("read %d, %d", w, h)
	}
	if w, h := notchHousingKept(); w != 0 || h != 0 {
		t.Fatalf("kept %d, %d after a reading of none", w, h)
	}
}
