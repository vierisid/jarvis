//go:build linux

package main

/*
#cgo pkg-config: gtk+-3.0
#include <gtk/gtk.h>

extern void goGTKInvoke(unsigned long long token);
extern void goGTKWindowDestroyed(void* window);

static gboolean jarvis_gtk_invoke_idle(gpointer data) {
    goGTKInvoke((unsigned long long)(gsize)data);
    return G_SOURCE_REMOVE;
}

// jarvis_gtk_invoke queues goGTKInvoke(token) onto the shared main loop.
// Adding an idle source is safe from any thread.
static void jarvis_gtk_invoke(unsigned long long token) {
    g_idle_add_full(G_PRIORITY_HIGH_IDLE, jarvis_gtk_invoke_idle,
                    (gpointer)(gsize)token, NULL);
}

// The thread running gtk_main owns the default main context for as long as the
// loop runs, so ownership identifies the loop's thread.
static int jarvis_gtk_on_loop_thread(void) {
    return g_main_context_is_owner(g_main_context_default()) ? 1 : 0;
}

static void jarvis_gtk_window_destroyed(GtkWidget* w, gpointer data) {
    (void)data;
    goGTKWindowDestroyed((void*)w);
}

static void jarvis_gtk_watch_window(void* window) {
    g_signal_connect(G_OBJECT(window), "destroy",
                     G_CALLBACK(jarvis_gtk_window_destroyed), NULL);
}
*/
import "C"

import (
	"errors"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	webview "github.com/webview/webview_go"
)

// One process-wide GTK main loop, shared by every native overlay (pebble,
// sub-pebble, region select) and every panel webview window. GTK is not
// thread-safe: widgets may only be touched on the thread running gtk_main, so
// all of that work is marshalled onto this loop (g_idle_add, gtkInvokeSync).
// Running two gtk_main loops on two threads is undefined (in practice a
// SIGSEGV inside GTK), so the loop is started exactly once here.
var (
	gtkMainOnce sync.Once
	// sharedGTKLoopAllowed gates starting the loop at all; see
	// allowSharedUILoop. gtkLoopStarted records that it was started.
	sharedGTKLoopAllowed atomic.Bool
	gtkLoopStarted       atomic.Bool
	gtkRefusedLogOnce    sync.Once
	// gtkStarted is closed once gtk_init_check has returned, either way;
	// gtkUsable says which.
	gtkStarted = make(chan struct{})
	gtkUsable  atomic.Bool
	// gtkStopped is closed if gtk_main ever returns, so nothing waiting on the
	// loop can hang on one that is gone.
	gtkStopped = make(chan struct{})

	gtkInvokeSeq   atomic.Uint64
	gtkInvokeFuncs sync.Map // uint64 token -> func()

	// gtkWatchWindow connects the destroy signal; a variable so tests can
	// exercise the tracking map without a display.
	gtkWatchWindow = func(window unsafe.Pointer) { C.jarvis_gtk_watch_window(window) }
)

var errGTKUnavailable = errors.New("no GTK main loop (no display?)")

// allowSharedUILoop permits the shared GTK loop to start. NewSidecarClient calls
// it before building any service that can start the loop. Starting the loop
// claims the run loop for good (SetHostOwnsRunLoop), after which a webview
// window's Terminate no longer quits a loop. The windows before the client, the
// connect window and the onboarding wizard, run their own loop and end with
// Terminate, so a call that started the shared loop before them would leave
// them stuck in Run(). Refusing here turns that into a logged failure instead.
func allowSharedUILoop() { sharedGTKLoopAllowed.Store(true) }

// sharedUILoopRunning reports whether the shared GTK loop is up, so a window
// that would run a loop of its own can refuse instead of crashing.
func sharedUILoopRunning() bool { return gtkUsable.Load() }

// ensureGTKMain initialises GTK and starts the single shared main loop on its
// own goroutine, the first time it is called after allowSharedUILoop. Idempotent
// and safe to call from every overlay service's constructor and from the panel
// service. Returns false, starting nothing, before the client allows it.
func ensureGTKMain() bool {
	if !sharedGTKLoopAllowed.Load() {
		gtkRefusedLogOnce.Do(func() {
			log.Printf("[gtk] refusing to start the shared GTK loop before the client exists; the first-run windows own GTK until then")
		})
		return false
	}
	gtkMainOnce.Do(func() {
		gtkLoopStarted.Store(true)
		go func() {
			// Pin to one OS thread: GTK requires gtk_init and gtk_main (and all
			// later widget work marshalled here) to run on the same thread. The
			// pure-Go check between the two cgo calls below is otherwise a legal
			// goroutine-migration point.
			runtime.LockOSThread()
			// gtk_init_check returns FALSE on a headless box instead of aborting
			// the whole process the way gtk_init does. With no display (CI, a
			// headless server, a sidecar built with overlay capabilities but run
			// without X), skip the loop — the overlays simply won't appear.
			if C.gtk_init_check(nil, nil) == 0 {
				close(gtkStarted)
				return
			}
			gtkUsable.Store(true)
			close(gtkStarted)
			// Every webview window from here on lives under this loop, so a
			// window closing must not quit it (webview.h terminate_impl). The
			// windows that run a loop of their own, the connect and onboarding
			// windows, are finished before the client allows this loop.
			// Claimed as the last thing before entering the loop, like the macOS
			// tray; anything gtkInvokeSync queued only runs inside gtk_main.
			webview.SetHostOwnsRunLoop(true)
			C.gtk_main()
			gtkUsable.Store(false)
			close(gtkStopped)
		}()
	})
	return true
}

// gtkOnLoopThread reports whether the caller is on the shared loop's thread.
func gtkOnLoopThread() bool {
	return C.jarvis_gtk_on_loop_thread() != 0
}

// gtkInvokeSync runs fn on the shared loop's thread and waits for it to finish.
// It runs fn inline when the caller is already there (a webview binding, a
// Dispatch closure), which is what keeps a loop-thread caller from waiting on
// itself. Returns false, without running fn, when there is no loop to run it
// on: not allowed yet, no display, or the loop has stopped.
func gtkInvokeSync(fn func()) bool {
	if !ensureGTKMain() {
		return false
	}
	<-gtkStarted
	if !gtkUsable.Load() {
		return false
	}
	if gtkOnLoopThread() {
		fn()
		return true
	}
	done := make(chan struct{})
	token := gtkInvokeSeq.Add(1)
	gtkInvokeFuncs.Store(token, func() {
		defer close(done)
		fn()
	})
	C.jarvis_gtk_invoke(C.ulonglong(token))
	select {
	case <-done:
		return true
	case <-gtkStopped:
		gtkInvokeFuncs.Delete(token)
		select {
		case <-done:
			return true
		default:
			return false
		}
	}
}

// Windows the host created on the shared loop, keyed by their GtkWindow*, each
// with the callbacks to run when GTK destroys it. Entries are added and removed
// only on the loop's thread (gtkTrackWindow, the destroy signal), so a check
// made on that thread cannot race the window's destruction. The mutex is for
// the rare off-thread reader.
var (
	gtkWindowsMu sync.Mutex
	gtkWindows   = map[unsafe.Pointer][]func(){}
)

// gtkTrackWindow starts tracking a window the host just created. Must run on the
// loop's thread, in the same callback that created the window.
func gtkTrackWindow(window unsafe.Pointer) {
	if window == nil {
		return
	}
	gtkWindowsMu.Lock()
	_, tracked := gtkWindows[window]
	if !tracked {
		gtkWindows[window] = nil
	}
	gtkWindowsMu.Unlock()
	if !tracked {
		gtkWatchWindow(window)
	}
}

// gtkWindowAlive reports whether a tracked window has not been destroyed yet.
// Only meaningful on the loop's thread.
func gtkWindowAlive(window unsafe.Pointer) bool {
	gtkWindowsMu.Lock()
	defer gtkWindowsMu.Unlock()
	_, ok := gtkWindows[window]
	return ok
}

// gtkOnWindowDestroyed runs fn when the window is destroyed, or right away if it
// already has been. Must run on the loop's thread.
func gtkOnWindowDestroyed(window unsafe.Pointer, fn func()) {
	gtkWindowsMu.Lock()
	fns, alive := gtkWindows[window]
	if alive {
		gtkWindows[window] = append(fns, fn)
	}
	gtkWindowsMu.Unlock()
	if !alive {
		fn()
	}
}
