//go:build linux

package main

/*
#cgo pkg-config: gtk+-3.0
#include <gtk/gtk.h>
*/
import "C"

import "sync"

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
			C.gtk_init(nil, nil)
			C.gtk_main()
		}()
	})
}
