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

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/Xutil.h>
#include <X11/Xproto.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>

extern void goHotkeyFire(unsigned long long id);

// The lock-key modifier variants. X matches a passive grab on the EXACT
// modifier mask, so `ctrl+shift+space` does not fire with Caps Lock held
// unless mods|LockMask is grabbed as its own request.
static const unsigned int HK_VARIANTS[4] = { 0, LockMask, Mod2Mask, LockMask | Mod2Mask };
#define HK_NVARIANTS ((int)(sizeof(HK_VARIANTS) / sizeof(HK_VARIANTS[0])))
#define HK_ALL_VARIANTS ((1u << HK_NVARIANTS) - 1u)

// The Go side mirrors HK_NVARIANTS in hkNumVariants and indexes hkVariantNames
// by the same bit positions; the Go constant block asserts the two agree.
_Static_assert(HK_NVARIANTS == 4, "hkVariantNames and HK_ALL_VARIANTS assume four variants");

typedef struct {
    Display*           dpy;
    Window             root;
    int                keycode;
    unsigned int       mods;
    unsigned int       granted;   // bit i = variant i is currently grabbed
    int                stopfd[2];
    unsigned long long id;
} Hotkey;

// Outcome of jarvisHotkeyCreate. Kept apart from Hotkey so a refusal can
// describe itself: Go turns this into the user-visible message.
enum {
    HK_OK          = 0,
    HK_NO_DISPLAY  = 1,
    HK_NO_KEYCODE  = 2,
    HK_REFUSED     = 3,
    HK_NO_PIPE     = 4,
    HK_NO_MEM      = 5
};

typedef struct {
    Hotkey*       hk;           // NULL unless stage == HK_OK
    int           stage;
    unsigned char error_code;   // X error code, first one seen
    unsigned char request_code; // X opcode it was attributed to
    unsigned int  failed_mask;  // bit i = HK_VARIANTS[i] was refused
    int           slot_stolen;  // the global handler was not ours when we checked
} HotkeyResult;

// ---------------------------------------------------------------------------
// Catching a refused grab
//
// XGrabKey is asynchronous: it has no useful return value, and a refusal comes
// back later as an X error event. So the only way to learn that a grab was
// refused is to install an error handler, force a round trip with XSync, and
// see what the handler caught. That is the whole reason this machinery exists
// (issue #574: before it, a refused grab was reported as SUCCESS and the hotkey
// was silently dead, with "registered" in the log).
//
// The handler this replaces did `return 0` for everything. That was not
// gratuitous: XLib's DEFAULT handler prints the error and calls exit(1), so
// without a handler a contended hotkey would kill the sidecar. That no-crash
// property is kept -- but only for this window, which is all it ever covered:
// no handler is installed during jarvisHotkeyRun or jarvisHotkeyFree, so an X
// error there still reaches XLib's default. True before this change too.
//
// We claim an error only when it arrived on OUR display, which is freshly
// opened by this create and touched by nothing else in the process. Two things
// make the pointer test safe, and the ORDERING is the load-bearing one: disarm
// (below) always happens before XCloseDisplay, so hk_watch.dpy is never a
// dangling pointer while armed. Secondarily, hotkeyCreateMu guarantees exactly
// one live create display at a time and XOpenDisplay cannot return an address
// equal to another live Display*.
//
// We claim NON-XGrabKey errors on our own display too, and report them rather
// than delegating, because nothing else issues requests on that connection
// inside this window. linuxGrabError still gates the "already held" wording on
// request_code == X_GrabKey, so an unrelated error is never described as a
// clash.
//
// ---------------------------------------------------------------------------
// KNOWN LIMIT, verified rather than assumed: we do not own this slot
//
// XSetErrorHandler is PROCESS-WIDE, and GDK writes it constantly. An earlier
// version of this comment claimed GDK installs its handler once at gdk_init and
// that GTK3's error traps use a private stack. That is FALSE. Disassembling the
// linked libgdk-3.so.0.2420.32 (GTK 3.24.52) shows XSetErrorHandler has three
// call sites, two of which are the error traps:
//
//	gdk_x11_display_error_trap_push       calls XSetErrorHandler(gdk_x_error)
//	                                      unconditionally, on EVERY push, and
//	                                      saves the old value it displaced
//	gdk_x11_display_error_trap_pop_internal   restores that saved value
//
// There are 55 trap-push call sites inside libgdk alone (event translation, WM
// protocol filters, window move/focus, monitor geometry), all on the GTK main
// thread, and libgdk even carries the string "XSetErrorHandler() called with a
// GDK error trap pushed. Don't do that." So the save/install/restore below
// shares a lock-free global word with a library that rewrites it many times a
// second. hotkeyCreateMu serialises OUR creates against each other; it cannot
// mediate GDK.
//
// Two consequences, both real:
//
//   - If a GDK trap push/pop straddles a grab, our BadAccess is delivered to
//     gdk_x_error, which walks its own GdkDisplay list, does not find our
//     private connection, and returns 0. The refusal is dropped and the grab
//     looks granted. So this fix is reliable, not certain: it reports a refusal
//     unless a trap window overlaps that exact round trip. Still strictly
//     better than before, when a refusal was reported as success every time.
//   - If our restore lands between GDK's push and pop, GDK's pop can reinstall
//     hk_grab_error as the process-wide steady state. Detected below rather
//     than left to chance, because in that state a later create would get its
//     own handler back as `prev` and delegating would recurse forever.
//
// This race predates the change (the old code did the same save/install/restore
// with hk_ignore_error); what is new is that it can defeat the fix. The grab
// loop below re-checks after EVERY round trip that the handler is still ours
// and reports when it was not, which narrows the silent window to a single
// grab, but does not close it.
//
// Closing it properly means not sharing the slot at all. The better of the two
// options is to issue the grabs as xcb CHECKED requests
// (xcb_grab_key_checked + xcb_request_check), which hand the error straight
// back to the caller and never consult the global handler; the other is a
// single recording handler installed for the process lifetime, though GDK
// displaces even that on every trap push, so it fixes the corruption without
// fixing the detection. Either is a bigger change than this fix should carry.
// Filed as #577.
typedef struct {
    Display* volatile      dpy;
    volatile XErrorHandler prev;
    volatile unsigned char code;
    volatile unsigned char request;
    volatile int           armed;
} HkGrabWatch;

// Written by jarvisHotkeyCreate and by jarvisHotkeyGrabOne, both of which the
// Go side serialises on hotkeyCreateMu, and read by the GTK main thread
// whenever an X error of its own reaches hk_grab_error.
//
// `volatile` here buys exactly one thing: the compiler may not cache, elide or
// reorder these accesses relative to each other, nor hoist them across the
// opaque XSetErrorHandler call that publishes the handler. It is NOT atomicity
// and NOT a memory barrier. What makes that adequate here: all five fields are
// naturally aligned and word-sized or smaller, so no read can tear; x86-64 is
// store-ordered, so the arming stores are visible before the handler becomes
// reachable; and `armed` is cleared FIRST on the retire side, so a reader that
// gets past it never goes on to test a dpy we are about to close. The worst
// remaining outcome is a foreign error delegated to a slightly stale `prev`,
// which is why `prev` is deliberately NOT cleared on retire.
//
// Deliberately NOT claimed: that XSetErrorHandler's internal lock fences
// anything. It takes libX11's global mutex only when XInitThreads has been
// called, and nothing here calls it -- nor does the linked GTK3 stack import it
// (checked with objdump on libgtk-3 and libgdk-3). On a weakly ordered target
// this would want real acquire/release instead of volatile.
static HkGrabWatch hk_watch;

// hk_swallow_error is the fallback for the one case where there is no sane
// handler to put back: the global slot already held hk_grab_error when we went
// to install, meaning it was left there by a clobber (see KNOWN LIMIT).
//
// It exists because XSetErrorHandler(NULL) does NOT mean "leave the slot
// alone" -- libX11 explicitly installs _XDefaultError, which calls exit(1). So
// restoring NULL there would arm a process-wide crash on the next untrapped X
// error anywhere in the sidecar, on precisely the path that is supposed to be
// making things safer. Swallowing is what this code did before #574 when the
// slot was clobbered, and a mute daemon beats a dead one.
static int hk_swallow_error(Display* d, XErrorEvent* e) { (void)d; (void)e; return 0; }

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
    // Never call ourselves. If the global slot was clobbered so that `prev` is
    // this very function, delegating would recurse until the stack is gone --
    // a SIGSEGV inside an X error handler, with no Go panic and no log line.
    // The install below refuses to store that value, so this is belt and
    // braces for the case where it is stored by some other route.
    if (prev != NULL && prev != hk_grab_error) return prev(d, e);
    // Nobody to delegate to. Swallowing is the status quo for this window and
    // beats XLib's alternative, which is exit(1) over an error that is not even
    // ours.
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

    // Both allocations happen BEFORE the grabs, so neither failure needs an
    // ungrab path and neither runs while the error handler is installed.
    //
    // O_CLOEXEC matters: Go sets it on every fd it opens itself, but a raw
    // pipe() from cgo leaks both ends into every child process. The sidecar
    // runs shell commands on request (handlers.go), and a child holding the
    // write end could stop this hotkey listener by writing one byte to it.
    int stopfd[2];
    if (pipe2(stopfd, O_CLOEXEC) != 0) { XCloseDisplay(dpy); r.stage = HK_NO_PIPE; return r; }

    // A Hotkey with no stop pipe cannot be stopped at all (jarvisHotkeyStop
    // becomes a no-op and stop() then blocks forever on its done channel), so a
    // failure here is a failed create like any other rather than a half-working
    // handle.
    Hotkey* hk = (Hotkey*)calloc(1, sizeof(Hotkey));
    if (!hk) {
        close(stopfd[0]);
        close(stopfd[1]);
        XCloseDisplay(dpy);
        r.stage = HK_NO_MEM;
        return r;
    }

    hk_watch.dpy     = dpy;
    hk_watch.code    = 0;
    hk_watch.request = 0;
    hk_watch.prev    = NULL;
    hk_watch.armed   = 1;

    // The handler becomes reachable inside XSetErrorHandler, one statement
    // before `prev` is known; the API offers no way to avoid that. prev is
    // pre-set to NULL above so the gap reads a defined value, and the cost of a
    // foreign error landing inside it is that it is swallowed rather than
    // delegated.
    XErrorHandler displaced = XSetErrorHandler(hk_grab_error);
    if (displaced == hk_grab_error) {
        // We were already the installed handler, which we never leave behind on
        // purpose: the global slot has been clobbered (see KNOWN LIMIT above).
        // Storing it would make delegation infinitely recursive.
        r.slot_stolen = 1;
        hk_watch.prev = hk_swallow_error;
    } else {
        // May legitimately be NULL, meaning nothing was installed; restoring
        // NULL then reinstates XLib's default, which is the state that was
        // actually in effect, so that case is faithful rather than a new crash.
        hk_watch.prev = displaced;
    }

    // One variant per round trip. Grabbing all four and syncing once would
    // still DETECT a refusal, but could not say which variant caused it
    // without matching request serial numbers by hand. X guarantees an error
    // for request N is delivered before the reply to any later request, so the
    // XSync's own reply cannot overtake the grab's error: attribution is exact
    // and there is no race between the grab and the sync.
    //
    // Four round trips on a unix socket, at startup, per hotkey. The latency is
    // irrelevant; what it does cost is holding the global handler slot about
    // four times longer, which widens the GDK window described above.
    unsigned int  granted = 0;
    int           stolen  = 0;
    XErrorHandler thief   = NULL;
    for (int i = 0; i < HK_NVARIANTS; i++) {
        hk_watch.code    = 0;
        hk_watch.request = 0;
        XGrabKey(dpy, keycode, mods | HK_VARIANTS[i], root, False, GrabModeAsync, GrabModeAsync);
        XSync(dpy, False);
        // Was the slot still ours for THIS round trip? A "no error recorded"
        // verdict only means anything while our handler is the installed one.
        // Checking per variant rather than once at the end narrows the window
        // in which a refusal can go unnoticed from "any GDK trap overlapping
        // the whole four-request sequence" to "a trap that opens and closes
        // inside this single grab". Re-installing ours keeps the remaining
        // variants observable; the displaced handler is put back at retire.
        XErrorHandler current = XSetErrorHandler(hk_grab_error);
        if (current != hk_grab_error) { r.slot_stolen = 1; stolen = 1; thief = current; }
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
        // Release what we were given, while the watch is still armed and our
        // handler still installed: restoring first would expose an ungrab error
        // to XLib's exit(1) default. An ungrab error is recorded rather than
        // delegated (same display), which is harmless -- first-error-wins means
        // it cannot overwrite the grab refusal we are about to report.
        //
        // Honest note on redundancy: XCloseDisplay below already releases every
        // grab held by this connection, and that was verified against a real X
        // server -- removing this loop changes nothing observable today. It
        // stays because it is nearly free, it says what it means, and it
        // becomes load-bearing the moment anyone keeps the connection open on
        // the failure path.
        for (int i = 0; i < HK_NVARIANTS; i++) {
            if (granted & (1u << i)) XUngrabKey(dpy, keycode, mods | HK_VARIANTS[i], root);
        }
        XSync(dpy, False);
    }

    // Retire: clear `armed` FIRST, so a reader that gets past it cannot then
    // look at a dpy we are about to close. `prev` is deliberately left alone --
    // the next create overwrites it, and a stale non-NULL prev delegates a
    // late-arriving foreign error where NULL would drop it.
    hk_watch.armed = 0;
    hk_watch.dpy   = NULL;
    // If somebody installed over us mid-sequence, put THEIR handler back, not
    // the one we displaced on the way in: they are presumably mid-trap and will
    // restore what they saved. Reinstating our own `prev` would destroy the
    // thief's handler and make the corruption worse than the theft.
    XSetErrorHandler(stolen ? thief : hk_watch.prev);

    if (r.failed_mask != 0) {
        free(hk);
        close(stopfd[0]);
        close(stopfd[1]);
        XCloseDisplay(dpy);
        r.stage = HK_REFUSED;
        return r;
    }

    hk->dpy = dpy; hk->root = root; hk->keycode = keycode; hk->mods = mods;
    hk->granted = granted; hk->id = id;
    hk->stopfd[0] = stopfd[0]; hk->stopfd[1] = stopfd[1];
    r.hk = hk;
    r.stage = HK_OK;
    return r;
}

// jarvisHotkeyDrain dispatches whatever the create's XSync calls already pulled
// into the client-side queue.
//
// XSync(dpy, False) reads events in while waiting for its reply but dispatches
// nothing, and the run loop blocks in select() BEFORE looking at the queue -- so
// without this a key pressed during startup would sit unread until the next
// unrelated socket wakeup. (The `False` in those XSync calls is load-bearing for
// the same reason: `True` would discard the queued KeyPress events outright.)
//
// Separate from jarvisHotkeyRun so the caller can wait until it actually holds
// the stop function before any callback can fire.
static void jarvisHotkeyDrain(Hotkey* hk) {
    while (XPending(hk->dpy)) {
        XEvent ev;
        XNextEvent(hk->dpy, &ev);
        if (ev.type == KeyPress) goHotkeyFire(hk->id);
    }
}

// jarvisHotkeyRun blocks until stopped, firing the Go callback on each KeyPress.
// Returns 0 for a clean stop and the errno of a failing select() otherwise, so
// a listener that dies on its own does not die mutely.
static int jarvisHotkeyRun(Hotkey* hk) {
    int xfd = ConnectionNumber(hk->dpy);
    for (;;) {
        fd_set fds; FD_ZERO(&fds);
        FD_SET(xfd, &fds);
        FD_SET(hk->stopfd[0], &fds);
        int maxfd = xfd > hk->stopfd[0] ? xfd : hk->stopfd[0];
        if (select(maxfd + 1, &fds, NULL, NULL, NULL) < 0) {
            // EINTR is not an error, and it is not rare here. select() is not
            // restarted by SA_RESTART, and this process takes plenty of
            // signals: SIGCHLD every time a spawned shell command exits
            // (handlers.go runs them), SIGPROF under the profiler, SIGURG from
            // the runtime. Any of them delivered to this thread interrupts the
            // call. Breaking would end the listener and leave the hotkey dead
            // for the life of the process with nothing in the log -- the #574
            // symptom by another route.
            if (errno == EINTR) continue;
            return errno;
        }
        if (FD_ISSET(hk->stopfd[0], &fds)) return 0;
        while (XPending(hk->dpy)) {
            XEvent ev;
            XNextEvent(hk->dpy, &ev);
            if (ev.type == KeyPress) goHotkeyFire(hk->id);
        }
    }
}

// jarvisHotkeyStop unblocks the run loop (write to the self-pipe — thread-safe,
// no XLib). Safe to call from a different goroutine than jarvisHotkeyRun, but
// only while the Hotkey is still alive; the Go side serialises that against
// jarvisHotkeyFree.
static void jarvisHotkeyStop(Hotkey* hk) {
    if (hk) { char c = 1; ssize_t n = write(hk->stopfd[1], &c, 1); (void)n; }
}

// jarvisHotkeyFree ungrabs + closes. Must run on the same goroutine as
// jarvisHotkeyRun (after it returns), since it touches XLib.
static void jarvisHotkeyFree(Hotkey* hk) {
    if (!hk) return;
    if (hk->dpy) {
        // Ungrab exactly the variants we hold. AnyModifier would have worked
        // too -- UngrabKey only ever touches the requesting client's own grabs,
        // and each hotkey owns its connection -- but naming what we hold says
        // what it means and pairs with hk->granted.
        for (int i = 0; i < HK_NVARIANTS; i++) {
            if (hk->granted & (1u << i))
                XUngrabKey(hk->dpy, hk->keycode, hk->mods | HK_VARIANTS[i], hk->root);
        }
        XCloseDisplay(hk->dpy);
    }
    close(hk->stopfd[0]);
    close(hk->stopfd[1]);
    free(hk);
}

// ---------------------------------------------------------------------------
// Test scaffolding.
//
// jarvisHotkeyGrabOne grabs a SINGLE modifier variant on its own connection, so
// a test can manufacture the partial clash that the all-or-nothing decision
// exists for: hold one variant, then assert startHotkeyListener refuses the
// whole combination and names that variant. Nothing in the product calls it.
//
// It lives here rather than in a _test.go file because cgo is not allowed in
// test files at all, so a C helper a test needs has to be in the package
// proper. Returns NULL if the grab was refused or the display would not open.
static Display* jarvisHotkeyGrabOne(unsigned int mods, unsigned long keysym, int variant) {
    if (variant < 0 || variant >= HK_NVARIANTS) return NULL;
    Display* dpy = XOpenDisplay(NULL);
    if (!dpy) return NULL;
    int keycode = XKeysymToKeycode(dpy, (KeySym)keysym);
    if (keycode == 0) { XCloseDisplay(dpy); return NULL; }
    hk_watch.dpy = dpy; hk_watch.code = 0; hk_watch.request = 0; hk_watch.prev = NULL;
    hk_watch.armed = 1;
    XErrorHandler displaced = XSetErrorHandler(hk_grab_error);
    hk_watch.prev = (displaced == hk_grab_error) ? hk_swallow_error : displaced;
    XGrabKey(dpy, keycode, mods | HK_VARIANTS[variant], DefaultRootWindow(dpy), False,
             GrabModeAsync, GrabModeAsync);
    XSync(dpy, False);
    unsigned char code = hk_watch.code;
    hk_watch.armed = 0;
    hk_watch.dpy   = NULL;
    XSetErrorHandler(hk_watch.prev);
    if (code != 0) { XCloseDisplay(dpy); return NULL; }
    return dpy;
}

// jarvisHotkeyUngrabOne releases what jarvisHotkeyGrabOne took.
static void jarvisHotkeyUngrabOne(Display* dpy) {
    if (dpy) XCloseDisplay(dpy);
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

// The C enum and the Go constants in hotkeys_keyspec.go are two halves of one
// contract across a boundary no test can see through, so the compiler checks
// them. If a pair ever disagrees, one of the two conversions below is a
// negative constant and the build fails with "constant -N overflows uint"
// rather than silently changing which message a user is shown.
const (
	_ = uint(C.HK_OK-hkGrabOK) + uint(hkGrabOK-C.HK_OK)
	_ = uint(C.HK_NO_DISPLAY-hkGrabNoDisplay) + uint(hkGrabNoDisplay-C.HK_NO_DISPLAY)
	_ = uint(C.HK_NO_KEYCODE-hkGrabNoKeycode) + uint(hkGrabNoKeycode-C.HK_NO_KEYCODE)
	_ = uint(C.HK_REFUSED-hkGrabRefused) + uint(hkGrabRefused-C.HK_REFUSED)
	_ = uint(C.HK_NO_PIPE-hkGrabNoPipe) + uint(hkGrabNoPipe-C.HK_NO_PIPE)
	_ = uint(C.HK_NO_MEM-hkGrabNoMem) + uint(hkGrabNoMem-C.HK_NO_MEM)
	_ = uint(C.HK_NVARIANTS-hkNumVariants) + uint(hkNumVariants-C.HK_NVARIANTS)
	_ = uint(C.HK_ALL_VARIANTS-hkAllVariants) + uint(hkAllVariants-C.HK_ALL_VARIANTS)
	// The two X protocol constants linuxGrabError decides on, taken from the
	// real headers rather than trusted to a comment.
	_ = uint(C.BadAccess-hkBadAccess) + uint(hkBadAccess-C.BadAccess)
	_ = uint(C.X_GrabKey-hkOpcodeGrab) + uint(hkOpcodeGrab-C.X_GrabKey)
)

var hotkeyReg sync.Map // uint64 -> func()
var hotkeyCounter atomic.Uint64

// hotkeyCreateMu serialises jarvisHotkeyCreate.
//
// Load-bearing, not decoration. XSetErrorHandler and the hk_watch slot it fills
// are both process-global, and two of our creates racing would not merely
// misread a refusal: each saves what it displaced and restores it afterwards, so
// the second would save the FIRST one's hk_grab_error and reinstall it at the
// end, leaving our handler as the process-wide steady state with nothing
// arranged to remove it. Dropping this mutex does not cost a diagnosis, it
// breaks X error handling for the whole process.
//
// They genuinely can race: pebble_overlay_linux.go registers summon and palette
// back to back, but panels_runtime.go registers a panel's summon hotkey from
// inside the panel spawn goroutine, which is ordered against neither.
//
// It does NOT serialise us against GDK, which writes the same slot from the GTK
// main thread many times a second. See the KNOWN LIMIT note in the C preamble;
// that is a design gap this mutex cannot close.
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
// any OS. The grab path itself was exercised against a real X.Org server (X11
// over WSLg, DISPLAY=:0) with a second connection deliberately holding the
// combination first:
//
//	free combination              all four variants granted
//	squatter holds base variant   BadAccess(10) on X_GrabKey(33), failed=0x1,
//	                              granted=0xe, create refused
//	third client afterwards        CAN take the LockMask variant, so the three
//	                              granted variants really were released
//	after squatter releases       all four granted again
//	unmapped keysym               HK_NO_KEYCODE, never an AnyKey grab
//
// The first four rows are now Go tests rather than a claim: see
// TestLinuxRefusedGrabIsReported, TestLinuxPartialClashIsRefusedWholesale and
// TestLinuxGrabIsReleasedOnStop, which skip when there is no display, so a
// developer with a desktop re-runs the proof with `go test`. The fifth is not
// asserted through this function, because no keysym is reliably unmapped on
// every machine; parseLinuxKeyspec's error cases cover the reachable half.
//
// Note CI's linux job sets no DISPLAY today, so CI skips all three X tests and
// only the pure-layer table in hotkeys_keyspec_test.go actually runs there.
//
// NOT established from here, and needing a real desktop: whether a desktop
// environment's own global shortcuts (GNOME/KDE) refuse in the same way. They
// are X clients holding passive grabs like any other, so they should. Nor is
// XWayland covered, where a compositor may grant a grab that never fires --
// the #574 symptom by a third route.
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
	// started gates the queue drain: a key pressed during registration must not
	// reach the callback before the caller holds the stop function.
	started := make(chan struct{})

	// The run goroutine frees the Hotkey when it exits, which it can do on its
	// own (a non-EINTR select error), so stop() must not touch the pointer
	// afterwards -- that would read hk->stopfd out of freed memory and write a
	// byte into whatever fd number it happened to contain.
	var lifeMu sync.Mutex
	freed := false

	go func() {
		// XLib calls for one Display must stay on one thread; create + run +
		// free all happen here. Stop only writes a pipe (thread-safe) from
		// elsewhere.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		hotkeyCreateMu.Lock()
		out := C.jarvisHotkeyCreate(C.uint(mods), C.ulong(keysym), C.ulonglong(id))
		hotkeyCreateMu.Unlock()

		if out.hk == nil || out.stage != C.HK_OK {
			ch <- created{nil, linuxGrabError(
				keyspec,
				int(out.stage),
				uint8(out.error_code),
				uint8(out.request_code),
				uint(out.failed_mask),
				out.hk == nil,
			)}
			close(done)
			return
		}
		if out.slot_stolen != 0 {
			// Not a failure: the grabs may well have been fine. But a "no error
			// recorded" verdict is only trustworthy while our handler is the
			// installed one, so say so rather than quietly believing it.
			log.Printf("[hotkeys] %q: the process-wide X error handler was not ours during registration; "+
				"a refused grab could have been missed (GTK/GDK rewrites it -- see hotkeys_linux.go)", keyspec)
		}
		ch <- created{out.hk, nil}

		<-started
		C.jarvisHotkeyDrain(out.hk)
		if rc := C.jarvisHotkeyRun(out.hk); rc != 0 {
			// The listener is now deaf for the rest of the process's life.
			// Said out loud, because a silent return here is exactly the class
			// of bug #574 was.
			log.Printf("[hotkeys] %q: select() failed (errno %d); the listener has stopped and the hotkey is dead",
				keyspec, int(rc))
		}
		lifeMu.Lock()
		C.jarvisHotkeyFree(out.hk)
		freed = true
		lifeMu.Unlock()
		hotkeyReg.Delete(id)
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

	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			lifeMu.Lock()
			if !freed {
				C.jarvisHotkeyStop(hk)
			}
			lifeMu.Unlock()
			<-done
		})
	}
	close(started)
	return stop, nil
}

// hotkeyHoldOneVariant grabs a SINGLE lock-modifier variant of keyspec on its
// own X connection and returns a release function.
//
// This exists for TestLinuxPartialClashIsRefusedWholesale, which needs a
// combination that is neither free nor fully taken -- the state the
// all-or-nothing decision exists for, and the one a Go test cannot otherwise
// manufacture. It is a Go wrapper rather than a direct C call because a
// _test.go file may not use cgo at all, so both the C helper and this shim have
// to live in the package proper. Nothing in the product calls it.
//
// variant indexes HK_VARIANTS: 0 plain, 1 CapsLock, 2 NumLock, 3 both.
// ok is false when the display will not open or that variant is already held.
func hotkeyHoldOneVariant(keyspec string, variant int) (release func(), ok bool) {
	mods, keysym, err := parseLinuxKeyspec(keyspec)
	if err != nil {
		return nil, false
	}
	// Same lock as a create: this writes hk_watch and the process-global error
	// handler, so it must not run beside jarvisHotkeyCreate. Harmless today
	// (tests in a package run sequentially and none of these use t.Parallel),
	// but the invariant is the file's, not the test's.
	hotkeyCreateMu.Lock()
	dpy := C.jarvisHotkeyGrabOne(C.uint(mods), C.ulong(keysym), C.int(variant))
	hotkeyCreateMu.Unlock()
	if dpy == nil {
		return nil, false
	}
	var once sync.Once
	return func() { once.Do(func() { C.jarvisHotkeyUngrabOne(dpy) }) }, true
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
