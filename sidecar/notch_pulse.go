package main

// The notch's pulse: is the window's thread still running, and is the page
// still answering?
//
// Esc is kept from the app in front for as long as the page says Esc would do
// something on the notch (NotchService.wantEsc). The page says so once and is
// believed until it says otherwise. A page that hangs after saying so never
// says otherwise, and Esc was then dead in every app on the machine until
// Jarvis was quit. So the page is asked once a second whether it is there,
// for as long as it says it wants Esc, and one that has not answered for five
// seconds is no longer believed: Esc goes to the app in front again, and
// comes back to the notch with the page's next answer. A page that wants no
// Esc is not asked: there is nothing it could be wrong about.
//
// But first the asking itself has to be seen to work, for this page, in this
// web view: from the moment the page is attached it is asked whatever it
// wants, until it has answered once. Until then its silence proves nothing,
// and Esc stays as the page said, as it always did: a way of asking that
// does not work in some web view must not take Esc from every sheet there
// after five seconds, because Esc is what stops a fuse that is burning. A
// page that has not answered within thirty seconds is no longer asked, and
// the log says once that nothing watches it. What is left open by that: a
// page that hangs before its very first answer after loading.
//
// The asking is done on the window's own thread, and something is put on
// that thread every second whether the page is asked or not, so the same
// pulse says when that thread stands still, once it has run at all. On a Mac that thread is the main thread, where
// the taps on the keyboard and the pointer also run: while it stands still
// every key on the machine waits on them. Then the taps are held off, and
// what every goroutine was doing is written to the log (at most once in ten
// minutes, and five times in the life of the program), because a hang on a
// Mac leaves no report of its own to read afterwards.
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
	// How long a page has to answer for the first time. After that the
	// asking is taken not to work here, and is given up for this page.
	notchPulseProveWithin = 30 * time.Second
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
	limit, gap, proveWithin time.Duration

	mu sync.Mutex
	// When the window's thread last ran what was put on it, and when the page
	// last gave a sign: an answer, or any call of its own.
	window, page time.Time
	// The window's thread counts as gone only after it has run once. A window
	// that is slow to start has not stopped.
	ran bool
	// The page says Esc would do something (NotchService.wantEsc). Only then
	// is it asked, and only then can it count as gone.
	asking bool
	// The page has answered the question once (Alive): asking works here.
	// Only then can its silence count against it. born is when the page was
	// attached, gaveUp that it did not answer in time and is asked no more,
	// and the two "said" that each was told (once).
	proven, provenSaid bool
	gaveUp             bool
	born               time.Time
	beat               time.Time
	// What was last said, so that only a change is said again.
	windowGone, pageGone bool
}

// notchPulseState is what a beat finds.
type notchPulseState struct {
	// The window's thread ran before and has not run anything for the limit.
	WindowGone bool
	// The page wants Esc, has answered the question before, and has given no
	// sign for the limit.
	PageGone bool
	// Said once each: the page has answered for the first time, so asking
	// works here; or it did not in time, and nothing watches this page.
	PingProven, PingOff bool
	// Whether each differs from what the beat before found.
	WindowChanged, PageChanged bool
	// The asking is over (the page is going away): whatever was held off
	// because of it is let go, and nothing more is said.
	Ended bool
}

// Unseen: nothing the page said about Esc can be relied on.
func (s notchPulseState) Unseen() bool { return s.WindowGone || s.PageGone }

func newNotchPulse(now time.Time) *notchPulse {
	return &notchPulse{limit: notchPulseLimit, gap: notchPulseGap, proveWithin: notchPulseProveWithin, window: now, page: now, born: now}
}

// Window is the window's thread running something of ours.
func (p *notchPulse) Window(now time.Time) {
	p.mu.Lock()
	p.window, p.ran = now, true
	p.mu.Unlock()
}

// Page is a sign from the page: any call it makes by itself. It counts for
// when the page was last there, and proves nothing about the asking.
func (p *notchPulse) Page(now time.Time) {
	p.mu.Lock()
	p.page = now
	p.mu.Unlock()
}

// Alive is the page answering the question. The first answer is what shows
// that asking works for this page.
func (p *notchPulse) Alive(now time.Time) {
	p.mu.Lock()
	p.page, p.proven = now, true
	p.mu.Unlock()
}

// Esc is the page saying whether Esc would do something on the notch. It is
// a sign from the page like any other, and from when it wants Esc the page is
// asked and, once asking is known to work, held to answering.
func (p *notchPulse) Esc(want bool, now time.Time) {
	p.mu.Lock()
	p.asking, p.page = want, now
	p.mu.Unlock()
}

// Asking reports whether the page is to be asked now: until its first
// answer whatever it wants (unless that was given up), and after it only
// while it wants Esc.
func (p *notchPulse) Asking() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.proven {
		return !p.gaveUp
	}
	return p.asking
}

// Beat is looked at once a second.
func (p *notchPulse) Beat(now time.Time) notchPulseState {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.beat.IsZero() && now.Sub(p.beat) > p.gap {
		// Nobody was asked for that long, so nobody failed to answer.
		p.window, p.page = now, now
		if !p.proven {
			p.born = now
		}
	}
	p.beat = now
	s := notchPulseState{
		WindowGone: p.ran && now.Sub(p.window) > p.limit,
		PageGone:   p.proven && p.asking && now.Sub(p.page) > p.limit,
	}
	if p.proven && !p.provenSaid {
		p.provenSaid, s.PingProven = true, true
	}
	// A thread that does not run cannot have asked: its time is not the
	// page's.
	if !p.proven && !p.gaveUp && !s.WindowGone && p.ran && now.Sub(p.born) > p.proveWithin {
		p.gaveUp, s.PingOff = true, true
	}
	s.WindowChanged, s.PageChanged = s.WindowGone != p.windowGone, s.PageGone != p.pageGone
	p.windowGone, p.pageGone = s.WindowGone, s.PageGone
	return s
}

// notchPulseRun beats once a second until quit is closed. onWindow puts
// something on the window's thread and comes back at once; ask puts the
// question to the page and is called on that thread; tell hears every change.
func notchPulseRun(p *notchPulse, quit <-chan struct{}, onWindow func(run func()), ask func(), tell func(notchPulseState)) {
	notchPulseLoop(p, quit, notchPulseEvery, onWindow, ask, tell)
}

func notchPulseLoop(p *notchPulse, quit <-chan struct{}, every time.Duration, onWindow func(run func()), ask func(), tell func(notchPulseState)) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	// One thing waits on the window's thread at the most: a thread that
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
				// A page that wants no Esc is left alone, once it has shown
				// that it can be asked.
				if p.Asking() {
					ask()
				}
			})
		}
		last = p.Beat(time.Now())
		if last.WindowChanged || last.PageChanged || last.PingProven || last.PingOff {
			tell(last)
		}
	}
}

// notchPulseTell is what is done about a change. It is called on the pulse's
// own goroutine.
func notchPulseTell(s notchPulseState) {
	notchPulseTellTo(notch, s, platformNotchInputStalled, time.Now())
}

func notchPulseTellTo(svc *NotchService, s notchPulseState, hold func(stalled bool), now time.Time) {
	if s.Ended {
		// The page is going away, and the service forgets what was said of it
		// when it does (detachPage). Esc is not given back to a page that is
		// not answering for the moment in between.
		if s.WindowChanged {
			hold(false)
		}
		return
	}
	// First, and whatever else: Esc is the app's again, or the notch's again.
	svc.setStalled(s.Unseen())
	if s.PingProven {
		log.Printf("[notch] the page answers when asked: from here a page that wants Esc and stops answering for %v does not keep it", notchPulseLimit)
	}
	if s.PingOff {
		log.Printf("[notch] the page has not answered a single question in %v: asking does not work here, so nothing watches this page, and Esc stays as the page says", notchPulseProveWithin)
	}
	if s.WindowChanged {
		if s.WindowGone {
			stacks := "(not written again so soon: see the last time)"
			if notchDumps.allow(now) {
				stacks = string(notchAllStacks())
			}
			log.Printf("[notch] the window's thread has not run for %v: Esc is left to the app in front, and the watch on the keyboard and the pointer is held off until it runs again. Every goroutine:\n%s",
				notchPulseLimit, stacks)
		} else {
			log.Printf("[notch] the window's thread runs again")
		}
		hold(s.WindowGone)
	}
	if s.PageChanged {
		if s.PageGone {
			log.Printf("[notch] the page has not answered for %v: Esc is left to the app in front until it does", notchPulseLimit)
		} else {
			log.Printf("[notch] the page answers again")
		}
	}
}

// How often what every goroutine is doing may be written to the log: a
// thread that stops and starts must not fill the disk with it.
const (
	notchDumpEvery = 10 * time.Minute
	notchDumpMost  = 5
)

type notchDumpLimit struct {
	mu    sync.Mutex
	last  time.Time
	count int
}

var notchDumps notchDumpLimit

func (d *notchDumpLimit) allow(now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.count >= notchDumpMost || (d.count > 0 && now.Sub(d.last) < notchDumpEvery) {
		return false
	}
	d.last, d.count = now, d.count+1
	return true
}

// notchAllStacks is what every goroutine is doing, for the log: where each
// one is, never what it holds. Cut at a quarter of a megabyte.
func notchAllStacks() []byte {
	buf := make([]byte, 256*1024)
	return buf[:runtime.Stack(buf, true)]
}
