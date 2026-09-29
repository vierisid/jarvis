//go:build linux

package main

// Linux global hotkeys via X11 XGrabKey.
//
// Each hotkey opens its own X display connection, grabs the key on the root
// window (with the NumLock/CapsLock modifier variants so it fires regardless of
// lock state), and runs a select() loop over the X connection fd + a self-pipe
// so it can be stopped cleanly. KeyPress fires the Go callback.
//
// Wayland note: XGrabKey only reaches X11 (or XWayland) clients. Under a native
// Wayland session global grabs need the compositor's shortcuts protocol; that
// is a separate follow-up. On X11/XWayland this works.

/*
#cgo pkg-config: x11

#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/Xutil.h>
#include <X11/Xproto.h>
#include <errno.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>

extern void goHotkeyFire(unsigned long long id);

typedef struct {
    Display*           dpy;
    Window             root;
    int                keycode;
    unsigned int       mods;
    unsigned int       granted;   // bit i = variant i is currently grabbed
    int                stopfd[2];
    unsigned long long id;
} Hotkey;

// The lock-key modifier variants. X matches a passive grab on the EXACT
// modifier mask, so `ctrl+shift+space` does not fire with Caps Lock held
// unless mods|LockMask is grabbed as its own request.
static const unsigned int HK_VARIANTS[4] = { 0, LockMask, Mod2Mask, LockMask | Mod2Mask };

// Outcome of jarvisHotkeyCreate. Kept apart from Hotkey so a refusal can
// describe itself: Go turns this into the user-visible message.
enum {
    HK_OK          = 0,
    HK_NO_DISPLAY  = 1,
    HK_NO_KEYCODE  = 2,
    HK_REFUSED     = 3,
    HK_NO_PIPE     = 4
};

typedef struct {
    Hotkey*       hk;           // NULL unless stage == HK_OK
    int           stage;
    unsigned char error_code;   // X error code, first one seen
    unsigned char request_code; // X opcode it was attributed to
    unsigned int  failed_mask;  // bit i = HK_VARIANTS[i] was refused
} HotkeyResult;

// ---------------------------------------------------------------------------
// Catching a refused grab
//
// XGrabKey is asynchronous: it has no useful return value, and a refusal comes
// back later as an X error event. So the only way to learn that a grab was
// refused is to install an error handler, force a round trip with XSync, and
// see what the handler caught. That is the whole reason this machinery exists
// (issue #574: before it, a refused grab was reported as SUCCESS and the
// hotkey was silently dead, with "registered" in the log).
//
// The handler this replaces did `return 0` for everything. That was not
// gratuitous: XLib's DEFAULT handler prints the error and calls exit(1), so
// without a handler a contended hotkey would kill the sidecar. The no-crash
// property is load-bearing and is kept; only the blindness is gone.
//
// XSetErrorHandler is PROCESS-WIDE, and the sidecar runs GTK/GDK on its main
// thread at the same time, so scoping matters in both directions:
//
//   - We claim an error only when it arrived on OUR display, which is freshly
//     opened by this create and touched by nothing else in the process. A
//     Display* cannot be confused with a stale one: the only way to collide is
//     with a closed connection, and a closed connection delivers no errors.
//   - Anything on ANOTHER display is handed to the handler that was installed
//     before us (GDK's, in practice) rather than swallowed. This is safe
//     because X errors are dispatched by whichever thread makes the XLib call
//     on that display -- an error on GDK's display can only enter this handler
//     from the GTK main thread, which is exactly where `prev` would have run
//     anyway. Installing this handler does not move anybody's error onto a
//     different thread.
//   - We claim NON-XGrabKey errors on our own display too, and report them
//     rather than delegating. Handing them to GDK would be worse than useless:
//     it would look our Display* up among its own GdkDisplays, find nothing,
//     and silently return -- a protocol error on our connection dropped on the
//     floor, which is the exact failure mode #574 is about.
//
// Residual, and deliberately not papered over: if `prev` is NULL (nobody had
// installed a handler) an error on somebody else's display is ignored rather
// than crashing the process. That is the status quo for this window and is the
// safer of the two, since XLib's alternative is exit(1) on an error that is not
// even ours. The window is a few microseconds per hotkey, at startup.
typedef struct {
    Display* volatile      dpy;
    volatile XErrorHandler prev;
    volatile unsigned char code;
    volatile unsigned char request;
    volatile int           armed;
} HkGrabWatch;

// Written only by a create, which the Go side serialises on hotkeyCreateMu.
// volatile because the GTK main thread reads these fields whenever an X error
// of its own reaches hk_grab_error.
static HkGrabWatch hk_watch;

static int hk_grab_error(Display* d, XErrorEvent* e) {
    if (hk_watch.armed && d == hk_watch.dpy) {
        // First error wins: a create that trips several variants should report
        // the reason it first hit, not the last.
        if (hk_watch.code == 0) {
            hk_watch.code    = e->error_code;
            hk_watch.request = e->request_code;
        }
        return 0;
    }
    XErrorHandler prev = hk_watch.prev;
    if (prev != NULL) return prev(d, e);
    return 0;
}

// hk_keysym resolves a key name ("space", "k", "Return") to a KeySym without
// needing an open display.
static unsigned long hk_keysym(const char* name) {
    return (unsigned long)XStringToKeysym(name);
}

// jarvisHotkeyCreate grabs the key and every lock variant, or reports why it
// could not. ALL-OR-NOTHING: if any variant is refused the whole create fails
// and the variants that were granted are released again.
//
// The alternative -- keep whatever the server gave us and warn -- was rejected.
// A hotkey that works only with Num Lock off is the same silent failure this
// code exists to stop, one layer down, and harder to diagnose for being
// intermittent; and holding passive grabs we have just reported as
// unregistered would sit on those combinations for every other client while
// doing nothing with them.
static HotkeyResult jarvisHotkeyCreate(unsigned int mods, unsigned long keysym, unsigned long long id) {
    HotkeyResult r;
    memset(&r, 0, sizeof(r));

    Display* dpy = XOpenDisplay(NULL);
    if (!dpy) { r.stage = HK_NO_DISPLAY; return r; }

    Window root = DefaultRootWindow(dpy);

    // Keycode 0 is AnyKey, not "no key": XGrabKey(d, 0, ...) would grab EVERY
    // key with these modifiers. A keysym the active layout does not carry maps
    // to 0, so this guard is what keeps an unmapped `f19` from hijacking the
    // whole keyboard.
    int keycode = XKeysymToKeycode(dpy, (KeySym)keysym);
    if (keycode == 0) { XCloseDisplay(dpy); r.stage = HK_NO_KEYCODE; return r; }

    // Before the grabs, so a pipe failure needs no ungrab path. A Hotkey with
    // no stop pipe cannot be stopped at all (jarvisHotkeyStop becomes a no-op
    // and stop() then blocks forever on its done channel), so it is a failed
    // create like any other rather than a half-working handle.
    int stopfd[2];
    if (pipe(stopfd) != 0) { XCloseDisplay(dpy); r.stage = HK_NO_PIPE; return r; }

    hk_watch.dpy     = dpy;
    hk_watch.code    = 0;
    hk_watch.request = 0;
    hk_watch.armed   = 1;
    hk_watch.prev    = NULL;
    // The handler goes live one instruction before prev is known -- XSetErrorHandler
    // gives no way to avoid that. prev is pre-set to NULL above so the gap reads a
    // defined value; the cost of an error landing inside it is that somebody else's
    // error is ignored instead of delegated.
    hk_watch.prev = XSetErrorHandler(hk_grab_error);

    // One variant per round trip. Grabbing all four and syncing once would
    // still DETECT a refusal, but could not say which variant caused it
    // without matching request serial numbers by hand. X guarantees an error
    // for request N is delivered before the reply to any later request, so the
    // XSync's own reply cannot overtake the grab's error: attribution is exact
    // and there is no race between the grab and the sync.
    //
    // Four round trips on a unix socket, at startup, per hotkey.
    unsigned int granted = 0;
    for (int i = 0; i < 4; i++) {
        hk_watch.code    = 0;
        hk_watch.request = 0;
        XGrabKey(dpy, keycode, mods | HK_VARIANTS[i], root, False, GrabModeAsync, GrabModeAsync);
        XSync(dpy, False);
        if (hk_watch.code != 0) {
            r.failed_mask |= (1u << i);
            if (r.error_code == 0) {
                r.error_code   = hk_watch.code;
                r.request_code = hk_watch.request;
            }
        } else {
            granted |= (1u << i);
        }
    }

    if (r.failed_mask != 0) {
        // Release what we were given. Note this runs while the watch is still
        // armed and the handler still installed: restoring first would expose
        // an ungrab error to XLib's exit(1) default. An ungrab error is
        // recorded rather than delegated (same display), which is harmless --
        // first-error-wins means it cannot overwrite the grab refusal we are
        // about to report.
        //
        // Honest note on redundancy: XCloseDisplay below already releases every
        // grab held by this connection, and that was verified against a real
        // X server -- removing this loop changes nothing observable today. It
        // stays because it is nearly free, it says what it means, and it
        // becomes load-bearing the moment anyone keeps the connection open on
        // the failure path.
        for (int i = 0; i < 4; i++) {
            if (granted & (1u << i)) XUngrabKey(dpy, keycode, mods | HK_VARIANTS[i], root);
        }
        XSync(dpy, False);
    }

    XSetErrorHandler(hk_watch.prev);
    hk_watch.armed = 0;
    hk_watch.dpy   = NULL;
    hk_watch.prev  = NULL;

    if (r.failed_mask != 0) {
        close(stopfd[0]);
        close(stopfd[1]);
        XCloseDisplay(dpy);
        r.stage = HK_REFUSED;
        return r;
    }

    Hotkey* hk = (Hotkey*)calloc(1, sizeof(Hotkey));
    if (!hk) {
        for (int i = 0; i < 4; i++) XUngrabKey(dpy, keycode, mods | HK_VARIANTS[i], root);
        close(stopfd[0]);
        close(stopfd[1]);
        XCloseDisplay(dpy);
        r.stage = HK_NO_PIPE;
        return r;
    }
    hk->dpy = dpy; hk->root = root; hk->keycode = keycode; hk->mods = mods;
    hk->granted = granted; hk->id = id;
    hk->stopfd[0] = stopfd[0]; hk->stopfd[1] = stopfd[1];
    r.hk = hk;
    r.stage = HK_OK;
    return r;
}

// jarvisHotkeyRun blocks until stopped, firing the Go callback on each KeyPress.
static void jarvisHotkeyRun(Hotkey* hk) {
    int xfd = ConnectionNumber(hk->dpy);

    // Drain anything the create's XSync calls already pulled into the
    // client-side queue. XSync(dpy, False) reads events in while it waits for
    // its reply but dispatches nothing, and the loop below blocks in select()
    // BEFORE looking at the queue -- so without this a key pressed during
    // startup would sit unread until the next unrelated socket wakeup.
    // (The `False` in those XSync calls is load-bearing for the same reason:
    // `True` would discard the queued KeyPress events outright.)
    while (XPending(hk->dpy)) {
        XEvent ev;
        XNextEvent(hk->dpy, &ev);
        if (ev.type == KeyPress) goHotkeyFire(hk->id);
    }

    for (;;) {
        fd_set fds; FD_ZERO(&fds);
        FD_SET(xfd, &fds);
        if (hk->stopfd[0] >= 0) FD_SET(hk->stopfd[0], &fds);
        int maxfd = xfd;
        if (hk->stopfd[0] > maxfd) maxfd = hk->stopfd[0];
        if (select(maxfd + 1, &fds, NULL, NULL, NULL) < 0) {
            // EINTR is not an error, and it is not rare here: the Go runtime
            // signals threads sitting in cgo (SIGURG for async preemption,
            // SIGPROF under the profiler). Breaking on it would end the
            // listener and leave the hotkey dead for the life of the process
            // with nothing in the log -- the #574 symptom by another route.
            if (errno == EINTR) continue;
            break;
        }
        if (hk->stopfd[0] >= 0 && FD_ISSET(hk->stopfd[0], &fds)) break;
        while (XPending(hk->dpy)) {
            XEvent ev;
            XNextEvent(hk->dpy, &ev);
            if (ev.type == KeyPress) goHotkeyFire(hk->id);
        }
    }
}

// jarvisHotkeyStop unblocks the run loop (write to the self-pipe — thread-safe,
// no XLib). Safe to call from a different goroutine than jarvisHotkeyRun.
static void jarvisHotkeyStop(Hotkey* hk) {
    if (hk && hk->stopfd[1] >= 0) { char c = 1; ssize_t n = write(hk->stopfd[1], &c, 1); (void)n; }
}

// jarvisHotkeyFree ungrabs + closes. Must run on the same goroutine as
// jarvisHotkeyRun (after it returns), since it touches XLib.
static void jarvisHotkeyFree(Hotkey* hk) {
    if (!hk) return;
    if (hk->dpy) {
        // Ungrab exactly the variants we hold. AnyModifier would ask the server
        // to drop every modifier combination for this keycode, which is a wider
        // claim than we ever made.
        for (int i = 0; i < 4; i++) {
            if (hk->granted & (1u << i))
                XUngrabKey(hk->dpy, hk->keycode, hk->mods | HK_VARIANTS[i], hk->root);
        }
        XCloseDisplay(hk->dpy);
    }
    if (hk->stopfd[0] >= 0) close(hk->stopfd[0]);
    if (hk->stopfd[1] >= 0) close(hk->stopfd[1]);
    free(hk);
}
*/
import "C"

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

var hotkeyReg sync.Map // uint64 -> func()
var hotkeyCounter atomic.Uint64

// hotkeyCreateMu serialises jarvisHotkeyCreate.
//
// Load-bearing, not decoration: XSetErrorHandler and the hk_watch slot it fills
// are both process-global, so two creates racing would have one of them reading
// the other's refusal. And they genuinely can race -- pebble_overlay_linux.go
// registers summon and palette back to back, but panels_runtime.go registers a
// panel's summon hotkey from inside the panel spawn goroutine, which is not
// ordered against either.
//
// Sufficient for our own creates. It cannot defend against a third party
// calling XSetErrorHandler concurrently; in practice GDK installs its handler
// once during gdk_init and GTK3's error traps use their own stack rather than
// this API, so that is a residual risk rather than something to design around.
var hotkeyCreateMu sync.Mutex

// startHotkeyListener registers a single global hotkey (e.g. "ctrl+shift+space")
// and fires onFire on each press. Returns a stop function.
//
// A refused grab comes back as an ERROR, the way the Windows backend already
// reports one. It used to come back as success: hk_ignore_error swallowed
// BadAccess and jarvisHotkeyCreate returned a Hotkey either way, so a
// combination another client already held was announced as "registered" and
// then never fired (#574). That matters most for the shipped defaults, which
// #569 moved to ctrl+shift+space / ctrl+shift+k -- both taken by VS Code, and
// ctrl+shift+k by Firefox, on a normal Linux desktop.
//
// VERIFIED, and how. This lives in the cgo half, so the pure-layer table test
// cannot reach it; the message wording is therefore split out into
// linuxGrabError in hotkeys_keyspec.go, which is cgo-free and table-tested on
// any OS. The grab path itself was exercised against a real X.Org server
// (X11 over WSLg, DISPLAY=:0) with a second connection deliberately holding the
// combination first:
//
//	free combination              all four variants granted
//	squatter holds base variant   BadAccess(10) on X_GrabKey(33), failed=0x1,
//	                              granted=0xe, create refused
//	third client afterwards       CAN take the LockMask variant, so the three
//	                              granted variants really were released
//	after squatter releases       all four granted again
//	unmapped keysym               HK_NO_KEYCODE, never an AnyKey grab
//
// TestLinuxRefusedGrabIsReported does the same double-grab from Go and skips
// when there is no display, so a developer with a desktop re-runs this proof
// with `go test` and headless CI skips it.
//
// Not reachable from here: whether a real desktop environment's own grabs
// (GNOME/KDE global shortcuts) refuse in the same way. They are X clients
// holding passive grabs like any other, so they should, but that wants a
// session to confirm.
func startHotkeyListener(keyspec string, onFire func()) (func(), error) {
	mods, keysym, err := parseLinuxKeyspec(keyspec)
	if err != nil {
		return nil, err
	}
	id := hotkeyCounter.Add(1)
	hotkeyReg.Store(id, onFire)

	type created struct {
		hk  *C.Hotkey
		err error
	}
	ch := make(chan created, 1)
	done := make(chan struct{})
	go func() {
		// XLib calls for one Display must stay on one thread; create + run + free
		// all happen here. Stop only writes a pipe (thread-safe) from elsewhere.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		hotkeyCreateMu.Lock()
		res := C.jarvisHotkeyCreate(C.uint(mods), C.ulong(keysym), C.ulonglong(id))
		hotkeyCreateMu.Unlock()

		if res.stage != C.HK_OK || res.hk == nil {
			ch <- created{nil, linuxGrabError(
				keyspec,
				int(res.stage),
				uint8(res.error_code),
				uint8(res.request_code),
				uint(res.failed_mask),
			)}
			close(done)
			return
		}
		ch <- created{res.hk, nil}
		C.jarvisHotkeyRun(res.hk)
		C.jarvisHotkeyFree(res.hk)
		close(done)
	}()

	res := <-ch
	if res.err != nil {
		hotkeyReg.Delete(id)
		return nil, res.err
	}
	hk := res.hk
	// Said here as well as by the caller, to match the Windows backend, which
	// logs the same line from inside its listener.
	log.Printf("[hotkeys] registered %q (mods=0x%x, keysym=0x%x)", keyspec, mods, keysym)
	stop := func() {
		C.jarvisHotkeyStop(hk)
		<-done
		hotkeyReg.Delete(id)
	}
	return stop, nil
}

// parseLinuxKeyspec turns "ctrl+space" / "ctrl+shift+k" into an X11 modifier
// mask + KeySym.
//
// The grammar and the key names come from hotkeys_keyspec.go, shared with the
// macOS and Windows backends. Only the keysym lookup is here, because it needs
// XLib: linuxKeysymName maps a canonical name to the CASE-SENSITIVE X spelling
// ("tab" -> "Tab", "pageup" -> "Prior", "f13" -> "F13"), and anything it does
// not know is passed through unchanged, so every key name XStringToKeysym
// already accepted still resolves.
func parseLinuxKeyspec(spec string) (mods uint, keysym uint64, err error) {
	parsed, err := parseKeyspec(spec)
	if err != nil {
		return 0, 0, err
	}
	cname := C.CString(linuxKeysymName(parsed.Key))
	defer C.free(unsafe.Pointer(cname))
	ks := uint64(C.hk_keysym(cname))
	if ks == 0 {
		return 0, 0, fmt.Errorf("unknown key %q in hotkey %q", parsed.Key, spec)
	}
	return linuxModifierMask(parsed.Mods), ks, nil
}
