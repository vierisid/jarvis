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
// "stop() invalidates it". Waiting is the stronger guarantee and is rejected:
//
//   - THE DECISIVE ONE: the callbacks reach pebble and panel UI through
//     runOnSharedUIThread -> gtkInvokeSync (panels_linux.go), which is
//     SYNCHRONOUS -- the callback blocks until the GTK loop runs its closure.
//     So the time a callback takes is bounded by the health of the GTK main
//     loop, and a wait-based stop() would inherit that bound from whatever
//     goroutine called it. Teardown would hang on a busy or wedged UI loop,
//     which is the one moment it must not.
//   - panels_runtime.go stops a panel's hotkey from the panel lifecycle the
//     callback can be executing inside.
//   - A callback that calls stop() on its own hotkey deadlocks against itself.
//     (Strictly this one is avoidable -- it only bites if the wait is held
//     while fn runs -- but it is the shape everyone reaches for first, so it is
//     worth naming.)
//
// NOT claimed, because it was checked and is false: that stop() is reached from
// the GTK main thread. The GLib loop runs on its own goroutine (ensureGTKMain
// in pebble_overlay_linux.go) and the only caller of the linux hotkey stop is
// pebbleServiceLinux.Close, which the SidecarClient goroutine invokes. A
// GTK-thread-waits-on-itself deadlock is therefore not reachable today; the
// reason above does not depend on it.
//
// So invalidate() never blocks. Note that the linux stop() as a whole still
// does -- it joins its listener goroutine on `done` after invalidating -- so
// "stop() never blocks" would be wrong; what it never does is wait for a
// callback. What the invalidation buys, stated exactly:
//
//	after stop() returns, NO callback invocation can begin.
//
// That is a real guarantee rather than a narrowed window, because claim() and
// invalidate() take the same mutex: a dispatch goroutine either takes its claim
// before the invalidation and runs, or finds the registration gone and returns
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
	// Refused when the id is gone, which is what invalidate leaves behind.
	// There is deliberately no separate "stopped" flag: invalidate DELETES the
	// entry, so a flag would be unreachable state that merely looked like the
	// thing doing the work.
	e := d.entries[id]
	if e == nil || e.fn == nil {
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

// dispatch runs a press: a goroutine that CLAIMS FIRST and only then calls fn.
//
// The claim is inside the goroutine, and that placement is the guarantee. An
// earlier version claimed on the caller's thread and then started a goroutine
// to run fn, on the reasoning that a burst of presses on a stopped hotkey
// should not cost a goroutine each and that the in-flight count would be
// settled by the time dispatch returned. Both of those are true and neither is
// worth what it cost: between the claim and the goroutine's first instruction
// there is nothing but the scheduler, so invalidate() could return -- stop()
// could return, and the caller could start tearing down -- while fn had not yet
// begun. A test of 2000 rounds found the callback beginning late in 2000 of
// them. That is the #587 defect with extra steps.
//
// Claiming here instead makes it structural: fn only ever runs behind a
// successful claim, claim contends for the same mutex as invalidate, and a
// claim after invalidate is refused. There is no interleaving left in which a
// callback begins after stop() returned. The cost is one short-lived goroutine
// per press on an already-stopped hotkey, which for a human-rate event is not a
// cost, and in exchange invalidate's count now means "entered fn" rather than
// "was going to".
//
// The callback needs its own goroutine regardless. On linux this is called on
// the listener's locked OS thread inside jarvisHotkeyRun's event drain, and on
// darwin from an NSEvent monitor block on the main run loop; running a callback
// that opens a pebble inline from either would block the loop that has to
// service it.
func (d *hotkeyDispatch) dispatch(id uint64) {
	go func() {
		fn, release, ok := d.claim(id)
		if !ok {
			return
		}
		defer release()
		fn()
	}()
}

// invalidate unregisters id and reports how many dispatches are claimed and not
// yet released. Never blocks. Idempotent: a second call reports 0.
//
// "Claimed and not yet released", not "inside fn()": a claim is taken
// immediately before fn is called and released immediately after it returns, so
// the count is an upper bound on callbacks still executing. Worth being precise
// about, because the whole reason it is reported is to let someone reading a log
// attribute a callback that touched something after teardown -- a count that
// overstates would send them looking for a bug that is not there.
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
	delete(d.entries, id)
	// The entry itself stays alive for whoever holds a claim: release() closes
	// over the pointer, so dropping it from the map does not strand them.
	return e.inFlight
}
