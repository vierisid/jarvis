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
    int                stopfd[2];
    unsigned long long id;
} Hotkey;

// Swallow BadAccess (another client already grabbed the combo) etc. so a
// conflicting grab doesn't crash the process.
static int hk_ignore_error(Display* d, XErrorEvent* e) { (void)d; (void)e; return 0; }

// hk_keysym resolves a key name ("space", "k", "Return") to a KeySym without
// needing an open display.
static unsigned long hk_keysym(const char* name) {
    return (unsigned long)XStringToKeysym(name);
}

static Hotkey* jarvisHotkeyCreate(unsigned int mods, unsigned long keysym, unsigned long long id) {
    Display* dpy = XOpenDisplay(NULL);
    if (!dpy) return NULL;
    Window root = DefaultRootWindow(dpy);
    int keycode = XKeysymToKeycode(dpy, (KeySym)keysym);
    if (keycode == 0) { XCloseDisplay(dpy); return NULL; }

    unsigned int variants[] = { 0, LockMask, Mod2Mask, LockMask | Mod2Mask };
    XErrorHandler old = XSetErrorHandler(hk_ignore_error);
    for (int i = 0; i < 4; i++) {
        XGrabKey(dpy, keycode, mods | variants[i], root, False, GrabModeAsync, GrabModeAsync);
    }
    XSync(dpy, False);
    XSetErrorHandler(old);

    Hotkey* hk = (Hotkey*)calloc(1, sizeof(Hotkey));
    hk->dpy = dpy; hk->root = root; hk->keycode = keycode; hk->mods = mods; hk->id = id;
    if (pipe(hk->stopfd) != 0) { hk->stopfd[0] = -1; hk->stopfd[1] = -1; }
    return hk;
}

// jarvisHotkeyRun blocks until stopped, firing the Go callback on each KeyPress.
static void jarvisHotkeyRun(Hotkey* hk) {
    int xfd = ConnectionNumber(hk->dpy);
    for (;;) {
        fd_set fds; FD_ZERO(&fds);
        FD_SET(xfd, &fds);
        if (hk->stopfd[0] >= 0) FD_SET(hk->stopfd[0], &fds);
        int maxfd = xfd;
        if (hk->stopfd[0] > maxfd) maxfd = hk->stopfd[0];
        if (select(maxfd + 1, &fds, NULL, NULL, NULL) < 0) break;
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
        XUngrabKey(hk->dpy, hk->keycode, AnyModifier, hk->root);
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
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

var hotkeyReg sync.Map // uint64 -> func()
var hotkeyCounter atomic.Uint64

// startHotkeyListener registers a single global hotkey (e.g. "ctrl+space",
// "ctrl+k") and fires onFire on each press. Returns a stop function.
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
		hk := C.jarvisHotkeyCreate(C.uint(mods), C.ulong(keysym), C.ulonglong(id))
		if hk == nil {
			ch <- created{nil, fmt.Errorf("XGrabKey failed for %q (no display or key unavailable)", keyspec)}
			close(done)
			return
		}
		ch <- created{hk, nil}
		C.jarvisHotkeyRun(hk)
		C.jarvisHotkeyFree(hk)
		close(done)
	}()

	res := <-ch
	if res.err != nil {
		hotkeyReg.Delete(id)
		return nil, res.err
	}
	hk := res.hk
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
