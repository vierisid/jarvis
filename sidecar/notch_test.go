package main

import (
	"strings"
	"testing"
)

func TestNotchStartsOff(t *testing.T) {
	if (&NotchService{}).Enabled() {
		t.Fatal("a fresh notch service must be off: only the brain turns it on")
	}
}

func TestNotchConfigureSetsTheSwitch(t *testing.T) {
	svc := &NotchService{}
	handle := makeNotchConfigureHandler(svc)

	res, err := handle(map[string]any{"enabled": true})
	if err != nil {
		t.Fatalf("notch.configure {enabled:true}: %v", err)
	}
	if !svc.Enabled() {
		t.Fatal("the switch did not turn on")
	}
	got, ok := res.Result.(map[string]any)
	if !ok {
		t.Fatalf("result is %T, want a map", res.Result)
	}
	if got["configured"] != true || got["enabled"] != true || got["surface"] != "none" {
		t.Fatalf("unexpected reply: %v", got)
	}

	if _, err := handle(map[string]any{"enabled": false}); err != nil {
		t.Fatalf("notch.configure {enabled:false}: %v", err)
	}
	if svc.Enabled() {
		t.Fatal("the switch did not turn off")
	}
}

// A malformed request must leave the switch where it was. The surface is dark
// by default, so "could not parse, turned on anyway" is the failure to rule out.
func TestNotchConfigureRefusesAnythingButABoolean(t *testing.T) {
	for name, params := range map[string]map[string]any{
		"missing": {},
		"string":  {"enabled": "true"},
		"number":  {"enabled": float64(1)},
		"null":    {"enabled": nil},
	} {
		svc := &NotchService{}
		if _, err := makeNotchConfigureHandler(svc)(params); err == nil {
			t.Errorf("%s: expected an error", name)
		}
		if svc.Enabled() {
			t.Errorf("%s: a refused request turned the switch on", name)
		}
	}
}

// The switch must not outlive the connection that set it. connectAndServe
// defers Reset; this pins what Reset does.
func TestNotchResetTurnsItOff(t *testing.T) {
	svc := &NotchService{}
	svc.Configure(true)
	svc.Reset("disconnect")
	if svc.Enabled() {
		t.Fatal("Reset left the switch on")
	}
	svc.Reset("disconnect") // a second reset is harmless
	if svc.Enabled() {
		t.Fatal("a second Reset turned the switch on")
	}
}

// notch.* is offered only when the capability is available, like every other
// surface. Without it the brain must get METHOD_NOT_FOUND, not a silent yes.
func TestNotchConfigureIsRegisteredOnlyWithTheCapability(t *testing.T) {
	cfg := defaultConfig()
	with := NewHandlerRegistry(&cfg, nil, []SidecarCapability{CapNotch}, nil, nil, nil, nil, nil, nil, "", nil)
	if _, ok := with["notch.configure"]; !ok {
		t.Fatal("notch.configure is missing although CapNotch is available")
	}
	without := NewHandlerRegistry(&cfg, nil, []SidecarCapability{CapTerminal}, nil, nil, nil, nil, nil, nil, "", nil)
	if _, ok := without["notch.configure"]; ok {
		t.Fatal("notch.configure is registered without CapNotch")
	}
}

func TestNotchIsADefaultCapability(t *testing.T) {
	for _, c := range defaultConfig().Capabilities {
		if c == CapNotch {
			return
		}
	}
	t.Fatal("CapNotch is not in the default capabilities, so the brain would never learn this build understands notch.*")
}

// The line between the brain and the notch's page. This app carries the
// messages and reads none of them.

func TestNotchPushRunsTheMessageInThePage(t *testing.T) {
	svc := &NotchService{}
	var ran []string
	svc.attachPage(func(script string) { ran = append(ran, script) })
	message := map[string]any{"type": "show", "line": map[string]any{"text": "Hello"}}
	if err := svc.Push(message); err != nil {
		t.Fatalf("push: %v", err)
	}
	want := `window.__notch_receive&&window.__notch_receive({"line":{"text":"Hello"},"type":"show"});`
	if len(ran) != 1 || ran[0] != want {
		t.Fatalf("the page ran %q, want %q", ran, want)
	}
}

// The message stands in a script as it is, so nothing in it may be able to
// end the script or a line early.
func TestNotchPushCannotBreakOutOfItsScript(t *testing.T) {
	svc := &NotchService{}
	var script string
	svc.attachPage(func(s string) { script = s })
	if err := svc.Push(map[string]any{"text": "</script><script>alert(1)//\u2028\u2029 \" ' \n"}); err != nil {
		t.Fatalf("push: %v", err)
	}
	for _, bad := range []string{"</script>", "<script>", "\u2028", "\u2029", "\n"} {
		if strings.Contains(script, bad) {
			t.Fatalf("the script carries %q unescaped: %s", bad, script)
		}
	}
}

func TestNotchPushIsRefusedWithNoPageNoMessageOrTooMuch(t *testing.T) {
	svc := &NotchService{}
	if err := svc.Push(map[string]any{"type": "rest"}); err == nil {
		t.Fatal("a push with no page up should be refused")
	}
	ran := 0
	svc.attachPage(func(string) { ran++ })
	if err := svc.Push(nil); err == nil {
		t.Fatal("a push with no message should be refused")
	}
	if err := svc.Push(map[string]any{"text": strings.Repeat("x", notchMessageMax)}); err == nil {
		t.Fatal("a message over the limit should be refused")
	}
	if ran != 0 {
		t.Fatalf("a refused push still ran %d scripts", ran)
	}
	// Once the window is going away nothing more goes into the page.
	svc.detachPage()
	if err := svc.Push(map[string]any{"type": "rest"}); err == nil || ran != 0 {
		t.Fatalf("a push after the page went away: err=%v, ran=%d", err, ran)
	}
}

func TestNotchPushHandlerNeedsTheSwitchOn(t *testing.T) {
	svc := &NotchService{}
	svc.attachPage(func(string) {})
	push := makeNotchPushHandler(svc)
	if _, err := push(map[string]any{"message": map[string]any{"type": "rest"}}); err == nil {
		t.Fatal("notch.push with the switch off should be refused")
	}
	svc.Configure(true)
	if _, err := push(map[string]any{}); err == nil {
		t.Fatal("notch.push without a message should be refused")
	}
	res, err := push(map[string]any{"message": map[string]any{"type": "rest"}})
	if err != nil || res.Result.(map[string]any)["pushed"] != true {
		t.Fatalf("notch.push: %v %v", res, err)
	}
}

func TestNotchPageMessagesGoToTheBrainAsTheyCame(t *testing.T) {
	svc := &NotchService{}
	if err := svc.fromPage(`{"type":"hello"}`); err == nil {
		t.Fatal("with no brain connected there is nowhere for a message to go")
	}
	var got []string
	svc.OnMessage(func(text string) { got = append(got, text) })
	for name, text := range map[string]string{
		"not JSON":   `{"type":`,
		"empty":      ``,
		"over limit": `"` + strings.Repeat("x", notchMessageMax) + `"`,
	} {
		if err := svc.fromPage(text); err == nil {
			t.Errorf("%s should be refused", name)
		}
	}
	if len(got) != 0 {
		t.Fatalf("refused messages were sent: %v", got)
	}
	text := `{"type":"answer","line":"l1","choice":"yes"}`
	if err := svc.fromPage(text); err != nil || len(got) != 1 || got[0] != text {
		t.Fatalf("a good message: err=%v, sent=%v", err, got)
	}
	// The connection is gone: the next message has nowhere to go.
	svc.OnMessage(nil)
	if err := svc.fromPage(text); err == nil {
		t.Fatal("a message after the brain went away should be refused")
	}
}
