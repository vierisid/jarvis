package main

import (
	"context"
	"log"
	"sync/atomic"
)

// What the notch says to the brain goes out from one goroutine of its own, in
// the order it was said.
//
// The ones who say it must never wait on the connection. Esc during a look is
// decided inside the keyboard hook, and what the page says arrives on the
// notch's own window thread. A write to a connection that has stalled (a
// brain on another machine, a picture still going up) waits for as long as
// the stall lasts: inside the hook that held up every key on the machine
// until Windows took the hook away without a word, and on the window thread
// it froze the notch. Here the one who says it puts it in a queue and goes
// on.
type notchOut struct {
	queue   chan func()
	dropped atomic.Int64
}

// notchOutRoom is how many things can wait to go out. A connection that is
// this far behind is not coming back in time for any of them.
const notchOutRoom = 256

// newNotchOut starts the goroutine that sends. It ends with ctx.
func newNotchOut(ctx context.Context, room int) *notchOut {
	out := &notchOut{queue: make(chan func(), room)}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case send := <-out.queue:
				// A connection that ended while this waited: there is
				// nowhere for it to go.
				if ctx.Err() != nil {
					return
				}
				send()
			}
		}
	}()
	return out
}

// do puts one send in the queue and comes back at once. With the queue full
// the send is dropped: that is told once, by its count and never by what it
// held.
func (o *notchOut) do(send func()) bool {
	select {
	case o.queue <- send:
		return true
	default:
		if n := o.dropped.Add(1); n == 1 || n%100 == 0 {
			log.Printf("[notch] the brain is not taking what the notch says: %d dropped", n)
		}
		return false
	}
}
