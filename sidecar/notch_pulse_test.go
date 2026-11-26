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

// A page that wants Esc and stops answering is gone after the limit, said
// once, and back with its next answer.
func TestNotchPulseAPageThatStopsAnsweringIsGone(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
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
	p.Page(pulseAt(start, 8.5))
	p.Window(pulseAt(start, 9))
	if got := p.Beat(pulseAt(start, 9)); got.PageGone || !got.PageChanged || got.Unseen() {
		t.Fatalf("it answered again: %+v", got)
	}
}

// The review of the first version: a page that says it wants Esc and hangs
// before it has answered a single question was never held to answering, and
// kept Esc until Jarvis was quit. Saying so is a sign like an answer: the
// limit counts from it, however long the page has been up, and no answer at
// all is needed first.
func TestNotchPulseAPageThatWantsEscAndHangsAtOnceIsGone(t *testing.T) {
	start := time.Unix(1000, 0)
	p := newNotchPulse(start)
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
	w.pulse.limit, w.pulse.gap = 250*time.Millisecond, time.Hour
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
			w.pulse.Page(time.Now())
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

// The same for a page that hangs the moment it has said so, before it has
// answered anything.
func TestNotchAPageThatHangsBeforeItsFirstAnswerDoesNotKeepEsc(t *testing.T) {
	w := newPulseWorld()
	defer func() { close(w.quit); <-w.done }()
	w.pageAnswers.Store(false)
	w.wantEsc(true)
	if !w.takesEsc() {
		t.Fatal("it has just said so: Esc is the notch's")
	}
	w.until(t, "the page hung before its first answer", false)
}

// A page that wants no Esc is not asked anything, and is asked from the
// moment it wants it.
func TestNotchAPageIsAskedOnlyWhileItWantsEsc(t *testing.T) {
	w := newPulseWorld()
	defer func() { close(w.quit); <-w.done }()
	time.Sleep(60 * time.Millisecond)
	if asked := w.asked.Load(); asked != 0 {
		t.Fatalf("a page that wants no Esc was asked %d times", asked)
	}
	if put := w.put.Load(); put == 0 {
		t.Fatal("the window's thread is given something every beat all the same: that is how it is known to run")
	}
	w.wantEsc(true)
	deadline := time.Now().Add(3 * time.Second)
	for w.asked.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("a page that wants Esc was never asked")
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
// in its text, function by function: the timer that hides it says so, a
// window that is set up, shown or taken down says what it is, and a hidden
// one does not take the keyboard.
func TestNotchMacWindowSaysWhenItHides(t *testing.T) {
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
	for name, want := range map[string]string{
		"void jarvis_notch_tick":      "jarvis_notch_hidden = hide; goNotchHidden(hide ? 1 : 0);",
		"void jarvis_notch_set_up":    "jarvis_notch_hidden = NO; goNotchHidden(0);",
		"void jarvis_notch_tear_down": "jarvis_notch_hidden = NO; goNotchHidden(0);",
		"void jarvis_notch_reveal":    "goNotchHidden(jarvis_notch_hidden ? 1 : 0);",
		"int jarvis_notch_focus":      "if (take && jarvis_notch_hidden) return;",
	} {
		got := body(name)
		if !strings.Contains(got, want) {
			t.Errorf("%s no longer has: %s", name, want)
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

// The window's own calls cannot be made without a web view, so that the page's
// call about Esc reaches the pulse, and reaches it before the service, is held
// to in the text: from that call on the page is held to answering, whether it
// has ever answered a question or not.
func TestNotchPageCallsAreSignsToThePulse(t *testing.T) {
	bind := goFunc(t, "notch_host.go", "bindNotch")
	before(t, "bindNotch", bind, "notch.wantEsc(want)", "pulse := newNotchPulse(time.Now())", "pulse.Esc(want, time.Now())")
	if !strings.Contains(bind, "bind(\"__notch_alive\", func() {\n\t\tpulse.Page(time.Now())") {
		t.Error("the page's answer to the question no longer reaches the pulse")
	}
}
