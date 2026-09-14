package main

import (
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// Audio contexts must be created on one OS thread that runs nothing else, so
// the COM apartment miniaudio leaves on it (Windows) can never be inherited by
// a panel goroutine. Thread ids are only portable enough to check here; the
// mechanism is the same on every platform.
//
// "Every call landed on the same thread" alone proves little: an unlocked
// worker often resumes on the same thread by chance. What locking guarantees,
// and what is checked, is that the thread never runs any other goroutine, even
// while the worker is parked between calls with many goroutines waiting to run.
func TestAudioContextThreadRunsNothingElse(t *testing.T) {
	var audioTID atomic.Int64
	onAudioContextThread(func() { audioTID.Store(int64(syscall.Gettid())) })

	var sawAudioThread atomic.Bool
	var otherThread atomic.Int64
	deadline := time.Now().Add(400 * time.Millisecond)
	var wg sync.WaitGroup
	for i := 0; i < 4*runtime.GOMAXPROCS(0); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for time.Now().Before(deadline) {
				if int64(syscall.Gettid()) == audioTID.Load() {
					sawAudioThread.Store(true)
				}
				runtime.Gosched()
			}
		}()
	}
	// Keep calling in while they run, so the worker parks and wakes repeatedly.
	for time.Now().Before(deadline) {
		onAudioContextThread(func() {
			if tid := int64(syscall.Gettid()); tid != audioTID.Load() {
				otherThread.Store(tid)
			}
		})
		time.Sleep(5 * time.Millisecond)
	}
	wg.Wait()

	if tid := otherThread.Load(); tid != 0 {
		t.Fatalf("an audio context ran on thread %d, not the dedicated thread %d", tid, audioTID.Load())
	}
	if sawAudioThread.Load() {
		t.Fatalf("another goroutine ran on the dedicated audio-context thread %d", audioTID.Load())
	}
}
