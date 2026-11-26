package main

import (
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func pulseAt(start time.Time, seconds float64) time.Time {
	return start.Add(time.Duration(seconds * float64(time.Second)))
}

// A page that answered and then stopped is gone after the limit, said once,
// and back with its next answer.
func TestNotchPulseAPageThatStopsAnsweringIsGone(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	p.Page(pulseAt(start, 1))
	for s := 1.0; s <= 6; s++ {
		p.Window(pulseAt(start, s))
		if got := p.Beat(pulseAt(start, s)); got.Unseen() || got.PageChanged {
			t.Fatalf("%v s: an answer %v s old is not yet gone: %+v", s, s-1, got)
		}
	}
	p.Window(pulseAt(start, 7))
	got := p.Beat(pulseAt(start, 7))
	if !got.PageGone || !got.PageChanged || got.WindowGone || !got.Unseen() {
		t.Fatalf("six seconds without an answer: %+v", got)
	}
	p.Window(pulseAt(start, 8))
	if got := p.Beat(pulseAt(start, 8)); !got.PageGone || got.PageChanged {
		t.Fatalf("still gone, and said only once: %+v", got)
	}
	p.Page(pulseAt(start, 8.5))
	p.Window(pulseAt(start, 9))
	if got := p.Beat(pulseAt(start, 9)); got.PageGone || !got.PageChanged || got.Unseen() {
		t.Fatalf("it answered again: %+v", got)
	}
}

// A page that has never answered may still be loading, and has said nothing
// about Esc yet. And a way of asking that does not work on some system must
// not take Esc from every page there for good.
func TestNotchPulseAPageThatNeverAnsweredIsNotGone(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	for s := 1.0; s <= 60; s++ {
		p.Window(pulseAt(start, s))
		if got := p.Beat(pulseAt(start, s)); got.Unseen() {
			t.Fatalf("%v s: %+v", s, got)
		}
	}
}

// The window's thread standing still is told apart from the page.
func TestNotchPulseTheWindowsThreadStandingStill(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	var got notchPulseState
	for s := 1.0; s <= 5; s++ {
		if got = p.Beat(pulseAt(start, s)); got.Unseen() {
			t.Fatalf("%v s: %+v", s, got)
		}
	}
	if got = p.Beat(pulseAt(start, 6)); !got.WindowGone || !got.WindowChanged || got.PageGone || !got.Unseen() {
		t.Fatalf("the thread ran nothing for six seconds: %+v", got)
	}
	p.Window(pulseAt(start, 6.5))
	if got = p.Beat(pulseAt(start, 7)); got.WindowGone || !got.WindowChanged {
		t.Fatalf("it runs again: %+v", got)
	}
}

// The machine slept: nobody was asked, so nobody failed to answer.
func TestNotchPulseASleepIsNobodysSilence(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	p.Page(pulseAt(start, 1))
	p.Window(pulseAt(start, 1))
	p.Beat(pulseAt(start, 1))
	if got := p.Beat(pulseAt(start, 3600)); got.Unseen() {
		t.Fatalf("after an hour asleep: %+v", got)
	}
	// And from there the limit counts as before.
	if got := p.Beat(pulseAt(start, 3602)); got.Unseen() {
		t.Fatalf("two seconds after waking: %+v", got)
	}
	if got := p.Beat(pulseAt(start, 3604)); got.Unseen() {
		t.Fatalf("four seconds after waking: %+v", got)
	}
	if got := p.Beat(pulseAt(start, 3606)); !got.WindowGone || !got.PageGone {
		t.Fatalf("six seconds after waking with no sign of either: %+v", got)
	}
}

// pulseWorld is a service with a keyboard, a window's thread and a page, with
// the pulse between them at a hundred times its speed.
type pulseWorld struct {
	svc   *NotchService
	kb    *notchKeyboard
	pulse *notchPulse
	// Whether the thread runs what is put on it, and whether the page answers.
	threadRuns, pageAnswers atomic.Bool
	mu                      sync.Mutex
	held                    []func()
	put                     atomic.Int32
	told                    []notchPulseState
	quit                    chan struct{}
	done                    chan struct{}
}

func newPulseWorld() *pulseWorld {
	w := &pulseWorld{svc: &NotchService{}, quit: make(chan struct{}), done: make(chan struct{})}
	w.kb = newNotchKeyboard(notchDefaultPairs("windows"), func(notchKeyAction) {}, nil)
	w.svc.keys = w.kb
	w.threadRuns.Store(true)
	w.pageAnswers.Store(true)
	w.pulse = newNotchPulse(time.Now())
	w.pulse.limit, w.pulse.gap = 60*time.Millisecond, time.Hour
	onWindow := func(run func()) {
		w.put.Add(1)
		if w.threadRuns.Load() {
			go run()
			return
		}
		w.mu.Lock()
		w.held = append(w.held, run)
		w.mu.Unlock()
	}
	ask := func() {
		if w.pageAnswers.Load() {
			w.pulse.Page(time.Now())
		}
	}
	tell := func(s notchPulseState) {
		w.mu.Lock()
		w.told = append(w.told, s)
		w.mu.Unlock()
		w.svc.setStalled(s.Unseen())
	}
	go func() {
		defer close(w.done)
		notchPulseLoop(w.pulse, w.quit, 5*time.Millisecond, onWindow, ask, tell)
	}()
	return w
}

// The thread runs again, and what was put on it while it stood still with it.
func (w *pulseWorld) threadWakes() {
	w.threadRuns.Store(true)
	w.mu.Lock()
	held := w.held
	w.held = nil
	w.mu.Unlock()
	for _, run := range held {
		run()
	}
}

func (w *pulseWorld) takesEsc() bool {
	w.kb.mu.Lock()
	defer w.kb.mu.Unlock()
	return w.kb.engine.wantEsc
}

func (w *pulseWorld) until(t *testing.T, what string, takes bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for w.takesEsc() != takes {
		if time.Now().After(deadline) {
			t.Fatalf("%s: Esc kept from the app is still %v", what, !takes)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// The owner's case: the page said Esc would do something, and then hung. Esc
// was dead in every app until Jarvis was quit. Now the app in front has it
// back once the page has not answered for the limit, and the notch has it
// again when the page answers.
func TestNotchAPageThatHangsDoesNotKeepEsc(t *testing.T) {
	w := newPulseWorld()
	defer func() { close(w.quit); <-w.done }()
	w.svc.wantEsc(true)
	// It answers: Esc is the notch's, and stays so.
	time.Sleep(150 * time.Millisecond)
	w.until(t, "a page that answers and wants Esc", true)
	w.pageAnswers.Store(false)
	w.until(t, "the page hung", false)
	if w.kb.key(notchKeyEscDown, 0) {
		t.Fatal("Esc was kept from the app in front for a page that does not answer")
	}
	w.kb.key(notchKeyEscUp, 0)
	// What the page said is not forgotten: it wanted Esc, and has it back.
	w.pageAnswers.Store(true)
	w.until(t, "the page answers again", true)
}

// The same when it is the window's thread that stands still, where nothing
// can be asked of the page at all. And a thread that stands still is not left
// a question for every second it stood.
func TestNotchAWindowThreadThatHangsDoesNotKeepEsc(t *testing.T) {
	w := newPulseWorld()
	defer func() { close(w.quit); <-w.done }()
	w.svc.wantEsc(true)
	time.Sleep(50 * time.Millisecond)
	w.threadRuns.Store(false)
	before := w.put.Load()
	w.until(t, "the thread stands still", false)
	time.Sleep(50 * time.Millisecond)
	if put := w.put.Load() - before; put > 2 {
		t.Fatalf("%d questions were put on a thread that runs none of them", put)
	}
	w.mu.Lock()
	windowGone := false
	for _, s := range w.told {
		windowGone = windowGone || (s.WindowGone && s.WindowChanged)
	}
	w.mu.Unlock()
	if !windowGone {
		t.Fatal("it was never said that the window's thread stands still")
	}
	w.threadWakes()
	w.until(t, "the thread runs again", true)
}

// The page goes away while it is not answering: nothing stays held off for
// the page that comes next.
func TestNotchPulseEndingLetsGoOfWhatItHeldOff(t *testing.T) {
	w := newPulseWorld()
	w.svc.wantEsc(true)
	time.Sleep(30 * time.Millisecond)
	w.threadRuns.Store(false)
	w.until(t, "the thread stands still", false)
	close(w.quit)
	<-w.done
	w.mu.Lock()
	last := w.told[len(w.told)-1]
	w.mu.Unlock()
	if !last.Ended || last.Unseen() || !last.WindowChanged {
		t.Fatalf("the last word of a pulse that ends: %+v", last)
	}
	if !w.takesEsc() {
		t.Fatal("Esc is still held off after the pulse ended")
	}
}

// The service's own rule: a page that is not answering holds no Esc, whatever
// it said before, and what it said is kept for when it answers.
func TestAStalledNotchWantsNoEsc(t *testing.T) {
	svc := &NotchService{}
	kb := newNotchKeyboard(notchDefaultPairs("windows"), func(notchKeyAction) {}, nil)
	svc.keys = kb
	wants := func() bool {
		kb.mu.Lock()
		defer kb.mu.Unlock()
		return kb.engine.wantEsc
	}
	svc.wantEsc(true)
	svc.setStalled(true)
	if wants() {
		t.Fatal("the page does not answer: Esc is the app's")
	}
	// Coming back into sight does not give it Esc while it does not answer.
	svc.setHidden(true)
	svc.setHidden(false)
	if wants() {
		t.Fatal("in sight, and still not answering")
	}
	svc.setStalled(false)
	if !wants() {
		t.Fatal("it answers again, and still wants Esc")
	}
	// A new page starts believed.
	svc.setStalled(true)
	svc.detachPage()
	svc.keys = kb
	svc.wantEsc(true)
	if !wants() {
		t.Fatal("what was said of the page before is said of the next one")
	}
}

// The window says "out of sight" on a thread that must not wait. The word is
// put down at once, even while the service cannot be told, and the last word
// is the one that counts.
func TestNotchHideRelayNeverWaitsAndTheLastWordCounts(t *testing.T) {
	gate := make(chan struct{})
	var mu sync.Mutex
	var heard []bool
	r := newNotchHideRelay(func(hidden bool) {
		<-gate
		mu.Lock()
		heard = append(heard, hidden)
		mu.Unlock()
	})
	// Nobody can be told yet (the lock it needs is taken): putting the word
	// down must come back all the same, however often.
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			r.Report(i%2 == 0)
		}
		r.Report(true)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("putting the word down waited for the service")
	}
	close(gate)
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(heard)
		last := n > 0 && heard[n-1]
		mu.Unlock()
		if last {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the last word (hidden) never arrived: %v", heard)
		}
		time.Sleep(time.Millisecond)
	}
	// And the other way round.
	r.Report(false)
	deadline = time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		last := heard[len(heard)-1]
		mu.Unlock()
		if !last {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("in sight again never arrived")
		}
		time.Sleep(time.Millisecond)
	}
}

// On a Mac the window hides by itself, in its own code, and the service was
// never told: a hidden notch kept Esc from the film and took a yes for a
// sheet nobody saw. Through the relay it is told, and then both rules hold as
// they do on Windows.
func TestNotchAWindowThatHidesByItselfTakesNoEscAndNoYes(t *testing.T) {
	svc := &NotchService{}
	var said []notchKeyAction
	kb := newNotchKeyboard(notchDefaultPairs("darwin"), func(action notchKeyAction) {
		// As NotchService.watchKeys says it.
		if action == notchKeyYes && svc.isHidden() {
			return
		}
		said = append(said, action)
	}, nil)
	svc.keys = kb
	svc.wantEsc(true)
	relay := newNotchHideRelay(svc.setHidden)
	settle := func(hidden bool) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for svc.isHidden() != hidden {
			if time.Now().After(deadline) {
				t.Fatalf("the service never heard hidden=%v", hidden)
			}
			time.Sleep(time.Millisecond)
		}
	}
	yes := notchDefaultPairs("darwin").Yes
	tapYes := func() {
		kb.key(notchKeyModifiers, yes[0])
		kb.key(notchKeyModifiers, yes[0]|yes[1])
		kb.key(notchKeyModifiers, yes[0])
		kb.key(notchKeyModifiers, 0)
	}
	relay.Report(true)
	settle(true)
	if kb.key(notchKeyEscDown, 0) {
		t.Fatal("a hidden notch kept Esc from the film")
	}
	kb.key(notchKeyEscUp, 0)
	tapYes()
	if len(said) != 0 {
		t.Fatalf("a hidden notch took %v", said)
	}
	relay.Report(false)
	settle(false)
	tapYes()
	if len(said) != 1 || said[0] != notchKeyYes {
		t.Fatalf("in sight again, a yes is a yes: %v", said)
	}
}

// The Mac's window cannot be built here, so that it tells at all is held to
// in its text: the timer that hides it says so, a window that is set up or
// taken down is not a hidden one, and a hidden one does not take the keyboard.
func TestNotchMacWindowSaysWhenItHides(t *testing.T) {
	raw, err := os.ReadFile("notch_host_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{
		"jarvis_notch_hidden = hide;\n    // Out of sight, it takes no Esc and no yes (NotchService.setHidden).\n    goNotchHidden(hide ? 1 : 0);",
		"jarvis_notch_hidden = NO;\n        goNotchHidden(0);",
		"if (take && jarvis_notch_hidden) return;",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("notch_host_darwin.go no longer has:\n%s", want)
		}
	}
	bridge, err := os.ReadFile("notch_host_bridge_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(bridge), "notchHidden.Report(hidden != 0)") {
		t.Fatal("the window's word no longer goes through the relay: on the main thread nothing else may be done with it")
	}
}
