package main

import (
	"log"
	"sync"
	"sync/atomic"
)

// The notch's window rule, once for every platform: when the window is on
// screen, when it is out of sight behind a fullscreen video, when a question
// brings it back, and when it may take the keyboard. A platform says what it
// sees (notchHostFacts) and offers three things a window can do
// (notchHostWindow); everything that decides lives here.
//
// What stays with a platform: how a video is recognised (Windows: the
// picture, the sound, the pointer; the Mac: the app in front keeps the
// display awake itself), the backdrop that draws the Windows edge, who had
// the keyboard before the page took it, and giving it back when the system
// handed the notch the keyboard unasked.
//
// Esc is not decided here. Whether Esc is kept from the app in front is the
// service's (NotchService.takesEsc, with the pulse of notch_pulse.go): it
// hears from here only whether the window is out of sight.

// notchHostFacts is what a platform's watch sees, twice or so a second.
type notchHostFacts struct {
	// The app in front covers the whole display.
	FullscreenInFront bool
	// Something is keeping the display awake, as every player does.
	DisplayKeptAwake bool
	// The picture is a video that is playing (notch_video.go on Windows).
	VideoPlaying bool
	// A screen capture is going on in front: the window stays as it is.
	CaptureOverlay bool
}

// notchHostWindow is what the rule does to a window. Show and Hide may wait
// for the window's own thread (Windows), so the host never calls them, nor
// Focus, with its lock held: that thread may itself be in the host, in a call
// from the page.
type notchHostWindow interface {
	// Show puts the window on screen without taking the keyboard.
	Show()
	// Hide takes it off the screen.
	Hide()
	// Focus takes the keyboard for the page or gives it back to whoever had
	// it. It reports whether the window has the keyboard afterwards.
	Focus(take bool) bool
}

// notchHost is one window's state: whether its page has loaded, whether it
// is hidden for a film, whether it asks a question, whether it holds the
// keyboard it asked for.
type notchHost struct {
	win  notchHostWindow
	tell func(hidden bool) // the service hears whether the window is out of sight
	// Held across each tell, and by Detach: once Detach has returned the
	// service hears nothing more from this window. Taken before mu, never
	// after it.
	tellMu sync.Mutex

	mu       sync.Mutex
	loaded   bool
	hidden   bool
	asking   bool
	detached bool
	// What has been done to the window and told to the service. Only one
	// caller at a time does it (settle), and it reads the state again before
	// it lets go, so two changes close together cannot be done the wrong way
	// round.
	settling bool
	shown    bool // the window was last shown (true) or hidden or never shown
	told     bool // the service was last told hidden=told
	again    bool // the next settle tells and shows again even if nothing changed

	hasFocus atomic.Bool // the page asked for the keyboard and has it
}

func newNotchHost(win notchHostWindow, tell func(hidden bool)) *notchHost {
	return &notchHost{win: win, tell: tell}
}

// Loaded is the page having loaded. The window is shown without taking the
// keyboard, unless a film hides it, and the service is told anew whether it
// is out of sight. A page that has just loaded is asking nothing yet (a page
// that was asking when it went away never said it had stopped).
func (h *notchHost) Loaded() {
	h.mu.Lock()
	if h.detached {
		h.mu.Unlock()
		return
	}
	h.loaded = true
	h.asking = false
	h.again = true
	h.mu.Unlock()
	h.settle()
}

// Asking is the page saying whether it shows a question that waits for a yes
// or a no. A notch hidden for a film comes back at once for one; the next
// Tick hides it again once the question is gone and the film still plays.
func (h *notchHost) Asking(asking bool) {
	h.mu.Lock()
	if h.detached || h.asking == asking {
		h.mu.Unlock()
		return
	}
	h.asking = asking
	back := asking && h.hidden
	if back {
		h.hidden = false
	}
	h.mu.Unlock()
	if back {
		h.settle()
		log.Printf("[notch] shown again over a fullscreen video: it has a question that waits for an answer")
	}
}

// Tick applies the rule to what the platform sees. It reports whether the
// window went out of sight or came back, and which, so the platform can say
// why in its own words.
func (h *notchHost) Tick(f notchHostFacts) (changed, hidden bool) {
	h.mu.Lock()
	if h.detached || (f.FullscreenInFront && f.CaptureOverlay) {
		hidden = h.hidden
		h.mu.Unlock()
		return false, hidden
	}
	hide := notchShouldHide(f.FullscreenInFront, f.DisplayKeptAwake, f.VideoPlaying, h.asking)
	if hide == h.hidden {
		h.mu.Unlock()
		return false, hide
	}
	h.hidden = hide
	h.mu.Unlock()
	h.settle()
	return true, hide
}

// Focus is the page asking for the keyboard (take) or giving it back. A
// window nobody can see does not take the keyboard from the film. It reports
// whether the notch has the keyboard afterwards.
func (h *notchHost) Focus(take bool) bool {
	h.mu.Lock()
	refused := h.detached || (take && h.hidden)
	h.mu.Unlock()
	if refused {
		return false
	}
	if !take {
		// The window first (on Windows: it stops taking the keyboard), then
		// the word, as notch/main had it.
		h.win.Focus(false)
		h.hasFocus.Store(false)
		return false
	}
	// Held before the system is asked: the platform's watch gives back a
	// keyboard the notch has without having asked for it.
	h.hasFocus.Store(true)
	if !h.win.Focus(true) {
		h.hasFocus.Store(false)
		return false
	}
	// A film may have hidden the window while the system was asked. Taking
	// the keyboard can bring a window on screen (the Mac's
	// makeKeyAndOrderFront), so a window hidden meanwhile gives the keyboard
	// back and is hidden again: out of sight it holds nothing.
	h.mu.Lock()
	late := h.hidden || h.detached
	if late && !h.detached {
		h.shown = true
	}
	h.mu.Unlock()
	if !late {
		return true
	}
	h.win.Focus(false)
	h.hasFocus.Store(false)
	h.settle()
	return false
}

// HasFocus is whether the page asked for the keyboard and has it.
func (h *notchHost) HasFocus() bool { return h.hasFocus.Load() }

// Hidden is whether the window is out of sight for a film.
func (h *notchHost) Hidden() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.hidden
}

// Detach is the window going away. Nothing it is told afterwards moves
// anything: the service has already forgotten it (NotchService.detachPage).
// It waits for a tell already under way, so after it returns the service
// hears nothing more from this window.
func (h *notchHost) Detach() {
	h.tellMu.Lock()
	h.mu.Lock()
	h.detached = true
	h.mu.Unlock()
	h.tellMu.Unlock()
}

// settle makes the window and the service agree with the state. The window
// is on screen when the page has loaded and no film hides it. The service is
// told before the window moves, so a notch on its way out of sight has
// already let go of Esc.
func (h *notchHost) settle() {
	h.mu.Lock()
	if h.settling {
		// Whoever is settling reads the state again before stopping.
		h.mu.Unlock()
		return
	}
	h.settling = true
	for !h.detached {
		hidden, show := h.hidden, h.loaded && !h.hidden
		tell := h.again || h.told != hidden
		move := h.again || h.shown != show
		if !tell && !move {
			break
		}
		// A window that was never shown has nothing to take away.
		hide := move && !show && h.shown
		h.again = false
		h.told, h.shown = hidden, show
		h.mu.Unlock()
		if tell {
			h.tellMu.Lock()
			h.mu.Lock()
			gone := h.detached
			h.mu.Unlock()
			if !gone {
				h.tell(hidden)
			}
			h.tellMu.Unlock()
		}
		if move && show {
			h.win.Show()
		} else if hide {
			h.win.Hide()
		}
		h.mu.Lock()
	}
	h.settling = false
	h.mu.Unlock()
}

// notchFactsRelay carries what a platform's watch sees from a thread that
// must not wait to a goroutine that applies the rule. On a Mac the watch is a
// timer on the main thread, and the main thread takes no lock it could be
// kept waiting on: it puts the facts down here and goes on. A goroutine picks
// up the last facts put down and gives them to tell. Only the last facts
// count, so two readings close together cannot arrive the wrong way round.
type notchFactsRelay struct {
	facts atomic.Uint32
	wake  chan struct{}
	once  sync.Once
	tell  func(f notchHostFacts)
}

func newNotchFactsRelay(tell func(f notchHostFacts)) *notchFactsRelay {
	return &notchFactsRelay{wake: make(chan struct{}, 1), tell: tell}
}

// Report puts the facts down. It never waits.
func (r *notchFactsRelay) Report(f notchHostFacts) {
	r.facts.Store(notchFactsBits(f))
	r.once.Do(func() {
		go func() {
			for range r.wake {
				r.tell(notchFactsFromBits(r.facts.Load()))
			}
		}()
	})
	select {
	case r.wake <- struct{}{}:
	default:
		// Facts are already waiting to be picked up, and they are read when
		// they are picked up: these are the ones that will be read.
	}
}

func notchFactsBits(f notchHostFacts) uint32 {
	var bits uint32
	for i, b := range []bool{f.FullscreenInFront, f.DisplayKeptAwake, f.VideoPlaying, f.CaptureOverlay} {
		if b {
			bits |= 1 << i
		}
	}
	return bits
}

func notchFactsFromBits(bits uint32) notchHostFacts {
	return notchHostFacts{
		FullscreenInFront: bits&1 != 0,
		DisplayKeptAwake:  bits&2 != 0,
		VideoPlaying:      bits&4 != 0,
		CaptureOverlay:    bits&8 != 0,
	}
}
