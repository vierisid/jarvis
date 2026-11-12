package main

import "testing"

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
