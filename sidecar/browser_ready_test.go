package main

import (
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// errWriter fails every write, standing in for a pipe whose read end went away
// because the browser died at startup.
type errWriter struct{ err error }

func (w errWriter) Write(p []byte) (int, error) { return 0, w.err }
func (w errWriter) Close() error                { return nil }

// blackholeWriter accepts writes and never answers, standing in for a browser
// that has been spawned but is not reading the CDP pipe yet.
type blackholeWriter struct{ mu sync.Mutex }

func (w *blackholeWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(p), nil
}
func (w *blackholeWriter) Close() error { return nil }

func newTestClient(w io.WriteCloser) *cdpClient {
	return &cdpClient{
		proc:    &browserProc{write: w, read: io.NopCloser(strings.NewReader("")), kill: func() {}},
		pending: make(map[int64]chan cdpReply),
	}
}

// A browser that dies at startup must be reported immediately, not retried for
// the whole budget: every probe fails instantly with a transport error, so
// retrying would turn an accurate error into a long stall.
func TestWaitForBrowserReadyFailsFastOnTransportError(t *testing.T) {
	c := newTestClient(errWriter{err: errors.New("broken pipe")})

	start := time.Now()
	err := c.waitForBrowserReady(30 * time.Second)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected an error when the pipe is broken")
	}
	if !strings.Contains(err.Error(), "broken pipe") {
		t.Errorf("error should surface the transport cause, got: %v", err)
	}
	if errors.Is(err, errCDPTimeout) {
		t.Errorf("a transport failure must not be reported as a CDP timeout: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Errorf("should fail fast, took %s", elapsed)
	}
}

// A browser that is up but silent must be retried until the budget runs out,
// and the final error must name the timeout.
func TestWaitForBrowserReadyTimesOutWhenBrowserNeverAnswers(t *testing.T) {
	c := newTestClient(&blackholeWriter{})

	start := time.Now()
	err := c.waitForBrowserReady(500 * time.Millisecond)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if !errors.Is(err, errCDPTimeout) {
		t.Errorf("expected the wrapped CDP timeout sentinel, got: %v", err)
	}
	if elapsed < 500*time.Millisecond {
		t.Errorf("returned before the budget elapsed: %s", elapsed)
	}

	// Every abandoned probe must be removed from the pending map, or a long
	// wait would leak one entry per attempt.
	c.pendMu.Lock()
	leaked := len(c.pending)
	c.pendMu.Unlock()
	if leaked != 0 {
		t.Errorf("timed-out probes leaked %d pending entries", leaked)
	}
}

// A browser that answers must be detected, and quickly.
func TestWaitForBrowserReadySucceedsWhenBrowserAnswers(t *testing.T) {
	c := newTestClient(&blackholeWriter{})

	// Stand in for readLoop: resolve whatever probe is in flight.
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			c.pendMu.Lock()
			for id, ch := range c.pending {
				delete(c.pending, id)
				ch <- cdpReply{result: []byte(`{"product":"Chrome/1.2.3"}`)}
			}
			c.pendMu.Unlock()
			time.Sleep(5 * time.Millisecond)
		}
	}()

	if err := c.waitForBrowserReady(5 * time.Second); err != nil {
		t.Fatalf("expected readiness, got: %v", err)
	}
}

// The closed flag short-circuits the wait rather than probing a dead client.
func TestWaitForBrowserReadyStopsWhenClientClosed(t *testing.T) {
	c := newTestClient(&blackholeWriter{})
	c.closed.Store(true)

	err := c.waitForBrowserReady(30 * time.Second)
	if err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("expected a closed-connection error, got: %v", err)
	}
}
