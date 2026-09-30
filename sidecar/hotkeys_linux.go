//go:build linux

package main

// Linux global hotkeys via X11 XGrabKey.
//
// Each hotkey opens its own X display connection, grabs the key on the root
// window (with the NumLock/CapsLock modifier variants so it fires regardless of
// lock state), and runs a poll() loop over the X connection fd + a self-pipe
// so it can be stopped cleanly. KeyPress fires the Go callback.
//
// The grabs themselves go out as xcb CHECKED requests on the same connection,
// which is how a refusal reaches the caller instead of the process-wide X error
// handler (#577). See "Catching a refused grab" below.
//
// Wayland note: XGrabKey only reaches X11 (or XWayland) clients. Under a native
// Wayland session global grabs need the compositor's shortcuts protocol; that
// is a separate follow-up. On X11/XWayland this works.

/*
#cgo pkg-config: x11 x11-xcb xcb

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <X11/Xlib.h>
#include <X11/Xlib-xcb.h>
#include <X11/keysym.h>
#include <X11/Xutil.h>
#include <X11/Xproto.h>
#include <xcb/xcb.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
// sys/select.h is included for FD_SETSIZE ONLY, which the high-fd test
// asserts against so the limit comes from the real header rather than a
// comment. Nothing here calls select() any more -- see jarvisHotkeyRun.
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
    HK_NO_MEM      = 5,
    HK_NO_XCB      = 6,
    HK_CONN_LOST   = 7
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
// back later as an X error event. So a plain XGrabKey cannot tell you whether
// the grab took (issue #574: before this was addressed, a refused grab was
// reported as SUCCESS and the hotkey was silently dead, with "registered" in
// the log).
//
// The grabs are therefore issued as xcb CHECKED requests. XLib and xcb share
// one connection -- XGetXCBConnection hands back the xcb_connection_t behind
// an open Display* -- so this borrows the connection for two request types and
// ports nothing else: the event queue still belongs to XLib (the default
// XSetEventQueueOwner), which is what keeps XPending/XNextEvent in the run
// loop working unchanged.
//
// A checked request's error is returned to the caller by xcb_request_check,
// keyed to that request's own cookie. It is never dispatched as an event and
// never consulted the process-wide XLib error handler. That last part is the
// whole point, and it is why #577 replaced the previous mechanism.
//
// WHAT THIS REPLACES, and why the old mechanism could not be fixed in place.
// Until #577 the refusal was caught by installing a temporary process-wide
// XErrorHandler around each grab and forcing a round trip with XSync. That
// worked, but XSetErrorHandler is a single process-global word and GDK is a
// second writer to it: disassembling the linked libgdk-3.so.0.2420.32 (GTK
// 3.24.52) shows gdk_x11_display_error_trap_push calling
// XSetErrorHandler(gdk_x_error) UNCONDITIONALLY at function entry, saving what
// it displaced, with the matching pop restoring it. There are 55 trap-push
// call sites in libgdk alone (event translation, WM protocol filters, window
// move/focus, monitor geometry), all on the GTK main thread, and the library
// even carries the string "XSetErrorHandler() called with a GDK error trap
// pushed. Don't do that."
//
// So a GDK trap straddling a grab's round trip delivered our BadAccess to
// gdk_x_error, which walked its own GdkDisplay list, did not find our private
// connection, and returned 0 -- the refusal was dropped and the grab looked
// granted. Detection was reliable, not certain. A handler installed for the
// process lifetime would not have helped either: GDK displaces even that on
// every push. The only way to stop sharing the slot is not to use it, which is
// what a checked request does.
//
// PROVEN BY EXECUTION, not by reading the xcb source. Against a real X.Org
// server (X11 over WSLg, DISPLAY=:0), with a deliberately nosy XErrorHandler
// installed for the whole run to catch the handler being consulted at all:
//
//	squatter holds the base variant   (its own connection, checked grab)
//	variant 0 (mask 0x4d)             REFUSED error_code=10 major=33 minor=0
//	variant 1 (mask 0x4f)             granted
//	variant 2 (mask 0x5d)             granted
//	variant 3 (mask 0x5f)             granted
//	failed_mask=0x1 granted_mask=0xe  BadAccess=10 X_GrabKey=33
//	xlib handler consulted            0 times
//	third client takes mask 0x4f      granted, so the release was real
//
// The same three properties are Go tests -- TestLinuxRefusedGrabIsReported,
// TestLinuxPartialClashIsRefusedWholesale and TestLinuxGrabIsReleasedOnStop --
// which CI now runs under Xvfb (#588) rather than skipping.
//
// NO ERROR HANDLER IS INSTALLED ANYWHERE IN THIS FILE, and that is a decision
// rather than an omission -- but it is a TRADE, not a strict improvement, and
// the limit is worth stating precisely because the old comment here overclaimed
// in the other direction.
//
// A handler existed only because XLib's DEFAULT handler prints the error and
// calls exit(1), and the grab path deliberately provoked errors. Every request
// this file issues on its own connection is now accounted for:
//
//	grab key (xN)                     ours, CHECKED   -> returned to us
//	ungrab key (refusal cleanup)      ours, CHECKED   -> returned, discarded
//	ungrab key (jarvisHotkeyFree)     ours, CHECKED   -> returned, discarded
//	grab key (jarvisHotkeyGrabOne)    ours, CHECKED   -> returned to the test
//	keyboard mapping + XKB setup      XLib, inside XKeysymToKeycode
//	XCloseDisplay                     XLib, flushes; dispatches on the way out
//
// WHAT IS GAINED. No error OF OURS can reach a handler any more, which is the
// point of #577, and jarvisHotkeyFree's ungrabs are no longer an exit(1) path:
// they used to be plain XUngrabKey with no handler installed anywhere near
// them.
//
// WHAT IS GIVEN UP, stated because it is real. The old handler, for the span it
// was installed, swallowed AND recorded ANY error on this display, not just a
// grab refusal -- so an unrelated error arriving mid-create was reported
// through linuxGrabError's "refused with X error %d on request %d" branch
// instead of killing the process. It is now neither swallowed nor reported: it
// sits in XLib's event queue and is dispatched later by XPending in the drain
// or the run loop, where there is no handler and _XDefaultError exits. Both of
// those windows were ALREADY unprotected before #577 (the old code installed
// nothing during jarvisHotkeyRun or jarvisHotkeyFree, and said so), so the
// exposure is unchanged in kind; what is new is that a mid-create error reaches
// it rather than being caught.
//
// Which errors can those even be? Only ones XLib issues for itself: the
// keyboard-mapping fetch and XKB setup behind XKeysymToKeycode, and
// XOpenDisplay's BIG-REQUESTS negotiation. XkbSelectEvents carries no reply, so
// its error would be asynchronous. That is a claim about libX11's internals
// rather than a property this file controls, which is exactly why it is written
// down instead of being asserted away.
//
// THE STRUCTURAL FIX, not taken here, and why. XSetEventQueueOwner(dpy,
// XCBOwnsEventQueue) makes libX11 send its OWN requests as XCB_REQUEST_CHECKED
// and set their errors aside, so an unchecked asynchronous error surfaces as an
// ignorable response_type == 0 instead of reaching _XDefaultError; XLib round
// trips and XCloseDisplay keep working. Measured to work. It costs the
// XPending/XNextEvent event path -- both jarvisHotkeyDrain and jarvisHotkeyRun
// would port to xcb_poll_for_event -- and #577 scoped itself to the grab, on
// the grounds that sharing the connection "does not mean porting the rest of
// the file". Changing how every KeyPress is delivered is a bigger decision than
// this fix should make silently, and it wants a test that a hotkey actually
// FIRES, which nothing here has yet.
//
// One more claim deliberately NOT made: that libX11's global lock fences any of
// this. It is taken only when XInitThreads has been called, and neither this
// repo nor the linked GTK3 stack calls it (checked with objdump on libgtk-3 and
// libgdk-3). What actually makes the XLib/xcb mixing safe is that all of it --
// create, drain, run, free -- happens on ONE goroutine with
// runtime.LockOSThread held, so there is never a second thread interleaving
// requests on this connection. 2000 interleaved checked-xcb and XLib round
// trips on one connection produced no xcb_io.c sequence-lost assertion.
// hotkeyCreateMu is not that argument; see its own comment for what it does do.

// hk_keysym resolves a key name ("space", "k", "Return") to a KeySym without
// needing an open display.
static unsigned long hk_keysym(const char* name) {
    return (unsigned long)XStringToKeysym(name);
}

// hk_ungrab_checked releases the variants named by `mask` with CHECKED xcb
// requests and discards whatever comes back.
//
// Checked, not because anyone reads the verdict, but because an UNCHECKED
// ungrab error would be dispatched to the process-wide XLib error handler --
// and with no handler installed (see above) that is _XDefaultError, which
// calls exit(1). This is the only reason the old code needed a handler around
// the failure path at all, and the reason jarvisHotkeyFree's ungrabs used to be
// an exit(1) risk that nothing covered.
//
// One round trip for the whole batch: the cookies are collected first and the
// first xcb_request_check reads through all of them.
static void hk_ungrab_checked(xcb_connection_t* xcb, xcb_window_t root,
                              int keycode, unsigned int mods, unsigned int mask) {
    xcb_void_cookie_t cookies[HK_NVARIANTS];
    int n = 0;
    for (int i = 0; i < HK_NVARIANTS; i++) {
        if (!(mask & (1u << i))) continue;
        cookies[n++] = xcb_ungrab_key_checked(xcb, (xcb_keycode_t)keycode, root,
                                              (uint16_t)(mods | HK_VARIANTS[i]));
    }
    for (int j = 0; j < n; j++) {
        xcb_generic_error_t* e = xcb_request_check(xcb, cookies[j]);
        if (e) free(e);
    }
}

// hk_grab_variants issues the checked grab requests and collects the verdicts.
//
// Returns HK_OK when every variant was granted, HK_REFUSED when at least one
// was turned down, or HK_CONN_LOST when the connection died under us. The
// caller owns the cleanup either way; *out_granted always says what is
// actually held, including on the failure paths, so nothing is left grabbed.
//
// Factored out of jarvisHotkeyCreate so the HK_CONN_LOST path can be tested
// against a deliberately broken connection without a test hook inside the
// create itself (see jarvisHotkeyGrabOverBrokenConnection).
//
// All HK_NVARIANTS requests are issued first, then all the cookies are checked.
//
// The XLib version could not do that: it had to XSync after every single grab,
// because a recording error handler sees only "an error happened" and
// attributing it to a variant would have meant matching request serials by
// hand. A cookie IS that attribution, so batching is exact by construction
// rather than a guess -- and it costs one round trip instead of four, since the
// first xcb_request_check sends the sync and reads through it while the
// remaining three find their verdicts already read.
//
// Checking cookies in issue order also means first-error-wins reports the
// LOWEST failing variant, matching the old loop's ordering, so the message a
// user sees is unchanged.
static int hk_grab_variants(xcb_connection_t* xcb, xcb_window_t root, int keycode,
                            unsigned int mods, unsigned int* out_granted,
                            unsigned int* out_failed, unsigned char* out_code,
                            unsigned char* out_request) {
    xcb_void_cookie_t cookies[HK_NVARIANTS];
    for (int i = 0; i < HK_NVARIANTS; i++) {
        cookies[i] = xcb_grab_key_checked(
            xcb,
            0,                                      // owner_events = False
            root,
            (uint16_t)(mods | HK_VARIANTS[i]),
            (xcb_keycode_t)keycode,
            XCB_GRAB_MODE_ASYNC,                    // pointer_mode
            XCB_GRAB_MODE_ASYNC);                   // keyboard_mode
    }

    unsigned int granted = 0, failed = 0;
    for (int i = 0; i < HK_NVARIANTS; i++) {
        xcb_generic_error_t* e = xcb_request_check(xcb, cookies[i]);
        if (e == NULL) { granted |= (1u << i); continue; }
        failed |= (1u << i);
        // First error wins: a create that trips several variants should report
        // the reason it first hit, not the last.
        //
        // major_code is the same opcode XErrorEvent.request_code carried
        // (X_GrabKey == 33) and error_code is the same code (BadAccess == 10),
        // so linuxGrabError's gating and wording are untouched. Verified
        // against a real server; see the note above.
        if (*out_code == 0) {
            *out_code    = e->error_code;
            *out_request = e->major_code;
        }
        free(e);   // xcb_request_check hands ownership of the error to us
    }
    *out_granted = granted;
    *out_failed  = failed;

    // A DEAD CONNECTION LOOKS EXACTLY LIKE EVERY GRAB BEING GRANTED, and that
    // is the one way a checked request can lie to us.
    //
    // xcb_request_check returns NULL both for "the server said yes" and for
    // "there is no server": once xcb_connection_has_error is set, every request
    // is discarded and every check returns NULL. Without this test the create
    // would come back failed_mask=0, granted=0xf, HK_OK -- a non-nil stop
    // function and a "registered" log line for a hotkey that can never fire,
    // which is #574 reached through the fix for it.
    //
    // The old XSync-based path could not produce this, because XSync on a dead
    // connection takes libX11's fatal-IO route and is at least loud. So this is
    // not defensive padding: it is a refusal path the mechanism swap would
    // otherwise have dropped.
    //
    // Narrow but reachable, and reachable exactly when it matters: the sidecar
    // re-registers hotkeys around session logout and X server restarts.
    if (xcb_connection_has_error(xcb)) return HK_CONN_LOST;
    return failed != 0 ? HK_REFUSED : HK_OK;
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

    // Borrow the xcb connection behind this Display*. Not a second
    // connection: same socket, same client, same grabs -- only the request
    // encoding differs. Event-queue ownership is left with XLib (the default),
    // so the run loop's XPending/XNextEvent are unaffected.
    xcb_connection_t* xcb = XGetXCBConnection(dpy);
    if (!xcb || xcb_connection_has_error(xcb)) {
        // No xcb behind this Display (a libX11 built without it), or the
        // connection is already broken. Either way the grab cannot be issued
        // checked, and falling back to an unchecked XGrabKey would be the
        // silent success #574 was.
        int stage = xcb ? HK_CONN_LOST : HK_NO_XCB;
        free(hk);
        close(stopfd[0]);
        close(stopfd[1]);
        XCloseDisplay(dpy);
        r.stage = stage;
        return r;
    }

    unsigned int granted = 0;
    int grab_stage = hk_grab_variants(xcb, (xcb_window_t)root, keycode, mods,
                                      &granted, &r.failed_mask,
                                      &r.error_code, &r.request_code);

    if (grab_stage == HK_CONN_LOST) {
        // NO XCloseDisplay, and NO ungrab, and both omissions are deliberate.
        //
        // XCloseDisplay flushes, and flushing a dead socket takes libX11's
        // FATAL-IO path, which prints "XIO: fatal IO error" and calls exit().
        // Measured, not feared:
        //
        //	has_error = 1
        //	calling XCloseDisplay on the broken connection...
        //	XIO:  fatal IO error 88 (Socket operation on non-socket) on X server ":0"
        //	exit status 1
        //
        // So tidying up here would kill the sidecar over the exact condition
        // this branch exists to REPORT. There is no error-handler trick worth
        // taking either: the IO handler is process-global and libX11 exits
        // anyway if it returns.
        //
        // The cost is one leaked Display (tens of KB) and its fd per
        // occurrence. That is the right trade: the connection is already gone,
        // the server has dropped every grab this client held, and a leak on a
        // path that only fires when the X session is dying beats a daemon that
        // exits when its session hiccups.
        free(hk);
        close(stopfd[0]);
        close(stopfd[1]);
        r.stage = HK_CONN_LOST;
        return r;
    }

    if (r.failed_mask != 0) {
        // Release what we were given. Checked, so an ungrab error comes back
        // here instead of reaching XLib's exit(1) default -- and is discarded,
        // because first-error-wins already holds the refusal we are about to
        // report and an ungrab failure is not the user's problem.
        //
        // Honest note on redundancy: XCloseDisplay below already releases every
        // grab held by this connection, and that was verified against a real X
        // server -- removing this loop changes nothing observable today. It
        // stays because it is nearly free, it says what it means, and it
        // becomes load-bearing the moment anyone keeps the connection open on
        // the failure path.
        hk_ungrab_checked(xcb, (xcb_window_t)root, keycode, mods, granted);

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

// jarvisHotkeyDrain dispatches whatever the create's round trip already pulled
// into the client-side queue.
//
// Still needed after the move to xcb, for the same reason and by the same
// mechanism: xcb_request_check reads from the socket while waiting for the
// grabs' verdicts, and any KeyPress that arrives in that window is queued (in
// xcb's event queue, which XPending drains through -- the event queue still
// belongs to XLib, so nothing is stranded) rather than dispatched. The run loop
// blocks in poll() BEFORE looking at the queue, so without this a key pressed
// during startup would sit unread until the next unrelated socket wakeup.
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
// Returns 0 for a clean stop and the errno of a failing poll() otherwise, so
// a listener that dies on its own does not die mutely.
//
// poll(), not select(), since #587. select() has a hard ceiling: an fd at or
// above FD_SETSIZE (1024) is undefined behaviour. FD_SET then writes past the
// end of the fd_set -- a silent out-of-bounds write on an unfortified build,
// and on a fortified one an abort:
//
//	X connection fd = 1067  (FD_SETSIZE = 1024)
//	poll() on fd 1067 returned 0 (revents=0x0)
//	FD_SET(1067) -> *** bit out of range 0 - FD_SETSIZE on fd_set ***: terminated
//
// Nothing here chose that fd number: the kernel hands out the lowest free one,
// and this sidecar holds browser pipes, a panel webview per panel, audio streams
// and its own socket, so a long-lived instance with many panels genuinely
// reaches four figures. It is not a theoretical limit, it is a hotkey that
// corrupts the stack instead of registering.
//
// The cheap alternative -- refuse to install the listener when the fd is too
// high -- was rejected: it converts "many panels open" into "your hotkey
// silently does not exist", which is the #574 failure class one layer up.
// poll() has no ceiling, needs no maxfd arithmetic, and is POSIX.
//
// Semantics are held identical to the select() version it replaces, including
// the two conditions select() folded into "readable".
static int jarvisHotkeyRun(Hotkey* hk) {
    struct pollfd fds[2];
    fds[0].fd = ConnectionNumber(hk->dpy);
    fds[1].fd = hk->stopfd[0];
    fds[0].events = POLLIN;
    fds[1].events = POLLIN;
    for (;;) {
        fds[0].revents = 0;
        fds[1].revents = 0;
        if (poll(fds, 2, -1) < 0) {
            // EINTR is not an error, and it is not rare here. poll() is not
            // restarted by SA_RESTART either, and this process takes plenty of
            // signals: SIGCHLD every time a spawned shell command exits
            // (handlers.go runs them), SIGPROF under the profiler, SIGURG from
            // the runtime. Any of them delivered to this thread interrupts the
            // call. Breaking would end the listener and leave the hotkey dead
            // for the life of the process with nothing in the log -- the #574
            // symptom by another route.
            if (errno == EINTR) continue;
            return errno;
        }
        // POLLNVAL means the fd is closed. select() reported that by failing
        // with EBADF and this loop returned it; poll() reports it per-fd and
        // returns > 0, so without this branch the loop would spin at 100% CPU
        // forever on a condition that cannot clear.
        if ((fds[0].revents | fds[1].revents) & POLLNVAL) return EBADF;
        // Stop pipe first, and on ANY event rather than POLLIN alone. This is
        // the one place poll() and select() genuinely differ: select() reported
        // a hung-up read end as READABLE, so a vanished write end ended the
        // loop. Testing POLLIN only would leave POLLHUP set on every iteration
        // and spin, and no stop byte could ever arrive to break out -- stop()
        // would block forever on its done channel.
        if (fds[1].revents != 0) return 0;
        // Anything on the X fd goes to the queue drain, which is exactly what
        // select() did: it reported a hung-up socket as readable, XPending then
        // hit EOF and took XLib's fatal-IO path. Left unchanged on purpose;
        // giving that its own return value is a separate decision from this
        // one.
        if (fds[0].revents != 0) {
            while (XPending(hk->dpy)) {
                XEvent ev;
                XNextEvent(hk->dpy, &ev);
                if (ev.type == KeyPress) goHotkeyFire(hk->id);
            }
        }
    }
}

// jarvisHotkeyProbeConnectionFd opens a connection the way a create does,
// reports the fd the kernel handed it, and closes it again. HK_FD_SETSIZE is
// the select() ceiling that fd used to have to stay under.
//
// Both exist for TestLinuxListenerSurvivesAnFdAboveFdSetsize, which is only
// meaningful if the fd really did land above the limit. Asserting that from Go
// turns "the precondition was not met" into a visible failure instead of a test
// that passes while proving nothing -- and that matters more than it sounds,
// because FD_SET on an out-of-range fd only ABORTS on a fortified build. On an
// unfortified one it writes out of bounds silently, so without this assertion a
// developer on such a toolchain would watch the test pass against the BROKEN
// select() code and conclude it was covered.
static int jarvisHotkeyProbeConnectionFd(void) {
    Display* dpy = XOpenDisplay(NULL);
    if (!dpy) return -1;
    int fd = ConnectionNumber(dpy);
    XCloseDisplay(dpy);
    return fd;
}

#define HK_FD_SETSIZE FD_SETSIZE

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
        //
        // CHECKED since #577, which is a real fix and not tidiness: these used
        // to be plain XUngrabKey with no error handler installed anywhere near
        // them, so an error here went to _XDefaultError and took the whole
        // sidecar down with exit(1) during teardown. Checked, it comes back to
        // us and is dropped.
        xcb_connection_t* xcb = XGetXCBConnection(hk->dpy);
        if (xcb && !xcb_connection_has_error(xcb)) {
            hk_ungrab_checked(xcb, (xcb_window_t)hk->root, hk->keycode, hk->mods, hk->granted);
            XCloseDisplay(hk->dpy);
        }
        // A connection that has already failed is deliberately NOT closed:
        // XCloseDisplay flushes, and flushing a dead socket takes libX11's
        // fatal-IO path and exit()s the sidecar during its own teardown. The
        // server has dropped this client's grabs already, so there is nothing
        // to release; one leaked Display beats exiting. Base-commit behaviour
        // here was to close unconditionally, so this is a crash removed rather
        // than a leak introduced.
        //
        // Not the common path: if the connection dies while the listener is
        // running, XPending hits EOF in the run loop and takes the same fatal
        // route before ever reaching here. This covers the case where it broke
        // without the loop noticing.
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
    xcb_connection_t* xcb = XGetXCBConnection(dpy);
    if (!xcb) { XCloseDisplay(dpy); return NULL; }
    xcb_generic_error_t* e = xcb_request_check(xcb,
        xcb_grab_key_checked(xcb, 0, (xcb_window_t)DefaultRootWindow(dpy),
                             (uint16_t)(mods | HK_VARIANTS[variant]),
                             (xcb_keycode_t)keycode,
                             XCB_GRAB_MODE_ASYNC, XCB_GRAB_MODE_ASYNC));
    if (e) { free(e); XCloseDisplay(dpy); return NULL; }
    return dpy;
}

// jarvisHotkeyUngrabOne releases what jarvisHotkeyGrabOne took.
static void jarvisHotkeyUngrabOne(Display* dpy) {
    if (dpy) XCloseDisplay(dpy);
}

// jarvisHotkeyGrabOverBrokenConnection runs the REAL grab sequence
// (hk_grab_variants, the same function jarvisHotkeyCreate calls) over a
// connection whose socket has been replaced by /dev/null, and returns the stage
// it produced.
//
// This is the regression guard for the one lie a checked request can tell:
// xcb_request_check returns NULL for "granted" and for "there is no server"
// alike, so without the xcb_connection_has_error test inside hk_grab_variants
// this returns HK_OK with every variant "granted" -- a hotkey reported as
// registered that can never fire. Must return HK_CONN_LOST.
//
// The break is done by dup2'ing /dev/null over the connection's fd: writes
// then succeed and go nowhere, and the first read gets EOF, which is what sets
// xcb's error flag. That is the same shape as the server going away mid-session,
// which is when the sidecar re-registers hotkeys.
//
// Nothing in the product calls it. Returns -1 if the display would not open.
static int jarvisHotkeyGrabOverBrokenConnection(unsigned int mods, unsigned long keysym) {
    Display* dpy = XOpenDisplay(NULL);
    if (!dpy) return -1;
    int keycode = XKeysymToKeycode(dpy, (KeySym)keysym);
    if (keycode == 0) { XCloseDisplay(dpy); return -1; }
    xcb_connection_t* xcb = XGetXCBConnection(dpy);
    if (!xcb) { XCloseDisplay(dpy); return -1; }

    int nullfd = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (nullfd < 0) { XCloseDisplay(dpy); return -1; }
    if (dup2(nullfd, ConnectionNumber(dpy)) < 0) { close(nullfd); XCloseDisplay(dpy); return -1; }
    close(nullfd);

    unsigned int  granted = 0, failed = 0;
    unsigned char code = 0, request = 0;
    int stage = hk_grab_variants(xcb, (xcb_window_t)DefaultRootWindow(dpy), keycode,
                                 mods, &granted, &failed, &code, &request);

    // Deliberately NOT XCloseDisplay: the connection is broken, and closing it
    // would take libX11's fatal-IO path and kill the test binary. Leaking one
    // Display and one fd in a test that has already proven its point is the
    // better trade, and it is the same reason the create returns early here
    // rather than trying to tidy up over a dead socket.
    return stage;
}

// ---------------------------------------------------------------------------
// Test scaffolding: standing in for GDK.
//
// #577 is about a refusal being stolen from us by whoever else owns the
// process-wide error handler. The GDK race is probabilistic and needs a live
// GTK loop under load, which no Go test can arrange -- but the CONSEQUENCE is
// perfectly reproducible, because gdk_x_error's behaviour towards our errors
// is simply "swallow it and return 0". So a test installs a handler that does
// exactly that, for the whole grab, and asserts the refusal still reaches the
// caller.
//
// That makes the race deterministic in the only direction that matters: on the
// mechanism #577 replaced, this handler displaces ours and the BadAccess is
// dropped, so the create reports SUCCESS and the test fails. On checked
// requests it is never consulted, which the counter asserts directly.
//
// Nothing in the product calls these.
static volatile int hk_test_swallowed = 0;

static int hk_test_swallow_all(Display* d, XErrorEvent* e) {
    (void)d; (void)e;
    hk_test_swallowed++;
    return 0;
}

static XErrorHandler hk_test_displaced     = NULL;
static int           hk_test_displaced_set = 0;

static void jarvisHotkeyStealErrorHandler(void) {
    hk_test_swallowed = 0;
    hk_test_displaced = XSetErrorHandler(hk_test_swallow_all);
    hk_test_displaced_set = 1;
}

// Outcome of jarvisHotkeyGrabUnderHijackedHandler.
typedef struct {
    int           usable;        // 0 = no display / no keycode / no xcb, test should skip
    int           refused;       // 1 = the checked request handed us an error
    unsigned char error_code;
    unsigned char request_code;
    int           handler_calls; // what the impostor handler managed to swallow
} HkHijackResult;

// jarvisHotkeyGrabUnderHijackedHandler reproduces the GDK race DETERMINISTICALLY
// instead of waiting for it.
//
// The race is not "a foreign handler is installed" -- the old mechanism
// displaced any such handler at create entry, so merely installing one before
// the create proves nothing. The race is a foreign handler installed INSIDE the
// window between our request going on the wire and the reply being read, which
// is exactly the span an error trap push/pop occupies. So that is what this
// manufactures:
//
//	xcb_grab_key_checked(...)    request encoded
//	xcb_flush(...)               on the wire; the server's error is now in flight
//	XSetErrorHandler(impostor)   <-- gdk_x11_display_error_trap_push lands here
//	xcb_request_check(...)       the error is READ here, and goes to the cookie
//	XSetErrorHandler(restore)    <-- the matching trap pop
//
// Run side by side against the mechanism this replaced (XGrabKey + XFlush +
// impostor + XSync), on a real X.Org server, same contended grab:
//
//	A  XGrabKey + handler + XSync
//	A    refusal seen by our mechanism : NO -- LOST (recorded code=0)
//	A    swallowed by the foreign handler: 1
//	A    verdict: the create would report SUCCESS -- a dead hotkey logged as registered (#574)
//	B  xcb_grab_key_checked + xcb_request_check
//	B    refusal seen by our mechanism : YES (code=10 major=33)
//	B    swallowed by the foreign handler: 0
//	B    verdict: the create would report REFUSED (correct)
//
// The caller must already hold the base variant of `mods` on another
// connection, or there is no refusal to lose.
static HkHijackResult jarvisHotkeyGrabUnderHijackedHandler(unsigned int mods, unsigned long keysym) {
    HkHijackResult r;
    memset(&r, 0, sizeof(r));

    Display* dpy = XOpenDisplay(NULL);
    if (!dpy) return r;
    int keycode = XKeysymToKeycode(dpy, (KeySym)keysym);
    if (keycode == 0) { XCloseDisplay(dpy); return r; }
    xcb_connection_t* xcb = XGetXCBConnection(dpy);
    if (!xcb) { XCloseDisplay(dpy); return r; }
    r.usable = 1;

    Window root = DefaultRootWindow(dpy);
    xcb_void_cookie_t ck = xcb_grab_key_checked(xcb, 0, (xcb_window_t)root,
                                                (uint16_t)mods, (xcb_keycode_t)keycode,
                                                XCB_GRAB_MODE_ASYNC, XCB_GRAB_MODE_ASYNC);
    xcb_flush(xcb);

    hk_test_swallowed = 0;
    XErrorHandler saved = XSetErrorHandler(hk_test_swallow_all);

    xcb_generic_error_t* e = xcb_request_check(xcb, ck);

    r.handler_calls = hk_test_swallowed;
    XSetErrorHandler(saved);

    if (e) {
        r.refused      = 1;
        r.error_code   = e->error_code;
        r.request_code = e->major_code;
        free(e);
    } else {
        // We really did get the grab; release it so the test leaves the
        // combination free for whatever runs next.
        hk_ungrab_checked(xcb, (xcb_window_t)root, keycode, mods, 1u);
    }
    XCloseDisplay(dpy);
    return r;
}

// Returns how many X errors the impostor handler caught -- which for a checked
// grab must be zero. Restoring a NULL displaced value reinstates XLib's
// default, which is genuinely the state that was in effect beforehand now that
// this file installs no handler of its own.
static int jarvisHotkeyRestoreErrorHandler(void) {
    if (hk_test_displaced_set) {
        XSetErrorHandler(hk_test_displaced);
        hk_test_displaced_set = 0;
    }
    return hk_test_swallowed;
}
*/
import "C"

import (
	"fmt"
	"log"
	"runtime"
	"sync"
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
	_ = uint(C.HK_NO_XCB-hkGrabNoXcb) + uint(hkGrabNoXcb-C.HK_NO_XCB)
	_ = uint(C.HK_CONN_LOST-hkGrabConnLost) + uint(hkGrabConnLost-C.HK_CONN_LOST)
	_ = uint(C.HK_NVARIANTS-hkNumVariants) + uint(hkNumVariants-C.HK_NVARIANTS)
	_ = uint(C.HK_ALL_VARIANTS-hkAllVariants) + uint(hkAllVariants-C.HK_ALL_VARIANTS)
	// The two X protocol constants linuxGrabError decides on, taken from the
	// real headers rather than trusted to a comment.
	_ = uint(C.BadAccess-hkBadAccess) + uint(hkBadAccess-C.BadAccess)
	_ = uint(C.X_GrabKey-hkOpcodeGrab) + uint(hkOpcodeGrab-C.X_GrabKey)
)

// hotkeyCreateMu serialises jarvisHotkeyCreate.
//
// It used to be here for the process-global XSetErrorHandler slot. #577 removed
// that slot from the picture entirely -- the grabs are checked xcb requests
// now, and no handler is installed -- so the reason has changed, but the mutex
// has NOT become decoration.
//
// What it still guards is the process-global display list. XOpenDisplay threads
// a new Display onto _XHeadOfDisplayList and XCloseDisplay unlinks it, both
// under a lock libX11 only creates when XInitThreads has been called. Nothing
// in this repo calls it and neither does the linked GTK3 stack, so that lock is
// a no-op and concurrent opens or closes race an unsynchronised linked-list
// edit.
//
// They genuinely can race: pebble_overlay_linux.go registers summon and palette
// back to back, but panels_runtime.go registers a panel's summon hotkey from
// inside the panel spawn goroutine, which is ordered against neither.
//
// It covers the CLOSES as well as the opens, which it did not before #577 --
// a create racing a free corrupts that list exactly as two creates would, so
// guarding only one side named a property the mutex was not delivering. No
// deadlock is introduced: a create never waits on a free, so the only new wait
// is a teardown pausing for the couple of round trips a create takes.
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
// combination first -- re-run after #577 swapped the detection mechanism for
// xcb checked requests, so these rows describe the xcb path and not its
// predecessor:
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
// TestLinuxGrabIsReleasedOnStop. The fifth is not asserted through this
// function, because no keysym is reliably unmapped on every machine;
// parseLinuxKeyspec's error cases cover the reachable half.
//
// Those three used to skip in CI for want of a DISPLAY, which meant a
// regression in this path landed green. Since #588 the linux sidecar job runs
// them under Xvfb and FAILS if they report as skipped -- see requireX in
// hotkeys_linux_test.go.
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
	id := hotkeyDispatcher.register(onFire)

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
		// No "the error handler was not ours" warning any more, and nothing
		// replaces it: #577 removed the shared slot from the path, so a "no
		// error recorded" verdict is now unconditional rather than conditional
		// on who owns a global word. That warning existed to admit the doubt;
		// there is no doubt left to admit.
		ch <- created{out.hk, nil}

		<-started
		C.jarvisHotkeyDrain(out.hk)
		if rc := C.jarvisHotkeyRun(out.hk); rc != 0 {
			// The listener is now deaf for the rest of the process's life.
			// Said out loud, because a silent return here is exactly the class
			// of bug #574 was.
			log.Printf("[hotkeys] %q: poll() failed (errno %d); the listener has stopped and the hotkey is dead",
				keyspec, int(rc))
		}
		lifeMu.Lock()
		// hotkeyCreateMu as well as lifeMu: Free's XCloseDisplay unlinks from
		// the same process-global display list a concurrent create is linking
		// into, and libX11 does not fence that without XInitThreads. Taking it
		// here cannot deadlock -- a create never waits on a free.
		hotkeyCreateMu.Lock()
		C.jarvisHotkeyFree(out.hk)
		hotkeyCreateMu.Unlock()
		freed = true
		lifeMu.Unlock()
		// invalidate here too, not just in stop(): this goroutine can exit on
		// its own (a non-EINTR poll error), and without this the registration
		// would outlive the listener and a late dispatch would still run the
		// callback against whatever the caller has since torn down.
		hotkeyDispatcher.invalidate(id)
		close(done)
	}()

	res := <-ch
	if res.err != nil {
		hotkeyDispatcher.invalidate(id)
		return nil, res.err
	}
	hk := res.hk
	// Said here as well as by the caller, to match the Windows backend, which
	// logs the same line from inside its listener.
	log.Printf("[hotkeys] registered %q (mods=0x%x, keysym=0x%x)", keyspec, mods, keysym)

	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			// Invalidate BEFORE asking the listener to stop, and before waiting
			// on it (#587). The order is load-bearing: reversed, the run loop
			// can drain a KeyPress that arrived just before the stop byte and
			// dispatch it after stop() has returned. Done first, that dispatch
			// finds the registration gone and never calls the callback.
			//
			// This does NOT wait for a callback already inside fn() -- see the
			// header of hotkeys_dispatch.go for why waiting is the wrong
			// trade here. It is reported instead of implied.
			if inFlight := hotkeyDispatcher.invalidate(id); inFlight > 0 {
				log.Printf("[hotkeys] %q: stopped while %d callback(s) were still running; they will finish, so anything this hotkey drives must tolerate that",
					keyspec, inFlight)
			}
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
	// Same lock as a create, for the same reason it still exists: this calls
	// XOpenDisplay, whose global display-list insert libX11 does not fence
	// without XInitThreads. Harmless today (tests in a package run
	// sequentially and none of these use t.Parallel), but the invariant is the
	// file's, not the test's.
	hotkeyCreateMu.Lock()
	dpy := C.jarvisHotkeyGrabOne(C.uint(mods), C.ulong(keysym), C.int(variant))
	hotkeyCreateMu.Unlock()
	if dpy == nil {
		return nil, false
	}
	var once sync.Once
	// Same lock on the way out: this is an XCloseDisplay, which unlinks from
	// the display list a concurrent create is linking into.
	return func() {
		once.Do(func() {
			hotkeyCreateMu.Lock()
			C.jarvisHotkeyUngrabOne(dpy)
			hotkeyCreateMu.Unlock()
		})
	}, true
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

// stealHotkeyErrorHandler installs a process-wide X error handler that swallows
// everything, standing in for GDK, and returns a function that restores what
// was there and reports how many errors the impostor caught.
//
// For TestLinuxRefusalSurvivesAStolenErrorHandler. A Go wrapper rather than a
// direct C call because a _test.go file may not use cgo at all. Nothing in the
// product calls it.
func stealHotkeyErrorHandler() (restore func() int) {
	C.jarvisHotkeyStealErrorHandler()
	var once sync.Once
	var caught int
	return func() int {
		once.Do(func() { caught = int(C.jarvisHotkeyRestoreErrorHandler()) })
		return caught
	}
}

// hotkeyFdSetSize is FD_SETSIZE from the real header: the fd number at and
// above which select() was undefined behaviour, which is what #587 replaced
// select() to escape.
const hotkeyFdSetSize = int(C.HK_FD_SETSIZE)

// hotkeyProbeConnectionFd opens an X connection exactly as a create does,
// reports the fd number the kernel gave it, and closes it again.
//
// For TestLinuxListenerSurvivesAnFdAboveFdSetsize, which has to establish that
// its precondition actually held: under fd pressure the listener's own
// connection gets a number in the same range, so if this comes back below
// FD_SETSIZE the test is proving nothing and says so instead of passing.
// Nothing in the product calls it. Returns -1 if the display will not open.
func hotkeyProbeConnectionFd() int {
	hotkeyCreateMu.Lock()
	defer hotkeyCreateMu.Unlock()
	return int(C.jarvisHotkeyProbeConnectionFd())
}

// hotkeyGrabOverBrokenConnection runs the real grab sequence over a connection
// whose socket has been replaced by /dev/null and returns the stage it
// produced, which must be hkGrabConnLost.
//
// For TestLinuxADeadConnectionIsNotReportedAsAGrantedGrab. See the C comment on
// jarvisHotkeyGrabOverBrokenConnection. Nothing in the product calls it.
// ok is false when there is no display or the layout has no such key.
func hotkeyGrabOverBrokenConnection(keyspec string) (stage int, ok bool) {
	mods, keysym, err := parseLinuxKeyspec(keyspec)
	if err != nil {
		return 0, false
	}
	hotkeyCreateMu.Lock()
	out := int(C.jarvisHotkeyGrabOverBrokenConnection(C.uint(mods), C.ulong(keysym)))
	hotkeyCreateMu.Unlock()
	if out < 0 {
		return 0, false
	}
	return out, true
}

// hotkeyGrabUnderHijackedHandler asks for keyspec's base variant with a checked
// request while a foreign X error handler is installed across the round trip --
// the GDK error-trap window, manufactured rather than waited for.
//
// For TestLinuxCheckedGrabKeepsItsRefusalFromTheGlobalHandler. See the C
// comment on jarvisHotkeyGrabUnderHijackedHandler for why the window has to be
// opened at that exact point to mean anything. Nothing in the product calls it.
//
// usable is false when there is no display or the layout has no such key.
func hotkeyGrabUnderHijackedHandler(keyspec string) (refused bool, errorCode, requestCode uint8, handlerCalls int, usable bool) {
	mods, keysym, err := parseLinuxKeyspec(keyspec)
	if err != nil {
		return false, 0, 0, 0, false
	}
	hotkeyCreateMu.Lock()
	out := C.jarvisHotkeyGrabUnderHijackedHandler(C.uint(mods), C.ulong(keysym))
	hotkeyCreateMu.Unlock()
	return out.refused != 0, uint8(out.error_code), uint8(out.request_code), int(out.handler_calls), out.usable != 0
}
