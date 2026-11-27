package main

import (
	"log"
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

// A page that has answered the question once, wants Esc and stops answering
// is gone after the limit, said once, and back with its next answer.
func TestNotchPulseAPageThatStopsAnsweringIsGone(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	p.Alive(pulseAt(start, 0.5))
	p.Esc(true, pulseAt(start, 1))
	for s := 1.0; s <= 6; s++ {
		p.Window(pulseAt(start, s))
		if got := p.Beat(pulseAt(start, s)); got.Unseen() || got.PageChanged {
			t.Fatalf("%v s: a sign %v s old is not yet gone: %+v", s, s-1, got)
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
	p.Alive(pulseAt(start, 8.5))
	p.Window(pulseAt(start, 9))
	if got := p.Beat(pulseAt(start, 9)); got.PageGone || !got.PageChanged || got.Unseen() {
		t.Fatalf("it answered again: %+v", got)
	}
}

// Asking has to be seen to work before silence means anything. In a web view
// where the question never comes back, every page would be silent, and Esc
// would be taken from every sheet five seconds after it came up: Esc is what
// stops a fuse that is burning. So a page that has never answered the
// question keeps Esc as it said, however long it is silent and whatever else
// it calls; it is asked whatever it wants for thirty seconds; and then it is
// said once that nothing watches it, and it is asked no more.
func TestNotchPulseAPageThatNeverAnsweredTheQuestionKeepsEsc(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	if !p.Asking() {
		t.Fatal("a page just attached is asked, whether it wants Esc or not: that is how asking is seen to work")
	}
	p.Esc(true, pulseAt(start, 1))
	// Its other calls are signs of it, and prove nothing about the asking.
	p.Page(pulseAt(start, 2))
	offs := 0
	for s := 1.0; s <= 120; s++ {
		p.Window(pulseAt(start, s))
		got := p.Beat(pulseAt(start, s))
		if got.Unseen() {
			t.Fatalf("%v s: a page that never answered the question lost Esc: %+v", s, got)
		}
		if got.PingProven {
			t.Fatalf("%v s: nothing was answered, and asking is said to work", s)
		}
		if got.PingOff {
			offs++
			if s <= 30 {
				t.Fatalf("given up after %v s", s)
			}
		}
		if want := s <= 30; p.Asking() != want {
			t.Fatalf("%v s: asked = %v", s, !want)
		}
	}
	if offs != 1 {
		t.Fatalf("that nothing watches this page is said once, got %d times", offs)
	}
}

// And the first answer is what turns it on, said once.
func TestNotchPulseTheFirstAnswerProvesTheAsking(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	p.Esc(true, pulseAt(start, 1))
	p.Window(pulseAt(start, 1))
	if got := p.Beat(pulseAt(start, 1)); got.PingProven {
		t.Fatalf("nothing answered yet: %+v", got)
	}
	p.Alive(pulseAt(start, 1.5))
	p.Window(pulseAt(start, 2))
	if got := p.Beat(pulseAt(start, 2)); !got.PingProven || got.Unseen() {
		t.Fatalf("the first answer: %+v", got)
	}
	said := 0
	var got notchPulseState
	for s := 3.0; s <= 40; s++ {
		p.Window(pulseAt(start, s))
		got = p.Beat(pulseAt(start, s))
		if got.PingProven {
			said++
		}
		if got.PingOff {
			t.Fatalf("%v s: given up on a page that answered", s)
		}
	}
	if said != 0 {
		t.Fatalf("said %d more times", said)
	}
	if !got.PageGone {
		t.Fatalf("proven, wanting Esc, and silent since: %+v", got)
	}
	// It wants none after all: it is no longer asked.
	p.Esc(false, pulseAt(start, 41))
	if p.Asking() {
		t.Fatal("a page that has shown it can be asked, and wants no Esc, is left alone")
	}
}

// The two lines the log gets, each once: that asking works for this page,
// or that it does not and nothing watches the page.
func TestNotchPulseSaysOnceWhetherThePageIsWatched(t *testing.T) {
	var out strings.Builder
	old := log.Writer()
	log.SetOutput(&out)
	defer log.SetOutput(old)
	svc := &NotchService{}
	hold := func(bool) { t.Fatal("nothing of the platform's is held off for this") }
	notchPulseTellTo(svc, notchPulseState{PingOff: true}, hold, time.Now())
	if got := out.String(); strings.Count(got, "\n") != 1 || !strings.Contains(got, "nothing watches this page") || !strings.Contains(got, "Esc stays as the page says") {
		t.Fatalf("the log, when asking does not work: %q", got)
	}
	out.Reset()
	notchPulseTellTo(svc, notchPulseState{PingProven: true}, hold, time.Now())
	if got := out.String(); strings.Count(got, "\n") != 1 || !strings.Contains(got, "the page answers when asked") {
		t.Fatalf("the log, when asking works: %q", got)
	}
	if svc.stalled {
		t.Fatal("neither word takes Esc from the page")
	}
}

// A page that has answered the question once, and later says it wants Esc
// and hangs at once, is held to answering from the moment it said so: saying
// so is a sign like an answer, and the limit counts from it, however long
// the page has been up.
func TestNotchPulseAPageThatWantsEscAndHangsAtOnceIsGone(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	p.Alive(pulseAt(start, 0.5))
	for s := 1.0; s <= 100; s++ {
		p.Window(pulseAt(start, s))
		p.Beat(pulseAt(start, s))
	}
	p.Esc(true, pulseAt(start, 100.5))
	for s := 101.0; s <= 105; s++ {
		p.Window(pulseAt(start, s))
		if got := p.Beat(pulseAt(start, s)); got.Unseen() {
			t.Fatalf("%v s: it said so half a second ago and is already gone: %+v", s, got)
		}
	}
	p.Window(pulseAt(start, 106))
	if got := p.Beat(pulseAt(start, 106)); !got.PageGone || !got.PageChanged {
		t.Fatalf("it wanted Esc and has given no sign since, for the limit: %+v", got)
	}
	// And it says it wants none after all: nothing is held against it.
	p.Esc(false, pulseAt(start, 106.5))
	p.Window(pulseAt(start, 107))
	if got := p.Beat(pulseAt(start, 107)); got.Unseen() {
		t.Fatalf("a page that wants no Esc cannot be gone: %+v", got)
	}
}

// A page that wants no Esc has said nothing that could be wrong, so its
// silence means nothing: while it loads, while it rests, while it is hidden.
func TestNotchPulseAPageThatWantsNoEscIsNeverGone(t *testing.T) {
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
	p.Window(start)
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

// The pulse is made before the window's loop runs, and a window can be slow
// to start (the first one of a cold program). A thread that has not run yet
// has not stopped: there is nothing to hold off and nothing to write down.
func TestNotchPulseAWindowThatHasNotStartedIsNotGone(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	for s := 1.0; s <= 60; s++ {
		if got := p.Beat(pulseAt(start, s)); got.Unseen() {
			t.Fatalf("%v s, and the thread has never run: %+v", s, got)
		}
	}
	p.Window(pulseAt(start, 61))
	for s := 62.0; s <= 66; s++ {
		if got := p.Beat(pulseAt(start, s)); got.Unseen() {
			t.Fatalf("%v s: %+v", s, got)
		}
	}
	if got := p.Beat(pulseAt(start, 67)); !got.WindowGone {
		t.Fatalf("it ran once and then nothing for six seconds: %+v", got)
	}
}

// The machine slept: nobody was asked, so nobody failed to answer.
func TestNotchPulseASleepIsNobodysSilence(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
	p.Alive(pulseAt(start, 0.5))
	p.Esc(true, pulseAt(start, 1))
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

// What every goroutine is doing is written at most once in ten minutes, and
// five times in all.
func TestNotchStacksAreNotWrittenOverAndOver(t *testing.T) {
	var d notchDumpLimit
	start := time.Unix(1000, 0)
	if !d.allow(start) {
		t.Fatal("the first time is written")
	}
	if d.allow(start.Add(9 * time.Minute)) {
		t.Fatal("written again within ten minutes")
	}
	at := start
	for i := 2; i <= notchDumpMost; i++ {
		at = at.Add(notchDumpEvery)
		if !d.allow(at) {
			t.Fatalf("time %d, ten minutes after the one before, was not written", i)
		}
	}
	if d.allow(at.Add(24 * time.Hour)) {
		t.Fatalf("written more than %d times in one life of the program", notchDumpMost)
	}
}

// pulseWorld is a service with a keyboard, a window's thread and a page, with
// the pulse between them at twenty times its speed, and what is done about
// a change done as the app does it (notchPulseTellTo).
type pulseWorld struct {
	svc   *NotchService
	kb    *notchKeyboard
	pulse *notchPulse
	// Whether the thread runs what is put on it, and whether the page answers.
	threadRuns, pageAnswers atomic.Bool
	mu                      sync.Mutex
	parked                  []func()
	put, asked              atomic.Int32
	told                    []notchPulseState
	// What the platform was told about holding its taps off.
	holds []bool
	quit  chan struct{}
	done  chan struct{}
}

func newPulseWorld() *pulseWorld {
	w := &pulseWorld{svc: &NotchService{}, quit: make(chan struct{}), done: make(chan struct{})}
	w.kb = newNotchKeyboard(notchDefaultPairs("windows"), func(notchKeyAction) {}, nil)
	w.svc.keys = w.kb
	w.threadRuns.Store(true)
	w.pageAnswers.Store(true)
	w.pulse = newNotchPulse(time.Now())
	w.pulse.limit, w.pulse.gap, w.pulse.proveWithin = 250*time.Millisecond, time.Hour, 600*time.Millisecond
	onWindow := func(run func()) {
		w.put.Add(1)
		if w.threadRuns.Load() {
			go run()
			return
		}
		w.mu.Lock()
		w.parked = append(w.parked, run)
		w.mu.Unlock()
	}
	ask := func() {
		w.asked.Add(1)
		if w.pageAnswers.Load() {
			w.pulse.Alive(time.Now())
		}
	}
	tell := func(s notchPulseState) {
		w.mu.Lock()
		w.told = append(w.told, s)
		w.mu.Unlock()
		notchPulseTellTo(w.svc, s, func(stalled bool) {
			w.mu.Lock()
			w.holds = append(w.holds, stalled)
			w.mu.Unlock()
		}, time.Now())
	}
	go func() {
		defer close(w.done)
		notchPulseLoop(w.pulse, w.quit, 10*time.Millisecond, onWindow, ask, tell)
	}()
	return w
}

// The page says whether it wants Esc, as its call does (bindNotch).
func (w *pulseWorld) wantEsc(want bool) {
	w.pulse.Esc(want, time.Now())
	w.svc.wantEsc(want)
}

// The thread runs again, and what was put on it while it stood still with it.
func (w *pulseWorld) threadWakes() {
	w.threadRuns.Store(true)
	w.mu.Lock()
	parked := w.parked
	w.parked = nil
	w.mu.Unlock()
	for _, run := range parked {
		run()
	}
}

func (w *pulseWorld) takesEsc() bool {
	w.kb.mu.Lock()
	defer w.kb.mu.Unlock()
	return w.kb.engine.wantEsc
}

func (w *pulseWorld) held() []bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]bool(nil), w.holds...)
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
	w.wantEsc(true)
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
	if held := w.held(); len(held) != 0 {
		t.Fatalf("the page hung, not the window's thread: nothing of the platform's is held off, got %v", held)
	}
}

// The other side of it: in a web view where the question never comes back,
// a page that wants Esc keeps it, as it did before there was a pulse. It is
// asked for a while whatever it wants, then it is said once that nothing
// watches it, and it is asked no more.
func TestNotchAPageThatCannotBeAskedKeepsEsc(t *testing.T) {
	w := newPulseWorld()
	defer func() { close(w.quit); <-w.done }()
	w.pageAnswers.Store(false)
	w.wantEsc(true)
	offs := func() (n int) {
		w.mu.Lock()
		defer w.mu.Unlock()
		for _, s := range w.told {
			if s.PingOff {
				n++
			}
		}
		return n
	}
	deadline := time.Now().Add(5 * time.Second)
	for offs() == 0 {
		if !w.takesEsc() {
			t.Fatal("a page that never answered the question lost Esc")
		}
		if time.Now().After(deadline) {
			t.Fatal("it was never said that nothing watches this page")
		}
		time.Sleep(2 * time.Millisecond)
	}
	if w.asked.Load() == 0 {
		t.Fatal("it was never asked: asking cannot be seen to work that way")
	}
	asked := w.asked.Load()
	// Well past the limit for a page that is watched.
	time.Sleep(400 * time.Millisecond)
	if !w.takesEsc() {
		t.Fatal("a page that never answered the question lost Esc after it was given up on")
	}
	if n := offs(); n != 1 {
		t.Fatalf("said %d times", n)
	}
	if more := w.asked.Load() - asked; more > 1 {
		t.Fatalf("asked %d more times after it was given up on", more)
	}
}

// A page is asked until it has answered once, whatever it wants. After that
// it is asked only while it wants Esc.
func TestNotchAPageIsAskedOnlyWhileItWantsEsc(t *testing.T) {
	w := newPulseWorld()
	defer func() { close(w.quit); <-w.done }()
	deadline := time.Now().Add(3 * time.Second)
	for w.pulse.Asking() {
		if time.Now().After(deadline) {
			t.Fatal("a page that answers is still asked although it wants no Esc")
		}
		time.Sleep(2 * time.Millisecond)
	}
	if w.asked.Load() == 0 {
		t.Fatal("a page just attached was never asked")
	}
	asked, put := w.asked.Load(), w.put.Load()
	time.Sleep(80 * time.Millisecond)
	if more := w.asked.Load() - asked; more > 1 {
		t.Fatalf("a page that wants no Esc was asked %d more times after its first answer", more)
	}
	if w.put.Load() == put {
		t.Fatal("the window's thread is given something every beat all the same: that is how it is known to run")
	}
	asked = w.asked.Load()
	w.wantEsc(true)
	deadline = time.Now().Add(3 * time.Second)
	for w.asked.Load() <= asked+1 {
		if time.Now().After(deadline) {
			t.Fatal("a page that wants Esc was not asked")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// The same when it is the window's thread that stands still, where nothing
// can be asked of the page at all. The platform is told to hold its taps
// off, and to let them go when the thread runs again. And a thread that
// stands still is not left a question for every second it stood.
func TestNotchAWindowThreadThatHangsDoesNotKeepEsc(t *testing.T) {
	w := newPulseWorld()
	defer func() { close(w.quit); <-w.done }()
	w.wantEsc(true)
	time.Sleep(50 * time.Millisecond)
	w.threadRuns.Store(false)
	before := w.put.Load()
	w.until(t, "the thread stands still", false)
	time.Sleep(50 * time.Millisecond)
	if put := w.put.Load() - before; put > 2 {
		t.Fatalf("%d questions were put on a thread that runs none of them", put)
	}
	if held := w.held(); len(held) != 1 || !held[0] {
		t.Fatalf("the platform is told once to hold its taps off, got %v", held)
	}
	w.threadWakes()
	w.until(t, "the thread runs again", true)
	deadline := time.Now().Add(3 * time.Second)
	for len(w.held()) < 2 {
		if time.Now().After(deadline) {
			t.Fatal("the platform was never told to let its taps go")
		}
		time.Sleep(2 * time.Millisecond)
	}
	if held := w.held(); len(held) != 2 || held[1] {
		t.Fatalf("held off, then let go: %v", held)
	}
}

// The page goes away while the thread stands still. The taps are let go, and
// Esc is NOT handed back to the page for the moment before the service
// forgets it: it is still a page that does not answer.
func TestNotchPulseEndingLetsTheTapsGoAndGivesNoEscBack(t *testing.T) {
	w := newPulseWorld()
	w.wantEsc(true)
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
	if held := w.held(); len(held) != 2 || !held[0] || held[1] {
		t.Fatalf("held off, then let go at the end: %v", held)
	}
	if w.takesEsc() {
		t.Fatal("Esc was given back to a page that is not answering, between the end of the pulse and the page going away")
	}
	// The page goes, and what was said of it with it (bindNotch's stop).
	w.svc.detachPage()
	w.svc.keys = w.kb
	w.svc.wantEsc(true)
	if !w.takesEsc() {
		t.Fatal("the next page starts believed")
	}
}

// After the watch on the keyboard was held off, only what went stale is put
// right. Somebody who was talking through it, with the pair still down, is
// still talking; a pair let go meanwhile ends the talking as letting go does.
func TestNotchKeyboardResyncEndsNoTalkingThatIsStillHeld(t *testing.T) {
	var h notchHeard
	kb := newNotchKeyboard(notchTestPairs, h.say, h.mask)
	talk := notchTestPairs.Talk[0] | notchTestPairs.Talk[1]
	kb.key(notchKeyModifiers, notchTestPairs.Talk[0])
	kb.key(notchKeyModifiers, talk)
	// The hold has lasted long enough to be talking.
	kb.mu.Lock()
	kb.start = kb.start.Add(-2 * time.Second)
	kb.mu.Unlock()
	kb.tick()
	said, _ := h.got()
	if len(said) != 1 || said[0] != notchKeyTalkStart {
		t.Fatalf("talking did not begin: %v", said)
	}
	kb.resync(talk, false)
	if said, _ := h.got(); len(said) != 1 {
		t.Fatalf("the pair is still down, and the talking was ended: %v", said)
	}
	kb.resync(0, false)
	if said, _ := h.got(); len(said) != 2 || said[1] != notchKeyTalkEnd {
		t.Fatalf("the pair was let go meanwhile: the talking ends as it does when it is let go, got %v", said)
	}
	// An Esc that was kept going down, and came up unseen, is not still down.
	kb.wantEsc(true)
	if !kb.key(notchKeyEscDown, 0) {
		t.Fatal("Esc is wanted and was not kept")
	}
	kb.resync(0, false)
	kb.mu.Lock()
	stillHeld := kb.engine.escHeld
	kb.mu.Unlock()
	if stillHeld {
		t.Fatal("Esc came up unseen and is still taken to be down")
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

// On a Mac the window hid by itself, in its own code, and the service was
// never told: a hidden notch kept Esc from the film and took a yes for a
// sheet nobody saw. Now the window's timer only says what it sees, through
// the relay, and the one rule (notchHost) hides it and tells the service;
// both rules then hold as they do on Windows. A question brings it back, and
// with it Esc and yes.
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
	win := &notchFakeWin{grants: true}
	host := newNotchHost(win, svc.setHidden)
	host.Loaded()
	// As goNotchFacts reports them: on the Mac the app in front keeping the
	// display awake is also how a video is known.
	relay := newNotchFactsRelay(func(f notchHostFacts) { host.Tick(f) })
	mac := func(fullscreen, awake bool) notchHostFacts {
		return notchHostFacts{FullscreenInFront: fullscreen, DisplayKeptAwake: awake, VideoPlaying: awake}
	}
	settle := func(hidden bool) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for svc.isHidden() != hidden || win.seen() == hidden {
			if time.Now().After(deadline) {
				t.Fatalf("the service never heard hidden=%v (on screen %v)", hidden, win.seen())
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
	relay.Report(mac(true, true))
	settle(true)
	if kb.key(notchKeyEscDown, 0) {
		t.Fatal("a hidden notch kept Esc from the film")
	}
	kb.key(notchKeyEscUp, 0)
	tapYes()
	if len(said) != 0 {
		t.Fatalf("a hidden notch took %v", said)
	}
	if host.Focus(true) || win.takes != 0 {
		t.Fatal("a hidden notch took the keyboard from the film")
	}
	// A question, as the page's __notch_asking says it: back over the film.
	host.Asking(true)
	settle(false)
	if !kb.key(notchKeyEscDown, 0) {
		t.Fatal("back for a question, Esc is the notch's again")
	}
	kb.key(notchKeyEscUp, 0)
	tapYes()
	if len(said) != 2 || said[0] != notchKeyEsc || said[1] != notchKeyYes {
		t.Fatalf("back for a question, Esc and a yes are the notch's: %v", said)
	}
	// Answered, and the film still plays: the next look hides it.
	host.Asking(false)
	relay.Report(mac(true, true))
	settle(true)
	relay.Report(mac(false, false))
	settle(false)
	tapYes()
	if len(said) != 3 || said[2] != notchKeyYes {
		t.Fatalf("in sight again, a yes is a yes: %v", said)
	}
}

// Only the last facts count: a burst of readings ends on the last one, and
// the relay never waits for the goroutine that applies them.
func TestNotchFactsRelayKeepsOnlyTheLast(t *testing.T) {
	var mu sync.Mutex
	var last notchHostFacts
	block := make(chan struct{})
	relay := newNotchFactsRelay(func(f notchHostFacts) {
		<-block
		mu.Lock()
		last = f
		mu.Unlock()
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 100; i++ {
			relay.Report(notchHostFacts{FullscreenInFront: i%2 == 0, DisplayKeptAwake: true})
		}
		relay.Report(notchHostFacts{FullscreenInFront: true, DisplayKeptAwake: true, VideoPlaying: true, CaptureOverlay: true})
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Report waited for the goroutine that applies the facts")
	}
	close(block)
	want := notchHostFacts{FullscreenInFront: true, DisplayKeptAwake: true, VideoPlaying: true, CaptureOverlay: true}
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		got := last
		mu.Unlock()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the last facts applied were %+v, want %+v", got, want)
		}
		time.Sleep(time.Millisecond)
	}
}

// The Mac's window cannot be built here, so how it is wired to the one rule
// is held to in its text: the timer only reports what it sees and never
// shows or hides the window itself, showing and hiding are always queued on
// the main thread (a show done in place could overtake a hide queued before
// it), the page's question, its keyboard and its load go through the rule,
// and the bridge only puts the facts down.
func TestNotchMacWindowIsWiredToTheOneRule(t *testing.T) {
	raw, err := os.ReadFile("notch_host_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	// The body of one C function of the file: from its name to the next
	// function that begins a line.
	body := func(name string) string {
		t.Helper()
		at := strings.Index(text, "\nstatic "+name+"(")
		if at < 0 {
			at = strings.Index(text, " "+name+"(")
		}
		if at < 0 {
			t.Fatalf("notch_host_darwin.go has no %s", name)
		}
		rest := text[at+1:]
		if end := strings.Index(rest, "\nstatic "); end >= 0 {
			rest = rest[:end]
		}
		// Comments are not part of what is held to, nor is how it is laid out.
		var code []string
		for _, line := range strings.Split(rest, "\n") {
			if cut := strings.Index(line, "//"); cut >= 0 {
				line = line[:cut]
			}
			code = append(code, line)
		}
		return strings.Join(strings.Fields(strings.Join(code, " ")), " ")
	}
	tick := body("void jarvis_notch_tick")
	if !strings.Contains(tick, "goNotchFacts(front > 0 ? 1 : 0, awake ? 1 : 0);") {
		t.Error("the window's timer no longer reports what it sees")
	}
	for _, own := range []string{"orderOut", "orderFront", "goNotchHidden"} {
		if strings.Contains(tick, own) {
			t.Errorf("the window's timer decides for itself again (%s)", own)
		}
	}
	show := body("void jarvis_notch_show")
	if !strings.Contains(show, "dispatch_async(dispatch_get_main_queue(), ^{") || strings.Contains(show, "isMainThread") {
		t.Error("showing and hiding must always be queued, never done in place")
	}
	if strings.Contains(body("int jarvis_notch_focus"), "jarvis_notch_hidden") {
		t.Error("the window decides about a hidden notch's keyboard again: that is notchHost.Focus")
	}
	for name, want := range map[string]string{
		"platformNotchAsking": "host.Asking(asking)",
		"platformNotchFocus":  "return host.Focus(take)",
		"platformNotchReveal": "host.Loaded()",
		"platformNotchSetUp":  "notchMacHost.Store(newNotchHost(notchMacWindow{handle}, notch.setHidden))",
	} {
		if !strings.Contains(goFunc(t, "notch_host_darwin.go", name), want) {
			t.Errorf("%s no longer has: %s", name, want)
		}
	}
	bridge, err := os.ReadFile("notch_host_bridge_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(bridge), "notchMacFacts.Report(") {
		t.Fatal("the timer's facts no longer go through the relay: on the main thread nothing else may be done with them")
	}
}

// The window's own calls cannot be made without a web view, so that the page's
// call about Esc reaches the pulse, and reaches it before the service, is held
// to in the text: from that call on the page is held to answering, whether it
// has ever answered a question or not.
func TestNotchPageCallsAreSignsToThePulse(t *testing.T) {
	bind := goFunc(t, "notch_host.go", "bindNotch")
	before(t, "bindNotch", bind, "notch.wantEsc(want)", "pulse := newNotchPulse(time.Now())", "pulse.Esc(want, time.Now())")
	if !strings.Contains(bind, "bind(\"__notch_alive\", func() {\n\t\tpulse.Alive(time.Now())") {
		t.Error("the page's answer to the question no longer reaches the pulse")
	}
}
