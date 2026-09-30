package main

import "sync"

// The registry every hotkey backend fires its callbacks through, and the reason
// stop() can promise something.
//
// ---------------------------------------------------------------------------
// The defect this exists for (#587)
//
// The C->Go bridges dispatched a press with a bare `go fn()`. Nothing connected
// that goroutine to the hotkey's lifetime, so a callback could still be running
// -- or could start -- after stop() had returned and the caller believed the
// hotkey was gone. Where stop() is followed by tearing down whatever the
// callback touches, and it usually is, the callback then ran against a
// half-destroyed pebble or panel.
//
// This file carries no build tag on purpose: the linux, darwin and windows
// backends all use it, and it is pure Go, so the guarantee below is covered by
// a test on every platform rather than only on the one with a display.
//
// ---------------------------------------------------------------------------
// INVALIDATE, not wait -- and why
//
// The two available fixes are "stop() waits for an in-flight callback" and
// "stop() invalidates it". Waiting is the stronger guarantee and is rejected,
// because it deadlocks on paths this code actually has:
//
//   - THE DECISIVE ONE: the summon and palette callbacks drive the pebble,
//     whose teardown runs on the GTK main thread, and that teardown is one of
//     the callers of stop(). Waiting there is the GTK thread blocking on a
//     goroutine that is itself waiting to get onto the GTK thread. No ordering
//     of the wait fixes that, because both sides are correct.
//   - panels_runtime.go stops a panel's hotkey from the panel lifecycle the
//     callback can be executing inside.
//   - A callback that calls stop() on its own hotkey deadlocks against itself.
//     (Strictly this one is avoidable -- it only bites if the wait is held
//     while fn runs -- but it is the shape everyone reaches for first, so it is
//     worth naming.)
//
// So stop() invalidates and never blocks. What that buys, stated exactly:
//
//	after stop() returns, NO callback invocation can begin.
//
// That is a real guarantee rather than a narrowed window, because claim() and
// invalidate() take the same mutex: a dispatch goroutine either takes its claim
// before the invalidation and runs, or finds the entry stopped and returns
// without calling fn at all. There is no gap between "checked the flag" and
// "called fn" for an invalidation to slip into -- which is exactly what a bare
// atomic bool would have left open.
//
// What it does NOT buy, and callers should know: a callback already executing
// inside fn() when stop() is called runs to completion. That is the half you
// cannot have without waiting, so invalidate() reports how many were in flight
// and the backends log it rather than quietly implying otherwise.
type hotkeyDispatch struct {
	mu      sync.Mutex
	next    uint64
	entries map[uint64]*hotkeyEntry
}

type hotkeyEntry struct {
	fn       func()
	stopped  bool
	inFlight int
}

// hotkeyDispatcher is the process-wide registry. One per process rather than one
// per backend: only one backend is compiled in at a time, and sharing it means
// the lifecycle guarantee is written once instead of three times slightly
// differently.
var hotkeyDispatcher = hotkeyDispatch{}

// register records fn and returns the id the C side will fire with.
//
// ids are never reused, so a stale id from a C callback that outlived its
// hotkey cannot collide with a later registration -- it simply finds nothing.
func (d *hotkeyDispatch) register(fn func()) uint64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.entries == nil {
		d.entries = make(map[uint64]*hotkeyEntry)
	}
	d.next++
	id := d.next
	d.entries[id] = &hotkeyEntry{fn: fn}
	return id
}

// claim takes a dispatch slot for id. On ok, the caller MUST call the returned
// release exactly once when fn has returned.
//
// Refuses after invalidate, which is the whole point: this is the check that
// cannot be raced, because it happens under the same lock invalidate uses.
func (d *hotkeyDispatch) claim(id uint64) (fn func(), release func(), ok bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	e := d.entries[id]
	if e == nil || e.stopped || e.fn == nil {
		return nil, nil, false
	}
	e.inFlight++
	var once sync.Once
	return e.fn, func() {
		once.Do(func() {
			d.mu.Lock()
			e.inFlight--
			d.mu.Unlock()
		})
	}, true
}

// dispatch runs a press: it CLAIMS SYNCHRONOUSLY on the caller's thread, then
// hands the callback to a goroutine.
//
// Claiming here rather than inside the goroutine is deliberate. A burst of
// queued presses on a stopped hotkey costs nothing instead of one goroutine per
// press that immediately discovers it was refused, and the in-flight count is
// already correct when this returns -- so a stop() racing this press reads the
// truth rather than a value that is about to change.
//
// The callback itself still gets its own goroutine. On linux this is called on
// the listener's locked OS thread inside jarvisHotkeyRun's event drain, and on
// darwin from an NSEvent monitor block on the main run loop; running a callback
// that opens a pebble inline from either would block the loop that has to
// service it.
func (d *hotkeyDispatch) dispatch(id uint64) {
	fn, release, ok := d.claim(id)
	if !ok {
		return
	}
	go func() {
		defer release()
		fn()
	}()
}

// invalidate unregisters id and reports how many dispatches were still inside
// fn(). Never blocks. Idempotent: a second call reports 0.
//
// The count is diagnostics, not a handshake -- there is deliberately nothing to
// wait on. It exists so a caller that sees a callback touch a torn-down object
// can find the reason in the log instead of inferring it.
func (d *hotkeyDispatch) invalidate(id uint64) (inFlight int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	e := d.entries[id]
	if e == nil {
		return 0
	}
	e.stopped = true
	delete(d.entries, id)
	// The entry itself stays alive for whoever holds a claim: release() closes
	// over the pointer, so dropping it from the map does not strand them.
	return e.inFlight
}
