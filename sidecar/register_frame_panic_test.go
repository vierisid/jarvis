package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// #670. `register_ack` and `register_rejected` are handled on the read loop's
// own goroutine, outside #623's runRPCHandler, so before the fix a panic in
// either ended the process: these tests aborted the test binary outright with
// `panic: runtime error: invalid memory address or nil pointer dereference`
// and no FAIL line, which is the shape of the production failure.
//
// The panic is provoked with a client that has no updater: both handlers call
// into it, and a nil *Updater faults on its first field access. What the panic
// is does not matter here -- the policy for each frame is what is pinned -- and
// a nil updater reaches the handlers through the real read loop over a real
// socket, which is the path production takes.

// brainScript starts a fake brain that sends `frames` in order to the sidecar
// that connects, then forwards every frame the sidecar sends back on `replies`.
func brainScript(t *testing.T, frames ...string) (wsURL string, replies <-chan map[string]any) {
	t.Helper()
	out := make(chan map[string]any, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		for _, f := range frames {
			if err := conn.Write(ctx, websocket.MessageText, []byte(f)); err != nil {
				return
			}
		}
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(data, &m) == nil {
				out <- m
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws://" + strings.TrimPrefix(srv.URL, "http://"), out
}

// connectedClient dials the fake brain and returns a client wired to it with
// no updater, plus the read loop's eventual return value.
func connectedClient(t *testing.T, wsURL string, handlers map[string]RPCHandler) (*SidecarClient, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial fake brain: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	c := &SidecarClient{handlers: handlers} // updater deliberately nil
	c.conn.Store(conn)
	done := make(chan error, 1)
	go func() { done <- c.readLoop(ctx) }()
	return c, done
}

// register_ack is advisory: the brain has already accepted the registration
// and every handler is installed. A panic while handling it is contained and
// the connection keeps serving RPCs.
func TestPanicInRegisterAckKeepsTheConnectionServing(t *testing.T) {
	wsURL, replies := brainScript(t,
		`{"type":"register_ack","update_status":"ok","latest":"0.10.0"}`,
		`{"type":"rpc_request","id":"after-ack","method":"echo","params":{}}`,
	)
	_, done := connectedClient(t, wsURL, map[string]RPCHandler{
		"echo": func(map[string]any) (*RPCResult, error) {
			return &RPCResult{Result: map[string]any{"ok": true}}, nil
		},
	})

	select {
	case m := <-replies:
		p, _ := m["payload"].(map[string]any)
		if m["type"] != "rpc_result" || p["rpc_id"] != "after-ack" || p["error"] != nil {
			t.Fatalf("the RPC after a panicking register_ack was not answered normally: %v", m)
		}
	case err := <-done:
		t.Fatalf("the read loop ended after a panicking register_ack (%v); it should carry on", err)
	case <-time.After(5 * time.Second):
		t.Fatal("no reply to the RPC sent after a panicking register_ack")
	}
}

// register_rejected is an authority verdict. A panic while handling it fails
// closed: the refusal still ends the connection and still leaves the client
// flagged incompatible, so Start backs off for blockedRetryInterval instead of
// reconnecting straight into the same refusal.
func TestPanicInRegisterRejectedStillRefuses(t *testing.T) {
	wsURL, _ := brainScript(t,
		`{"type":"register_rejected","reason":"incompatible","min":"9.0.0","your_version":"0.0.1","latest":"9.0.0"}`,
		// Must never be dispatched: the read loop has to stop at the refusal.
		`{"type":"rpc_request","id":"after-reject","method":"echo","params":{}}`,
	)
	dispatched := make(chan struct{}, 1)
	c, done := connectedClient(t, wsURL, map[string]RPCHandler{
		"echo": func(map[string]any) (*RPCResult, error) { dispatched <- struct{}{}; return nil, nil },
	})

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "registration rejected") {
			t.Fatalf("read loop returned %v, want the registration-rejected error", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the read loop did not end after register_rejected")
	}
	if !c.incompatible {
		t.Fatal("a panic in register_rejected handling lost the brain's verdict: the client is not flagged incompatible")
	}
	select {
	case <-dispatched:
		t.Fatal("an RPC after register_rejected was dispatched")
	default:
	}
}

// The verdict is recorded BEFORE the handler runs, not inside it, so it holds
// even when the handling panics at its very first line. With the assignment
// back inside handleRegisterRejected (where it was before #670) this fails: the
// recover contains the panic and the refusal silently becomes a fast reconnect.
func TestRegisterRejectedVerdictSurvivesAPanicAtTheFirstLine(t *testing.T) {
	c := &SidecarClient{}
	c.runRegisterRejected([]byte(`{"type":"register_rejected"}`), func([]byte) { panic("first line") })
	if !c.incompatible {
		t.Fatal("a panic before any handling ran lost the brain's verdict")
	}
}

// Carrying on after a contained ack panic is only sound if the panic cannot
// leave the updater's mutex held. advertise runs on the read loop, so a held
// u.mu would hang the tray's next Offer() and the next ack's advertise -- the
// read loop itself. Before advertise unlocked by defer, this test timed out.
func TestPanicInsideAdvertiseReleasesTheUpdaterLock(t *testing.T) {
	u := &Updater{running: "dev"}
	u.cancelRetry = func() { panic("cancel callback") } // runs while u.mu is held
	c := &SidecarClient{updater: u}

	c.runRegisterAck([]byte(`{"type":"register_ack","latest":"0.10.0"}`), c.handleRegisterAck)

	got := make(chan UpdateOffer, 1)
	go func() { got <- u.Offer() }()
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("u.mu is still held after a contained panic in advertise: Offer() never returned")
	}
	if u.cancelRetry != nil {
		t.Error("the panicking retry timer is still installed and would be cancelled again on the next ack")
	}
}
