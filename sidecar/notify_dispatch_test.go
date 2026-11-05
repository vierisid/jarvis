package main

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/jarvis/sidecar/internal/update"
)

// #853. A tap on a macOS notification's "Open Jarvis" button (or on the banner
// itself, which notify_darwin.go maps to "review") was only forwarded to the
// brain, and the brain deliberately does nothing for review/view because they
// are "handled sidecar-side" (src/daemon/index.ts). On macOS nothing handled
// them: the tap did not open the dashboard. Windows has always opened it for
// the same actions. The decision now lives in one untagged helper both
// platforms call, so it is tested here on Linux and cannot drift per platform.

func TestNotifyActionOpensChat(t *testing.T) {
	cases := map[string]bool{
		"review":    true,
		"view":      true,
		"reconnect": true,
		"restart":   true,
		// Approve/Deny act on the brain and never open anything: the decision
		// is made in the notification.
		"approve": false,
		"deny":    false,
		"dismiss": false,
		"later":   false,
		"":        false,
		"REVIEW":  false,
	}
	for action, want := range cases {
		if got := notifyActionOpensChat(action); got != want {
			t.Errorf("notifyActionOpensChat(%q) = %v, want %v", action, got, want)
		}
	}
}

// dispatchNotifyAction always tells the brain (so it can mark the
// notification seen, or act on approve/deny) and opens the chat for the
// open-the-app actions only.
func TestDispatchNotifyActionEmitsAndOpens(t *testing.T) {
	var mu sync.Mutex
	var emitted []string
	prev := notifyEmitActionV.Load()
	t.Cleanup(func() {
		if f, ok := prev.(func(string, string, string) error); ok {
			setNotifyEmitAction(f)
		} else {
			setNotifyEmitAction(func(string, string, string) error { return nil })
		}
	})
	setNotifyEmitAction(func(id, kind, action string) error {
		mu.Lock()
		emitted = append(emitted, id+"/"+kind+"/"+action)
		mu.Unlock()
		return nil
	})

	for _, tc := range []struct {
		action string
		opens  bool
	}{{"review", true}, {"view", true}, {"approve", false}, {"dismiss", false}} {
		opened := make(chan struct{}, 1)
		dispatchNotifyAction("n1", "done", tc.action, func() { opened <- struct{}{} })
		select {
		case <-opened:
			if !tc.opens {
				t.Errorf("%q opened the chat", tc.action)
			}
		case <-time.After(300 * time.Millisecond):
			if tc.opens {
				t.Errorf("%q did not open the chat", tc.action)
			}
		}
	}
	// No opener (the tray is not up yet) is not a crash.
	dispatchNotifyAction("n2", "done", "review", nil)

	// The emit runs on the tray worker now (#1160), so wait for all five.
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(emitted)
		mu.Unlock()
		if n >= 5 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"n1/done/review", "n1/done/view", "n1/done/approve", "n1/done/dismiss", "n2/done/review"}
	if len(emitted) != len(want) {
		t.Fatalf("emitted %v, want %v", emitted, want)
	}
	for i := range want {
		if emitted[i] != want[i] {
			t.Errorf("emit %d = %q, want %q", i, emitted[i], want[i])
		}
	}
}

// The platform bridges are darwin- and windows-only cgo/syscall code that a
// Linux run cannot execute, so their wiring is pinned from the source: each
// must route its taps through dispatchNotifyAction with that platform's
// open-the-chat hook. Parsed, not grepped, so a comment mentioning the name
// does not satisfy it. The macOS half is what #853 was: goNotifyAction called
// notifyEmitAction alone.
func TestNotifyBridgesDispatchThroughTheSharedHelper(t *testing.T) {
	for _, tc := range []struct{ file, fn, opener string }{
		{"notify_bridge_darwin.go", "goNotifyAction", "trayOpenChatDarwin"},
		{"notify_windows.go", "handleNotifyURI", "trayOpenChat"},
		// The balloon fallback's click (#1160: it wrote to the brain on the
		// tray thread itself).
		{"notify_windows.go", "onBalloonClick", "trayOpenChat"},
	} {
		t.Run(tc.file, func(t *testing.T) {
			f, err := parser.ParseFile(token.NewFileSet(), tc.file, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			var body *ast.BlockStmt
			for _, d := range f.Decls {
				if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == tc.fn {
					body = fd.Body
				}
			}
			if body == nil {
				t.Fatalf("%s has no func %s", tc.file, tc.fn)
			}
			found, direct := false, false
			ast.Inspect(body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "notifyEmitAction" {
					direct = true
				}
				if id, ok := call.Fun.(*ast.Ident); !ok || id.Name != "dispatchNotifyAction" || len(call.Args) != 4 {
					return true
				}
				if id, ok := call.Args[3].(*ast.Ident); ok && id.Name == tc.opener {
					found = true
				}
				return true
			})
			if direct {
				t.Errorf("%s also calls notifyEmitAction directly: the brain would get every tap twice", tc.fn)
			}
			if !found {
				t.Errorf("%s does not call dispatchNotifyAction(..., %s): a tap on Open Jarvis would not open the dashboard",
					tc.fn, tc.opener)
			}
		})
	}
}

// #1160. A tap arrives on a UI thread (the Cocoa main thread, the Windows tray
// message loop), and the emit is a WebSocket write: with a brain that stopped
// reading, the tap froze the menu bar / tray for as long as the connection
// lived. dispatchNotifyAction must hand the write off and return.
func TestDispatchNotifyActionDoesNotWaitForTheBrainWrite(t *testing.T) {
	prev := notifyEmitActionV.Load()
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	t.Cleanup(func() {
		close(release)
		if f, ok := prev.(func(string, string, string) error); ok {
			setNotifyEmitAction(f)
		} else {
			setNotifyEmitAction(func(string, string, string) error { return nil })
		}
	})
	// A write the brain never takes.
	setNotifyEmitAction(func(string, string, string) error {
		entered <- struct{}{}
		<-release
		return nil
	})

	returned := make(chan struct{})
	go func() {
		dispatchNotifyAction("n1", "approval", "approve", nil)
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("dispatchNotifyAction blocked on the brain write: the tap would freeze the UI thread")
	}
	// It was handed off, not dropped.
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the notify.action write never ran")
	}
}

// The write itself is bounded, and still ends with its connection.
func TestSendUIEventBoundsTheWrite(t *testing.T) {
	var gotDeadline time.Time
	var hadDeadline bool
	start := time.Now()
	_ = sendUIEvent(context.Background(), func(ctx context.Context, e SidecarEvent) error {
		gotDeadline, hadDeadline = ctx.Deadline()
		if e.EventType != "notify.action" || e.Payload["action"] != "approve" {
			t.Errorf("event = %+v", e)
		}
		return nil
	}, "notify.action", map[string]any{"action": "approve"})
	if !hadDeadline {
		t.Fatal("the brain write has no deadline: a wedged connection holds it, and the tray worker, forever")
	}
	if d := gotDeadline.Sub(start); d <= 0 || d > uiEventWriteTimeout+time.Second {
		t.Errorf("deadline %v after the call, want about %v", d, uiEventWriteTimeout)
	}

	// A cancelled parent ends the write at once, not after the bound.
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	var sawErr error
	_ = sendUIEvent(parent, func(ctx context.Context, _ SidecarEvent) error {
		select {
		case <-ctx.Done():
			sawErr = ctx.Err()
		case <-time.After(time.Second):
		}
		return sawErr
	}, "tray.set_mute", nil)
	if !errors.Is(sawErr, context.Canceled) {
		t.Errorf("write on a closed connection's ctx: err %v, want context.Canceled", sawErr)
	}
}

// Every kind the brain sends needs a macOS category, or the notification shows
// with no buttons at all: macOS keys them off the category identifier. The
// kinds come from src/daemon/index.ts (approval via approvalToast, done,
// sidecar, update), src/daemon/usage-alerts-service.ts (usage) and
// src/workflows/runtime/binding-refusals.ts plus the readiness notice in
// index.ts (workflow). workflow had none until #1160. Read from the source
// because the Objective-C cannot run here.
func TestDarwinRegistersACategoryForEveryNotificationKind(t *testing.T) {
	src, err := os.ReadFile("notify_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`categoryWithIdentifier:@"([a-z_]+)"`)
	registered := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		registered[m[1]] = true
	}
	set := regexp.MustCompile(`setNotificationCategories:\[NSSet setWithObjects:([^\]]*)\]`).FindStringSubmatch(string(src))
	if set == nil {
		t.Fatal("no setNotificationCategories call found")
	}
	for _, kind := range []string{"approval", "approval_review", "done", "sidecar", "update", "usage", "workflow"} {
		if !registered[kind] {
			t.Errorf("no macOS notification category %q: that notification shows with no buttons", kind)
		}
	}
	// Defined is not enough: each must be in the set handed to the center.
	for _, v := range []string{"approval", "approvalReview", "done", "sidecar", "update", "usage", "workflow"} {
		if !regexp.MustCompile(`(^|[ ,])` + v + `,`).MatchString(set[1]) {
			t.Errorf("category variable %s is not registered with setNotificationCategories", v)
		}
	}
}

// #1160 review: the bound means an Approve or Deny can fail to reach the brain.
// The decision was then not made, so the chat opens to decide there instead of
// the tap silently doing nothing. A failed Dismiss opens nothing.
func TestUndeliveredDecisionOpensTheChat(t *testing.T) {
	prev := notifyEmitActionV.Load()
	t.Cleanup(func() {
		if f, ok := prev.(func(string, string, string) error); ok {
			setNotifyEmitAction(f)
		} else {
			setNotifyEmitAction(func(string, string, string) error { return nil })
		}
	})
	for _, tc := range []struct {
		action  string
		failErr error
		opens   bool
	}{
		{"approve", context.DeadlineExceeded, true},
		{"deny", errors.New("closed"), true},
		{"approve", nil, false},
		{"dismiss", context.DeadlineExceeded, false},
	} {
		setNotifyEmitAction(func(string, string, string) error { return tc.failErr })
		opened := make(chan struct{}, 2)
		dispatchNotifyAction("a1", "approval", tc.action, func() { opened <- struct{}{} })
		select {
		case <-opened:
			if !tc.opens {
				t.Errorf("%s (err %v) opened the chat", tc.action, tc.failErr)
			}
		case <-time.After(300 * time.Millisecond):
			if tc.opens {
				t.Errorf("%s that did not reach the brain (%v) opened nothing: the tap was silently lost", tc.action, tc.failErr)
			}
		}
	}
}

// The production writes for notification taps and tray toggles go through the
// bounded sendUIEvent (#1160). Pinned from the source, because the tray files
// are platform-tagged and client.go wires the emitter inside connectAndServe.
func TestTrayAndNotifyWritesAreBounded(t *testing.T) {
	for _, tc := range []struct{ file, target string }{
		{"client.go", "setNotifyEmitAction"},
		{"tray_windows.go", "trayEmit"},
		{"tray_darwin.go", "trayEmitDarwin"},
	} {
		t.Run(tc.file, func(t *testing.T) {
			f, err := parser.ParseFile(token.NewFileSet(), tc.file, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			var lits []*ast.FuncLit
			ast.Inspect(f, func(n ast.Node) bool {
				switch x := n.(type) {
				case *ast.CallExpr: // setNotifyEmitAction(func ...)
					if id, ok := x.Fun.(*ast.Ident); ok && id.Name == tc.target && len(x.Args) == 1 {
						if fl, ok := x.Args[0].(*ast.FuncLit); ok {
							lits = append(lits, fl)
						}
					}
				case *ast.AssignStmt: // trayEmit = func ...
					for i, l := range x.Lhs {
						if id, ok := l.(*ast.Ident); ok && id.Name == tc.target && i < len(x.Rhs) {
							if fl, ok := x.Rhs[i].(*ast.FuncLit); ok {
								lits = append(lits, fl)
							}
						}
					}
				}
				return true
			})
			if len(lits) != 1 {
				t.Fatalf("found %d func literals for %s, want 1", len(lits), tc.target)
			}
			bounded := false
			ast.Inspect(lits[0].Body, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok {
					if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "sendUIEvent" && len(call.Args) > 0 {
						bounded = true
						// The parent ctx must be Background: obsCtx is cancelled
						// by every update_config (reloadConfig), and a write on
						// it fails, or closes the connection (#1160 review).
						if types.ExprString(call.Args[0]) != "context.Background()" {
							t.Errorf("%s in %s writes on %s, want context.Background(): a config reload cancels obsCtx and every later tap fails",
								tc.target, tc.file, types.ExprString(call.Args[0]))
						}
					}
				}
				return true
			})
			if !bounded {
				t.Errorf("%s in %s does not write through sendUIEvent: the write has no deadline", tc.target, tc.file)
			}
		})
	}
}

// reloadConfig (every update_config, e.g. a dashboard sidecar-settings save)
// rebuilt the handler map from NewHandlerRegistry, which does not know the
// handlers connectAndServe registers: notify.show and tray.status answered
// METHOD_NOT_FOUND until the next reconnect, so no notification showed.
func TestConnectionHandlersSurviveAConfigReload(t *testing.T) {
	c := &SidecarClient{config: &SidecarConfig{}, claims: &SidecarTokenClaims{}, handlers: map[string]RPCHandler{}}
	names := []string{"notify.show", "tray.status"}
	for _, name := range names {
		c.setConnHandler(name, func(map[string]any) (*RPCResult, error) { return nil, nil })
		if _, ok := c.handlers[name]; !ok {
			t.Fatalf("%s not registered", name)
		}
	}
	c.mu.Lock()
	c.rebuildHandlers() // what reloadConfig does
	c.mu.Unlock()
	for _, name := range names {
		if _, ok := c.handlers[name]; !ok {
			t.Errorf("%s is gone after a config reload: the brain gets METHOD_NOT_FOUND until the next reconnect", name)
		}
	}
}

// The connection handlers are registered by connectAndServe itself, for every
// sidecar, not only one with the pebble (#1160 / #1159 review: they sat inside
// the pebble block, and a later version of this change took c.mu twice there
// and deadlocked the connection). Driven through the real connectAndServe
// against a fake brain: the RPCs must answer, not METHOD_NOT_FOUND, and the
// read loop must be running at all.
func TestConnectAndServeAnswersTheConnectionHandlers(t *testing.T) {
	prevShow := showNotification
	prevEmit := notifyEmitActionV.Load()
	prevTray := getTrayStatus()
	t.Cleanup(func() {
		showNotification = prevShow
		if f, ok := prevEmit.(func(string, string, string) error); ok {
			setNotifyEmitAction(f)
		} else {
			setNotifyEmitAction(func(string, string, string) error { return nil })
		}
		trayStatusMu.Lock()
		trayStatusCur = prevTray
		trayStatusMu.Unlock()
	})
	shown := make(chan Notification, 1)
	showNotification = func(n Notification) { shown <- n }

	wsURL, replies := brainScript(t,
		`{"type":"rpc_request","id":"r2","method":"notify.show","params":{"id":"n1","kind":"done","title":"t","body":"b"}}`,
		`{"type":"rpc_request","id":"r3","method":"tray.status","params":{}}`,
	)
	u := newFakeUpdater(t, "0.0.0-dev", update.Mode{Kind: update.ModeManual}).Updater
	c := &SidecarClient{
		config:   &SidecarConfig{},
		claims:   &SidecarTokenClaims{Brain: wsURL},
		handlers: map[string]RPCHandler{},
		updater:  u,
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.connectAndServe(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("connectAndServe did not return after cancel")
		}
	})

	got := map[string]map[string]any{}
	deadline := time.After(10 * time.Second)
	for len(got) < 2 {
		select {
		case m := <-replies:
			if p, ok := m["payload"].(map[string]any); ok && m["type"] == "rpc_result" {
				if id, ok := p["rpc_id"].(string); ok {
					got[id] = p
				}
			}
		case <-deadline:
			t.Fatalf("only %d of 2 RPCs answered (%v): connectAndServe never served them", len(got), got)
		}
	}
	for id, m := range got {
		if e, ok := m["error"].(map[string]any); ok && e != nil {
			t.Errorf("%s answered with error %v", id, e)
		}
	}
	select {
	case n := <-shown:
		if n.ID != "n1" {
			t.Errorf("shown %+v", n)
		}
	case <-time.After(2 * time.Second):
		t.Error("notify.show did not raise the notification")
	}
}
