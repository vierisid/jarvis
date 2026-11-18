package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

// The hardening audit, 17 November 2026: Esc during a look wrote to the
// connection from inside the keyboard hook. With the connection stalled,
// every key on the machine waited behind it.
func TestSayingSomethingNeverWaitsOnTheConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := newNotchOut(ctx, 4)
	stalled := make(chan struct{})
	started := make(chan struct{})
	out.do(func() { close(started); <-stalled })
	<-started

	began := time.Now()
	for i := 0; i < 50; i++ {
		out.do(func() {})
	}
	if took := time.Since(began); took > 200*time.Millisecond {
		t.Fatalf("saying 50 things to a stalled connection took %v: the one who says it must not wait", took)
	}
	if out.dropped.Load() != 46 {
		t.Errorf("4 can wait and 46 are dropped, got %d dropped", out.dropped.Load())
	}
	close(stalled)
}

func TestWhatIsSaidGoesOutInTheOrderItWasSaid(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := newNotchOut(ctx, notchOutRoom)
	var mu sync.Mutex
	var got []int
	done := make(chan struct{})
	for i := 0; i < 100; i++ {
		i := i
		out.do(func() {
			mu.Lock()
			got = append(got, i)
			mu.Unlock()
			if i == 99 {
				close(done)
			}
		})
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("not everything went out")
	}
	for i, n := range got {
		if n != i {
			t.Fatalf("out of order at %d: %v", i, got[:i+1])
		}
	}
}

func TestNothingGoesOutOnceTheConnectionIsOver(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	out := newNotchOut(ctx, 8)
	stalled := make(chan struct{})
	started := make(chan struct{})
	out.do(func() { close(started); <-stalled })
	<-started
	sent := make(chan struct{}, 1)
	out.do(func() { sent <- struct{}{} })
	cancel()
	close(stalled)
	select {
	case <-sent:
		t.Fatal("something went out after the connection was over")
	case <-time.After(150 * time.Millisecond):
	}
}
