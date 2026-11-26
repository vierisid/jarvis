package main

// The notch's pulse: is the window's thread still running, and is the page
// still answering?
//
// Esc is kept from the app in front for as long as the page says Esc would do
// something on the notch (NotchService.wantEsc). The page says so once and is
// believed until it says otherwise. A page that hangs after saying so never
// says otherwise, and Esc was then dead in every app on the machine until
// Jarvis was quit. So the page is asked once a second whether it is there,
// and one that has answered before and has not answered for five seconds is
// no longer believed: Esc goes to the app in front again, and comes back to
// the notch with the page's next answer.
//
// The question is put on the window's own thread, so the same pulse says when
// that thread stands still. On a Mac that thread is the main thread, where
// the taps on the keyboard and the pointer also run: while it stands still
// every key on the machine waits on them. Then the taps are held off, and
// what every goroutine was doing is written to the log once, because a hang
// on a Mac leaves no report of its own to read afterwards.
//
// No platform calls in this file, and nothing in it waits for the window's
// thread: what is put there is put and left.

import (
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// How often the page is asked.
	notchPulseEvery = time.Second
	// How long without an answer before it is taken to be gone.
	notchPulseLimit = 5 * time.Second
	// Two beats further apart than this were not a second apart because of
	// the page: the machine slept, or this program was held up as a whole.
	notchPulseGap = 3 * time.Second
)

// notchAliveScript is the question. __notch_alive is one of the calls this
// app gives the page (notch_host.go), so a page answers by being able to run
// a script at all: nothing has to be written into the page for it.
const notchAliveScript = "window.__notch_alive&&window.__notch_alive();"

// notchPulse keeps when each of the two last gave a sign.
type notchPulse struct {
	limit, gap time.Duration

	mu sync.Mutex
	// When the window's thread last ran what was put on it, and when the page
	// last answered.
	window, page time.Time
	// A page counts as gone only after it has answered once. Before that it
	// may still be loading, and it has not yet said anything about Esc that
	// could be wrong.
	answered bool
	beat     time.Time
	// What was last said, so that only a change is said again.
	windowGone, pageGone bool
}

// notchPulseState is what a beat finds.
type notchPulseState struct {
	// The window's thread has not run anything for the limit.
	WindowGone bool
	// The page has answered before and has not for the limit.
	PageGone bool
	// Whether each differs from what the beat before found.
	WindowChanged, PageChanged bool
	// The asking is over (the page is going away): whatever was held off
	// because of it is let go, and nothing more is said.
	Ended bool
}

// Unseen: nothing the page said about Esc can be relied on.
func (s notchPulseState) Unseen() bool { return s.WindowGone || s.PageGone }

func newNotchPulse(now time.Time) *notchPulse {
	return &notchPulse{limit: notchPulseLimit, gap: notchPulseGap, window: now, page: now}
}

// Window is the window's thread running something of ours.
func (p *notchPulse) Window(now time.Time) {
	p.mu.Lock()
	p.window = now
	p.mu.Unlock()
}

// Page is the page answering.
func (p *notchPulse) Page(now time.Time) {
	p.mu.Lock()
	p.page, p.answered = now, true
	p.mu.Unlock()
}

// Beat is looked at once for every question asked.
func (p *notchPulse) Beat(now time.Time) notchPulseState {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.beat.IsZero() && now.Sub(p.beat) > p.gap {
		// Nobody was asked for that long, so nobody failed to answer.
		p.window, p.page = now, now
	}
	p.beat = now
	s := notchPulseState{
		WindowGone: now.Sub(p.window) > p.limit,
		PageGone:   p.answered && now.Sub(p.page) > p.limit,
	}
	s.WindowChanged, s.PageChanged = s.WindowGone != p.windowGone, s.PageGone != p.pageGone
	p.windowGone, p.pageGone = s.WindowGone, s.PageGone
	return s
}

// notchPulseRun asks once a second until quit is closed. onWindow puts
// something on the window's thread and comes back at once; ask puts the
// question to the page and is called on that thread; tell hears every change.
func notchPulseRun(p *notchPulse, quit <-chan struct{}, onWindow func(run func()), ask func(), tell func(notchPulseState)) {
	notchPulseLoop(p, quit, notchPulseEvery, onWindow, ask, tell)
}

func notchPulseLoop(p *notchPulse, quit <-chan struct{}, every time.Duration, onWindow func(run func()), ask func(), tell func(notchPulseState)) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	// One question waits on the window's thread at the most: a thread that
	// stands still for an hour is not left an hour of questions to run.
	var waiting atomic.Bool
	last := notchPulseState{}
	// Whatever ends this, nothing is left held off.
	defer func() {
		if last.Unseen() {
			tell(notchPulseState{WindowChanged: last.WindowGone, PageChanged: last.PageGone, Ended: true})
		}
	}()
	for {
		select {
		case <-quit:
			return
		case <-ticker.C:
		}
		if waiting.CompareAndSwap(false, true) {
			onWindow(func() {
				waiting.Store(false)
				p.Window(time.Now())
				ask()
			})
		}
		last = p.Beat(time.Now())
		if last.WindowChanged || last.PageChanged {
			tell(last)
		}
	}
}

// notchPulseTell is what is done about a change. It is called on the pulse's
// own goroutine.
func notchPulseTell(s notchPulseState) {
	// First, and whatever else: Esc is the app's again, or the notch's again.
	notch.setStalled(s.Unseen())
	if s.Ended {
		if s.WindowChanged {
			platformNotchInputStalled(false)
		}
		return
	}
	if s.WindowChanged {
		if s.WindowGone {
			log.Printf("[notch] the window's thread has not run for %v: Esc is left to the app in front, and the watch on the keyboard and the pointer is held off until it runs again. Every goroutine:\n%s",
				notchPulseLimit, notchAllStacks())
		} else {
			log.Printf("[notch] the window's thread runs again")
		}
		platformNotchInputStalled(s.WindowGone)
		return
	}
	if s.PageChanged && !s.WindowGone {
		if s.PageGone {
			log.Printf("[notch] the page has not answered for %v: Esc is left to the app in front until it does", notchPulseLimit)
		} else {
			log.Printf("[notch] the page answers again")
		}
	}
}

// notchAllStacks is what every goroutine is doing, for the log: where each
// one is, never what it holds. Cut at a quarter of a megabyte.
func notchAllStacks() []byte {
	buf := make([]byte, 256*1024)
	return buf[:runtime.Stack(buf, true)]
}
