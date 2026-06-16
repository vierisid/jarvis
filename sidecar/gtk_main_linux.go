//go:build linux

package main

/*
#cgo pkg-config: gtk+-3.0
#include <gtk/gtk.h>
*/
import "C"

import (
	"runtime"
	"sync"
)

// One process-wide GTK main loop, shared by every native overlay (pebble,
// sub-pebble, region select). GTK is not thread-safe: widgets may only be
// touched on the thread running gtk_main, so all services marshal their widget
// work onto this loop via g_idle_add. Running two gtk_main loops on two threads
// is undefined, so the loop is started exactly once here.
var gtkMainOnce sync.Once

// ensureGTKMain initialises GTK and starts the single shared main loop on its
// own goroutine, the first time it is called. Idempotent and safe to call from
// every overlay service's constructor.
func ensureGTKMain() {
	gtkMainOnce.Do(func() {
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
				return
			}
			C.gtk_main()
		}()
	})
}
