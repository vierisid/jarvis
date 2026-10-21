package main

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

// #886: only the Windows panel hides its page from WebView2 during the first
// load, so only it tracks the reveal for the page.
func TestPanelTracksRevealOnlyOnWindows(t *testing.T) {
	if panelTracksReveal != (runtime.GOOS == "windows") {
		t.Fatalf("panelTracksReveal = %v on %s, want it true exactly on windows", panelTracksReveal, runtime.GOOS)
	}
}

// The script a Windows panel loads with must mark the page not revealed
// before any page script runs, and only mark it revealed from the binding's
// answer. The JavaScript itself is run in ui/src/v2/voice/panelReveal.test.ts.
func TestPanelReadyInitScriptTracksTheRevealWhenAsked(t *testing.T) {
	got := panelReadyInitScript(true)
	if !strings.HasPrefix(got, "window.__jarvis_panel_revealed=false;") {
		t.Fatalf("tracking script does not start by marking the page not revealed: %s", got)
	}
	if strings.Count(got, "window.__jarvis_panel_revealed=true") != 1 ||
		!strings.Contains(got, "if(shown===true)window.__jarvis_panel_revealed=true") {
		t.Fatalf("tracking script must set the flag true only when the binding answers true: %s", got)
	}
}

// macOS and Linux keep the ready script they had before #886, byte for byte.
func TestPanelReadyInitScriptIsUnchangedWithoutTracking(t *testing.T) {
	const before = `(function(){try{var r=function(){if(window.__sidecar_panel_ready)window.__sidecar_panel_ready();};` +
		`if(document.readyState==='complete'){setTimeout(r,120);}` +
		`else{window.addEventListener('load',function(){setTimeout(r,120);});}}catch(e){}})();`
	if got := panelReadyInitScript(false); got != before {
		t.Fatalf("untracked ready script changed:\n got %s\nwant %s", got, before)
	}
}

// The spawn path must load this script and answer the binding with whether
// the window is shown: a binding that answers nothing would leave a Windows
// panel's page never revealed, and refuse every spoken answer in it.
// This pins source text on purpose: the wiring lives inside Spawn's closure,
// so a re-indent may need these strings updated, but a binding that answers
// nothing must not slip through unnoticed.
func TestPanelSpawnWiresTheRevealAnswer(t *testing.T) {
	src, err := os.ReadFile("panels_runtime.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	for _, want := range []string{
		"wv.Init(panelReadyInitScript(panelTracksReveal))",
		"_ = platformFocusWindow(earlyHandle)\n\t\t\t\t\t\tif panelTracksReveal {",
		"wv.Eval(panelRevealedScript)",
		"_ = wv.Bind(\"__sidecar_panel_ready\", func() bool {\n\t\t\t\t\tshowPanel()\n\t\t\t\t\treturn panelShown.Load()\n\t\t\t\t})",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("panels_runtime.go no longer contains %q", want)
		}
	}
}

// The script evaluated on reveal sets exactly the flag the dashboard reads.
func TestPanelRevealedScriptSetsTheFlag(t *testing.T) {
	if panelRevealedScript != "window.__jarvis_panel_revealed=true;" {
		t.Fatalf("panelRevealedScript = %q", panelRevealedScript)
	}
}
