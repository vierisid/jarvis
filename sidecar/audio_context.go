package main

import (
	"runtime"
	"sync"

	"github.com/gen2brain/malgo"
)

// On Windows, miniaudio initialises COM in the multithreaded apartment on the
// thread that creates a context, and leaves it there for the context's life
// (ma_context_init_backend_apis__win32). Called from an ordinary goroutine, that
// thread goes back to the Go scheduler still in the MTA, and the next goroutine
// to lock it can be a panel: WebView2 needs a single-threaded apartment there,
// CoInitializeEx refuses with RPC_E_CHANGED_MODE, and the panel window is never
// created (the dashboard just does not open). So every context is created on one
// OS thread that belongs to audio for the life of the process and never runs
// anything else. Harmless on macOS and Linux, which have no COM.
var (
	audioThreadOnce sync.Once
	audioThreadWork chan func()
)

// onAudioContextThread runs fn on the dedicated audio-context thread and waits
// for it to return.
func onAudioContextThread(fn func()) {
	audioThreadOnce.Do(func() {
		audioThreadWork = make(chan func())
		go func() {
			// Never unlocked: the thread must not return to the scheduler while
			// a context created on it is alive, and contexts live as long as the
			// process.
			runtime.LockOSThread()
			for work := range audioThreadWork {
				work()
			}
		}()
	})
	done := make(chan struct{})
	audioThreadWork <- func() {
		defer close(done)
		fn()
	}
	<-done
}

// newAudioContext is malgo.InitContext with the default config, created on the
// dedicated audio-context thread.
func newAudioContext(onLog func(message string)) (*malgo.AllocatedContext, error) {
	var ctx *malgo.AllocatedContext
	var err error
	onAudioContextThread(func() {
		ctx, err = malgo.InitContext(nil, malgo.ContextConfig{}, onLog)
	})
	return ctx, err
}
