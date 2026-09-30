//go:build linux

package main

import (
	"os"
	"strings"
	"syscall"
	"testing"
)

// requireXHotkeyTests is the env var CI sets to say "these tests must actually
// run here". Named like JARVIS_REQUIRE_XDOTOOL_SHIM, which does the same job for
// the xdotool-dependent tests in src/actions/app-control/linux.test.ts.
const requireXHotkeyTests = "JARVIS_REQUIRE_X_HOTKEY_TESTS"

// requireX skips, unless CI has said these tests are not allowed to skip -- in
// which case it FAILS.
//
// The failure mode #588 exists to stop is a skip that CI reports as a pass. The
// X-dependent tests here are the only coverage the cgo grab path has, and for
// as long as the linux job set no DISPLAY they all skipped, so a regression in
// that path landed green. Adding Xvfb alone would not have fixed that: if Xvfb
// failed to start, or the runner image changed, they would go back to skipping
// and the job would go back to passing.
//
// So this covers EVERY reason these tests bail, not just a missing display.
// "Something already holds the combination" is also a hard failure under the
// flag, because on a freshly started Xvfb nothing can be holding it -- if that
// happens, the assumption is wrong and someone should know.
func requireX(t *testing.T, format string, args ...any) {
	t.Helper()
	// Read through os.Getenv on purpose, and unconditionally. DISPLAY is
	// normally consumed by libX11's C getenv, which go test's cache cannot see,
	// so a cached "SKIP" from a run with no DISPLAY could be replayed verbatim
	// in a run where Xvfb was up. Touching it here from Go puts it in the cache
	// key. (The dedicated CI step also passes -count=1; this is the half that
	// protects a developer running plain `go test`.)
	display := os.Getenv("DISPLAY")
	if os.Getenv(requireXHotkeyTests) == "1" {
		t.Fatalf("%s=1 says this test must run here, but it could not: "+format+" (DISPLAY=%q)",
			append(append([]any{requireXHotkeyTests}, args...), display)...)
	}
	t.Skipf(format, args...)
}

// The guard for the guard, and precisely scoped: this catches the flag being
// SET while DISPLAY is empty -- Xvfb failing to start, say -- which would
// otherwise make every X test below skip.
//
// It does NOT catch the flag being dropped from the job; it skips in that case,
// like the JARVIS_REQUIRE_XDOTOOL_SHIM guard it is modelled on. What catches
// that is the workflow's `--- SKIP` grep, which fails the step even though
// `go test` itself reports PASS. Two mechanisms, each covering the other's gap.
//
// It also exists to make DISPLAY part of go test's cache key for this package
// even on the paths where requireX is never reached.
func TestLinuxXHotkeyTestsAreEnforcedHere(t *testing.T) {
	display := os.Getenv("DISPLAY")
	if os.Getenv(requireXHotkeyTests) != "1" {
		t.Skipf("%s is not set, so the X-dependent tests may skip (this is the developer default; CI sets it)", requireXHotkeyTests)
	}
	if display == "" {
		t.Fatalf("%s=1 but DISPLAY is empty, so every X-dependent test below would skip and this job would pass without exercising the cgo grab path at all -- which is the whole of #588", requireXHotkeyTests)
	}
	t.Logf("X-dependent hotkey tests are enforced here, against DISPLAY=%q", display)
}

// parseLinuxKeyspec is pure Go for modifier/alias parsing; the final keysym
// lookup goes through XStringToKeysym, which is a client-side table lookup and
// needs no X display, so this runs headless in CI.
func TestParseLinuxKeyspec(t *testing.T) {
	t.Run("modifiers combine", func(t *testing.T) {
		mods, ks, err := parseLinuxKeyspec("ctrl+shift+a")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if mods != hkControlMask|hkShiftMask {
			t.Errorf("mods = %d, want ctrl|shift", mods)
		}
		if ks == 0 {
			t.Errorf("keysym for 'a' should be non-zero")
		}
	})

	t.Run("modifier aliases", func(t *testing.T) {
		mods, _, err := parseLinuxKeyspec("control+option+super+space")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := uint(hkControlMask | hkMod1Mask | hkMod4Mask)
		if mods != want {
			t.Errorf("mods = %d, want %d", mods, want)
		}
	})

	t.Run("key aliases resolve to a keysym", func(t *testing.T) {
		// Note: a literal " " can't be a trailing token (TrimSpace strips it
		// before the split), so only the named aliases are reachable here.
		for _, k := range []string{"space", "spacebar", "esc", "escape", "enter", "return"} {
			if _, ks, err := parseLinuxKeyspec("ctrl+" + k); err != nil || ks == 0 {
				t.Errorf("alias %q: ks=%d err=%v", k, ks, err)
			}
		}
	})

	t.Run("errors", func(t *testing.T) {
		for _, spec := range []string{"", "   ", "ctrl+", "hyper+a", "ctrl+notarealkey123"} {
			if _, _, err := parseLinuxKeyspec(spec); err == nil {
				t.Errorf("parseLinuxKeyspec(%q) should error", spec)
			}
		}
	})
}

// Every key name the shared layer knows must resolve to a real KeySym, proven
// against the actual XStringToKeysym rather than against our own table. This is
// the Linux half of the parity check in hotkeys_keyspec_test.go, and it is why
// the keysym spellings are a table: XStringToKeysym is case-sensitive, so "tab",
// "f13", "left" and "pageup" are all NoSymbol, which is how `ctrl+tab` and
// `ctrl+f13` came to parse on Windows and fail on Linux alone (#563).
func TestLinuxKeyNameParity(t *testing.T) {
	keys := []string{
		"a", "k", "z", "0", "9",
		"space", "spacebar", "return", "enter", "tab", "escape", "esc",
		"backspace", "delete", "del", "insert", "ins",
		"home", "end", "pageup", "pgup", "pagedown", "pgdn",
		"left", "right", "up", "down",
		"minus", "equal", "leftbracket", "rightbracket", "backslash",
		"semicolon", "quote", "comma", "period", "slash", "grave",
		"-", "=", "[", "]", ";", "'", ",", ".", "/", "`",
		"f1", "f5", "f12", "f13", "f19", "f20",
	}
	for _, key := range keys {
		mods, ks, err := parseLinuxKeyspec("ctrl+shift+" + key)
		if err != nil {
			t.Errorf("ctrl+shift+%s: %v", key, err)
			continue
		}
		if ks == 0 {
			t.Errorf("ctrl+shift+%s resolved to NoSymbol", key)
		}
		if mods != hkControlMask|hkShiftMask {
			t.Errorf("ctrl+shift+%s: mods = %d, want ctrl|shift", key, mods)
		}
	}
}

// The shipped defaults, resolved through the real X keysym table.
//
// KEEP IN SYNC WITH PEBBLE_DEFAULT_SUMMON_HOTKEY and PEBBLE_DEFAULT_PALETTE_HOTKEY
// in src/config/pebble-hotkeys.ts -- grep PEBBLE_DEFAULT_ for every copy.
func TestLinuxResolvesTheShippedDefaults(t *testing.T) {
	for _, spec := range []string{"ctrl+shift+space", "ctrl+shift+k"} {
		mods, ks, err := parseLinuxKeyspec(spec)
		if err != nil {
			t.Fatalf("%q: %v", spec, err)
		}
		if ks == 0 {
			t.Errorf("%q resolved to NoSymbol", spec)
		}
		if mods != hkControlMask|hkShiftMask {
			t.Errorf("%q: mods = %d, want ctrl|shift", spec, mods)
		}
	}
}

// "command" was the one modifier spelling Linux refused while macOS and Windows
// accepted it.
func TestLinuxAcceptsEveryModifierSpelling(t *testing.T) {
	for _, group := range [][]string{
		{"ctrl", "control"},
		{"alt", "opt", "option"},
		{"cmd", "command", "super", "win", "meta"},
	} {
		var first uint
		for i, name := range group {
			mods, _, err := parseLinuxKeyspec(name + "+k")
			if err != nil {
				t.Fatalf("%q: %v", name, err)
			}
			if i == 0 {
				first = mods
				continue
			}
			if mods != first {
				t.Errorf("modifier %q = %d, want %d (same as %q)", name, mods, first, group[0])
			}
		}
	}
}

// A grab the X server refuses has to come back as an ERROR (#574).
//
// It used to come back as success: the error handler swallowed BadAccess and
// jarvisHotkeyCreate returned a Hotkey either way, so the caller logged
// `summon hotkey "ctrl+shift+space" registered` for a combination another
// client held and the key did nothing for the rest of the session -- the one
// message guaranteed to send whoever is debugging a dead hotkey looking
// somewhere else. This is the Linux counterpart of
// TestHotkeysRefusedRegistrationIsReported in hotkeys_windows_test.go, and it
// reproduces the clash the same way: hold one, then ask for it again.
//
// Two X clients are involved, not one -- each listener opens its own display
// connection -- which is exactly what makes the server refuse the second.
//
// Skips where there is no X server, so headless CI skips it and a developer
// with a desktop (or anything reaching an X server, including WSLg) gets the
// real round trip. That is deliberate: the grab lives in the cgo half and this
// is the only place it can be exercised at all.
func TestLinuxXRefusedGrabIsReported(t *testing.T) {
	// Deliberately obscure: this really does grab the combination on the
	// running desktop for the length of the test, so it must not be one
	// anybody has bound. Four modifiers plus a letter is not a shipped
	// default and is not a stock binding in any desktop environment.
	const spec = "ctrl+alt+shift+super+k"

	held, err := startHotkeyListener(spec, func() {})
	if err != nil {
		// Either there is no X display, or something already holds this
		// combination. Both mean there is no first grab to contend with.
		requireX(t, "cannot grab %q here: %v", spec, err)
	}
	if held == nil {
		t.Fatal("a successful grab returned a nil stop function")
	}
	defer held()

	second, err := startHotkeyListener(spec, func() {})
	if err == nil {
		if second != nil {
			second()
		}
		// Not a flake to skip past: X refuses a passive grab that another
		// client already holds, so success here means the refusal is being
		// swallowed again and #574 has regressed.
		t.Fatal("a second grab of a combination already held came back as SUCCESS; a refused XGrabKey is being reported as registered again (#574)")
	}
	if second != nil {
		t.Fatal("a refused grab handed back a stop function; every caller reads a non-nil stop as a live hotkey")
	}
	if !strings.Contains(err.Error(), spec) {
		t.Errorf("the error should name the hotkey that failed, got: %v", err)
	}
	if !strings.Contains(err.Error(), "already held") {
		t.Errorf("a BadAccess refusal should be reported as the combination being held, got: %v", err)
	}
	// Logged, not just asserted: this is the line a user will see in the
	// sidecar log, and it is worth being able to read it in test output
	// alongside the Windows one it is meant to match.
	t.Logf("refusal reported as: %v", err)
}

// Releasing a hotkey has to release the X grab, or the combination stays dead
// for everybody after the sidecar has stopped listening for it.
//
// This is also the regression guard for the failure path's cleanup: a refused
// create ungrabs the variants it was granted before giving up. The stronger
// form of that proof -- a third client taking a lock variant while a squatter
// still holds the base one -- needs a raw X client and was done in C against a
// real server rather than from here; see the comment on startHotkeyListener.
func TestLinuxXGrabIsReleasedOnStop(t *testing.T) {
	// Derived from the pid so two concurrent runs of this package against one X
	// server do not hold the same combination and blame each other. This repo
	// hits that class of phantom failure routinely when worktrees test in
	// parallel, and the whole point of this test is to distinguish "we leaked a
	// grab" from "somebody else holds it" -- which it cannot do if the somebody
	// else is another copy of itself.
	// Not a guarantee, just long odds: two overlapping runs still collide
	// 1-in-len(keys), and if they do, the second grab below is refused because
	// the other process took it in between and this reads as a leak. The
	// re-probe under that branch is what keeps that from being a hard failure.
	// The shipped defaults' letters (k, and space) are excluded so a developer
	// running their own sidecar does not collide either.
	keys := []string{"j", "m", "n", "b", "y", "u", "i", "o", "q", "w", "e", "r", "t", "g", "h", "z", "x", "c", "v"}
	spec := "ctrl+alt+shift+super+" + keys[os.Getpid()%len(keys)]

	first, err := startHotkeyListener(spec, func() {})
	if err != nil {
		// Includes the case where something else already holds it, which is not
		// this test's subject.
		requireX(t, "cannot grab %q here: %v", spec, err)
	}
	first()

	second, err := startHotkeyListener(spec, func() {})
	if err != nil {
		// Could be our leak, or could be another process (another copy of this
		// test, or a real sidecar) taking the combination in the gap. Re-probe
		// once: a grab we leaked stays unavailable, whereas a transient holder
		// usually does not.
		retry, retryErr := startHotkeyListener(spec, func() {})
		if retryErr != nil {
			requireX(t, "%q is held by something else, so this cannot distinguish a leak: %v", spec, retryErr)
		}
		retry()
		t.Fatalf("%q could not be grabbed immediately after stop() but was free on a retry; the release is not synchronous: %v", spec, err)
	}
	second()
}

// The grab path must not touch the process-wide X error handler at all.
//
// This is the "nobody put a handler back" guard: a swallow-everything handler
// is installed around a whole refused registration, and afterwards it must have
// caught NOTHING, because a checked request's error goes to its cookie and is
// never dispatched. If someone reintroduces an XSetErrorHandler install on this
// path -- or adds an unchecked request to this connection -- the count goes
// non-zero and this fails.
//
// Being straight about what it does NOT prove: it is not a base-commit
// regression test. The mechanism #577 replaced installed its OWN handler at
// create entry, which displaced this impostor, so the old code passes this too
// (measured, not assumed). The test that discriminates is
// TestLinuxXCheckedGrabKeepsItsRefusalFromTheGlobalHandler below, which opens
// the foreign handler's window where it actually matters.
func TestLinuxXRefusalSurvivesAStolenErrorHandler(t *testing.T) {
	// Its own combination, so a parallel run of this package elsewhere cannot
	// make the squatter grab below fail for an unrelated reason.
	const spec = "ctrl+alt+shift+super+g"

	held, err := startHotkeyListener(spec, func() {})
	if err != nil {
		requireX(t, "cannot grab %q here: %v", spec, err)
	}
	defer held()

	// Stand in for GDK for exactly the window the grab occupies.
	//
	// t.Cleanup as well as the straight-line call: a panic or a t.Fatal between
	// the steal and the restore would otherwise leave a swallow-all
	// XErrorHandler installed process-wide for every later test in this binary,
	// all of them feeding one shared counter. restore is idempotent, so calling
	// it twice is free.
	restore := stealHotkeyErrorHandler()
	t.Cleanup(func() { restore() })
	second, secondErr := startHotkeyListener(spec, func() {})
	caught := restore()

	if second != nil {
		second()
		t.Error("a refused grab handed back a stop function; callers read a non-nil stop as a live hotkey")
	}
	if secondErr == nil {
		t.Fatal("with a foreign X error handler installed, a second grab of a held combination came back as SUCCESS; the refusal was swallowed by the global handler, which is exactly what #577 removed from the path")
	}
	if !strings.Contains(secondErr.Error(), "already held") {
		t.Errorf("the refusal should still be reported as the combination being held, got: %v", secondErr)
	}
	// The positive half: a checked request's error is handed to the caller and
	// never dispatched, so the global handler must not see it even once.
	if caught != 0 {
		t.Errorf("the process-wide X error handler was consulted %d time(s) during a checked grab; it must be 0, or the refusal is still something another library can steal", caught)
	}
	t.Logf("refusal reported as: %v (foreign handler consulted %d times)", secondErr, caught)
}

// The refusal must survive a foreign error handler installed in the exact
// window a GDK error trap occupies. This is #577's reason to exist, and unlike
// the test above it is a real discriminator.
//
// The window is between our request reaching the wire and its reply being read:
// that is the span gdk_x11_display_error_trap_push/pop covers, and it is the
// only span in which the global handler's owner decides where our BadAccess
// goes. hotkeyGrabUnderHijackedHandler manufactures it exactly -- flush, then
// install the impostor, then collect -- rather than waiting for a GTK loop to
// produce it by chance.
//
// Measured side by side against the mechanism this replaced, same server, same
// contended grab, in that same window:
//
//	XGrabKey + recording handler + XSync   refusal LOST, impostor swallowed 1,
//	                                       create would report SUCCESS (#574)
//	xcb checked + xcb_request_check        refusal KEPT (code=10 major=33),
//	                                       impostor swallowed 0
//
// So this test fails on the old mechanism and passes on this one, which is the
// property a mechanism swap has to demonstrate rather than assert.
func TestLinuxXCheckedGrabKeepsItsRefusalFromTheGlobalHandler(t *testing.T) {
	const spec = "ctrl+alt+shift+super+h"

	// A squatter on our own connection, so there is a refusal to lose.
	held, err := startHotkeyListener(spec, func() {})
	if err != nil {
		requireX(t, "cannot grab %q here: %v", spec, err)
	}
	defer held()

	refused, errorCode, requestCode, handlerCalls, usable := hotkeyGrabUnderHijackedHandler(spec)
	if !usable {
		requireX(t, "no usable X connection for %q", spec)
	}

	if !refused {
		t.Fatal("a grab of a held combination came back GRANTED while a foreign X error handler owned the slot across the round trip; the refusal was stolen, which is the #577 hole")
	}
	if handlerCalls != 0 {
		t.Errorf("the foreign handler swallowed %d error(s); a checked request's error must go to its cookie and never be dispatched", handlerCalls)
	}
	// The same two numbers linuxGrabError gates its "already held" wording on,
	// asserted against the real X protocol constants rather than a comment.
	if errorCode != hkBadAccess || requestCode != hkOpcodeGrab {
		t.Errorf("refusal reported as error_code=%d request_code=%d, want BadAccess(%d) on X_GrabKey(%d); linuxGrabError's wording depends on both",
			errorCode, requestCode, hkBadAccess, hkOpcodeGrab)
	}
	t.Logf("refusal kept: error_code=%d request_code=%d, foreign handler swallowed %d", errorCode, requestCode, handlerCalls)
}

// A dead X connection must not read as a granted grab.
//
// This is the one lie a checked request can tell, and it is the refusal path
// the move from XSync to xcb would otherwise have dropped:
// `xcb_request_check` returns NULL when the server said yes AND when there is
// no server, because once the connection has an error every request is
// discarded and every check comes back clean. Without the
// xcb_connection_has_error test in hk_grab_variants, a create over a dying
// connection returns failed_mask=0, granted=0xf and HK_OK -- a non-nil stop
// function and a "registered" log line for a hotkey that can never fire, which
// is #574 reached through the fix for it.
//
// The mechanism this replaced could not produce that: XSync on a dead
// connection takes libX11's fatal-IO path, which is brutal but never silent.
//
// The window is narrow and it is not hypothetical: it is between XOpenDisplay
// and the verdict, and the sidecar re-registers its hotkeys around session
// logout and X server restarts, which is exactly when a connection dies
// mid-sequence.
func TestLinuxXADeadConnectionIsNotReportedAsAGrantedGrab(t *testing.T) {
	// A combination nothing else is asked to hold: the point is the dead
	// socket, not contention, and this must not depend on whether the grab
	// would have been granted.
	const spec = "ctrl+alt+shift+super+d"

	stage, ok := hotkeyGrabOverBrokenConnection(spec)
	if !ok {
		requireX(t, "no usable X display for %q", spec)
	}

	if stage == hkGrabOK {
		t.Fatal("a grab over a connection whose socket had been replaced reported HK_OK with every variant granted; a dead hotkey would be logged as registered (#574 via #577's own mechanism)")
	}
	if stage != hkGrabConnLost {
		t.Fatalf("stage = %d, want hkGrabConnLost (%d); a broken connection has to be its own outcome, not folded into a refusal or a missing display", stage, hkGrabConnLost)
	}
	// And the message a user would actually see.
	err := linuxGrabError(spec, stage, 0, 0, 0, true)
	if err == nil {
		t.Fatal("hkGrabConnLost produced no error")
	}
	t.Logf("dead connection reported as: %v", err)
}

// The listener must work when its X connection fd lands at or above
// FD_SETSIZE (#587).
//
// The old run loop did FD_SET(fd) into a fixed 1024-bit fd_set. An fd at or
// above that is undefined behaviour: measured on a real connection forced up
// there, a fortified build aborts and an unfortified one writes out of bounds
// silently:
//
//	X connection fd = 1067  (FD_SETSIZE = 1024)
//	poll() on fd 1067 returned 0 (revents=0x0)
//	FD_SET(1067) -> *** bit out of range 0 - FD_SETSIZE on fd_set ***: terminated
//
// Nothing chose that number. The kernel hands out the lowest free fd, and the
// sidecar holds browser pipes, a panel webview per panel, audio streams and its
// own socket, so an instance that has been up a while with many panels open
// gets there on its own. This test manufactures the same pressure.
//
// Against the pre-#587 code this does not fail politely. FD_SET runs on the
// listener goroutine, so the whole test binary goes down with SIGABRT:
//
//	a fresh X connection lands at fd 1070, above FD_SETSIZE (1024)
//	[hotkeys] registered "ctrl+alt+shift+super+f"
//	*** bit out of range 0 - FD_SETSIZE on fd_set ***: terminated
//	SIGABRT: abort ... signal arrived during cgo execution
//	github.com/jarvis/sidecar._Cfunc_jarvisHotkeyRun
//
// THE CATCH, measured rather than guessed: that abort is glibc's fortified
// FD_SET. Built WITHOUT fortification the same broken select() code passes this
// test, because the out-of-bounds write lands in adjacent stack memory that
// select() then happens to read back. There is no portable observable
// difference -- undefined behaviour that works by accident is still what it is.
//
// So two things carry the guard rather than one: the precondition assertion
// below, which refuses to report success if the fd did not clear the ceiling,
// and CI compiling this package with -D_FORTIFY_SOURCE=2 so the abort is
// deterministic there. On a local unfortified toolchain this test confirms the
// fix works; it cannot by itself condemn the old code.
func TestLinuxXListenerSurvivesAnFdAboveFdSetsize(t *testing.T) {
	const spec = "ctrl+alt+shift+super+f"

	// IS THE DETECTOR ARMED? Asked out loud, because the answer decides what a
	// PASS from this test is worth, and the test cannot otherwise tell.
	//
	// Unfortified, FD_SET on an out-of-range fd writes out of bounds and
	// returns, so the pre-#587 code passes everything below. Fortified, it
	// aborts. Where the tests are enforced (CI) that is not allowed to be a
	// matter of luck; locally it is worth a line of output rather than a
	// failure, because the run still confirms poll() works.
	if level := hotkeyFortifyLevel(); level == 0 {
		if os.Getenv(requireXHotkeyTests) == "1" {
			t.Fatalf("this package was compiled with no _FORTIFY_SOURCE, so FD_SET on an out-of-range fd would NOT abort and this test could not catch a reintroduced select() -- %s=1 means that guard has to be real here; check CGO_CFLAGS on this job's step",
				requireXHotkeyTests)
		}
		t.Logf("compiled unfortified: this run confirms poll() copes with a high fd, but could NOT have caught a reintroduced select()")
	} else {
		t.Logf("compiled with _FORTIFY_SOURCE level %d, so a reintroduced FD_SET(fd >= FD_SETSIZE) would abort", level)
	}

	// The soft limit is READ, not raised, and that is a correctness point
	// rather than a simplification.
	//
	// Two reasons, both from syscall/rlimit.go rather than from guessing:
	//
	//  1. Go's own init() already raises this soft limit towards the hard limit
	//     at startup, precisely so Go programs are not bound by the select()
	//     ceiling this test is about. There is nothing left to raise.
	//  2. syscall.Setrlimit(RLIMIT_NOFILE, ...) does `origRlimitNofile.Store(nil)`,
	//     which is the flag StartProcess reads to decide whether to put the
	//     ORIGINAL soft limit back for a child. Setting the limit here therefore
	//     changes what every subprocess started by any later test in this binary
	//     inherits -- and a t.Cleanup restore cannot undo it, because the record
	//     it would need has already been thrown away.
	//
	// This package spawns Chromium and shells in other tests, so that was a
	// real side effect on unrelated code in exchange for nothing.
	var lim syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &lim); err != nil {
		requireX(t, "cannot read RLIMIT_NOFILE: %v", err)
	}
	if lim.Cur <= uint64(hotkeyFdSetSize)+64 {
		requireX(t, "the soft fd limit (%d) is too low to reach FD_SETSIZE (%d)", lim.Cur, hotkeyFdSetSize)
	}

	// Fill every fd number below the ceiling so the next socket the kernel
	// hands out is above it.
	//
	// syscall.Open and raw ints on purpose, NOT os.OpenFile: an *os.File has a
	// finaliser, and one of them being collected mid-test would close an fd
	// below the ceiling and punch a hole for the X connection to fall into,
	// silently making the test vacuous. O_CLOEXEC on purpose too -- this
	// package spawns Chromium and shells in other tests, and 1100 inherited
	// fds is a mess to debug.
	var filler []int
	t.Cleanup(func() {
		for _, fd := range filler {
			_ = syscall.Close(fd)
		}
	})
	fill := func(n int) bool {
		for i := 0; i < n; i++ {
			fd, err := syscall.Open("/dev/null", syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
			if err != nil {
				return false
			}
			filler = append(filler, fd)
		}
		return true
	}
	if !fill(hotkeyFdSetSize + 40) {
		t.Fatalf("could only open %d of the %d filler fds needed to push a connection past FD_SETSIZE",
			len(filler), hotkeyFdSetSize+40)
	}

	// THE PRECONDITION, asserted rather than assumed: if a fresh connection
	// still lands below the ceiling, this test cannot distinguish poll() from
	// select() and must not report success.
	//
	// Adaptive, because the fill above only accounts for fds this test opened.
	// Anything else in the process that frees a low fd -- a finalised *os.File
	// or net.Conn from an earlier test, a goroutine closing a connection --
	// punches a hole, and the probe lands in it -- the kernel hands out the
	// LOWEST free descriptor, so a single hole anywhere below the ceiling beats
	// a thousand correctly-held fds. Each iteration plugs the hole it just
	// found (the next open takes that same lowest free fd by definition) and
	// tries again, so a handful of holes costs a handful of descriptors instead
	// of a red build. Without this the assertion below is a hard CI failure
	// caused by an unrelated test's garbage collection.
	probe := -1
	for attempt := 0; attempt < 64; attempt++ {
		probe = hotkeyProbeConnectionFd()
		if probe < 0 {
			requireX(t, "no X display, so the listener cannot be started at all")
		}
		if probe >= hotkeyFdSetSize {
			break
		}
		if !fill(1) {
			break
		}
	}
	if probe < hotkeyFdSetSize {
		t.Fatalf("a fresh X connection still got fd %d, below FD_SETSIZE (%d), after plugging holes; this test would pass against the broken select() code too, so it must not report success",
			probe, hotkeyFdSetSize)
	}
	t.Logf("a fresh X connection lands at fd %d, above FD_SETSIZE (%d), holding %d filler fds", probe, hotkeyFdSetSize, len(filler))

	// The listener's own connection now gets a number in the same range, and
	// its run loop has to cope. With select() this is where it dies.
	stop, err := startHotkeyListener(spec, func() {})
	if err != nil {
		t.Fatalf("registering %q with a high-numbered connection fd failed: %v", spec, err)
	}
	if stop == nil {
		t.Fatal("a successful registration returned a nil stop function")
	}
	// stop() writes the self-pipe and waits for the run loop to return, so this
	// returning at all proves the loop reached its poll() and came back out of
	// it rather than aborting or spinning.
	stop()
}

// The partial clash is the case the all-or-nothing decision exists for, so it
// gets a real X round trip rather than a claim in a comment.
//
// A squatter takes ONE modifier variant (the plain one). The combination is then
// neither free nor fully taken, which is exactly the state that used to produce
// a hotkey working only in some lock states. startHotkeyListener must refuse the
// whole thing, name the variant that clashed, and leave nothing grabbed.
func TestLinuxXPartialClashIsRefusedWholesale(t *testing.T) {
	const spec = "ctrl+alt+shift+super+p"

	// Variant 0 is the plain modifier mask; the lock variants stay free.
	releaseSquatter, ok := hotkeyHoldOneVariant(spec, 0)
	if !ok {
		requireX(t, "could not hold one variant of %q (no display, or something already holds it)", spec)
	}
	defer releaseSquatter()

	stop, err := startHotkeyListener(spec, func() {})
	if err == nil {
		if stop != nil {
			stop()
		}
		t.Fatal("a combination whose plain variant is held came back as SUCCESS; a partial grab was kept, which is a hotkey that works only in some lock states")
	}
	if stop != nil {
		t.Fatal("a refused grab handed back a stop function; callers read a non-nil stop as a live hotkey")
	}
	if !strings.Contains(err.Error(), "plain") {
		t.Errorf("the message should name the variant that clashed, got: %v", err)
	}
	if !strings.Contains(err.Error(), "refused as a whole") {
		t.Errorf("the message should say the whole grab was refused, got: %v", err)
	}
	t.Logf("partial clash reported as: %v", err)

	// The lock variants the refused create was granted must have been released:
	// if they were not, this second single-variant grab would be refused. This
	// is the cleanup proof that XCloseDisplay alone would also have provided,
	// asserted rather than assumed.
	releaseProbe, ok := hotkeyHoldOneVariant(spec, 1) // LockMask
	if !ok {
		t.Fatal("the CapsLock variant is still held; a refused create left part of the combination grabbed")
	}
	releaseProbe()
}
