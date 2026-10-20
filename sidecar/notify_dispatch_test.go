package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"sync"
	"testing"
	"time"
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
		if f, ok := prev.(func(string, string, string)); ok {
			setNotifyEmitAction(f)
		} else {
			setNotifyEmitAction(func(string, string, string) {})
		}
	})
	setNotifyEmitAction(func(id, kind, action string) {
		mu.Lock()
		emitted = append(emitted, id+"/"+kind+"/"+action)
		mu.Unlock()
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
