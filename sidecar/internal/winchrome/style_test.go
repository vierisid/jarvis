package winchrome

import (
	"strings"
	"testing"
)

// WS_OVERLAPPEDWINDOW, as webview creates its window and as its SetSize leaves
// it for WEBVIEW_HINT_NONE.
const wsOverlappedWindow = 0x00CF0000

func TestCaptionlessStyleDropsOnlyTheCaption(t *testing.T) {
	got := captionlessStyle(wsOverlappedWindow)
	if got&wsCaption != 0 {
		t.Fatalf("WS_CAPTION still set: %#08x", got)
	}
	// Everything the OS consults for behaviour must survive, or the window
	// silently loses resize, snap, Alt+Space or its taskbar entry.
	for _, want := range []struct {
		name string
		bit  uint32
	}{
		{"WS_THICKFRAME", wsThickFrame},
		{"WS_SYSMENU", wsSysMenu},
		{"WS_MINIMIZEBOX", wsMinimizeBox},
		{"WS_MAXIMIZEBOX", wsMaximizeBox},
	} {
		if got&want.bit == 0 {
			t.Errorf("%s missing from %#08x", want.name, got)
		}
	}
}

// A fixed-size window (webview's HINT_FIXED strips WS_THICKFRAME and
// WS_MAXIMIZEBOX) must stay fixed: handing it a resize border back would
// quietly break the size contract its caller asked for.
func TestCaptionlessStyleKeepsAFixedWindowFixed(t *testing.T) {
	fixed := uint32(wsOverlappedWindow) &^ (wsThickFrame | wsMaximizeBox)
	got := captionlessStyle(fixed)
	if got&wsThickFrame != 0 {
		t.Errorf("WS_THICKFRAME was added to a fixed-size window: %#08x", got)
	}
	if got&wsMaximizeBox != 0 {
		t.Errorf("WS_MAXIMIZEBOX was added to a fixed-size window: %#08x", got)
	}
	// The two that are always needed are still added: without WS_SYSMENU the
	// window loses Alt+Space and its taskbar close entry, and the page's
	// minimize button needs WS_MINIMIZEBOX to do anything.
	if got&wsSysMenu == 0 || got&wsMinimizeBox == 0 {
		t.Errorf("WS_SYSMENU/WS_MINIMIZEBOX missing from %#08x", got)
	}
}

func TestCaptionlessStyleIsIdempotent(t *testing.T) {
	once := captionlessStyle(wsOverlappedWindow)
	if twice := captionlessStyle(once); twice != once {
		t.Fatalf("not idempotent: %#08x then %#08x", once, twice)
	}
}

// The marker script runs before the document exists, so it must not assume
// documentElement is there and must re-apply once it is. Matching the whole
// call, not just the event name, so a rewrite that drops the listener cannot
// keep the test green on a leftover mention.
func TestChromeInitJSDefersUntilTheDocumentExists(t *testing.T) {
	js := initJS(500)
	for _, want := range []string{
		"window.__jarvisCustomChrome=true",
		"if(document.documentElement)",
		"setAttribute('data-chrome','custom')",
		"document.addEventListener('DOMContentLoaded',a)",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("initJS is missing %q", want)
		}
	}
}

// A dropped URL or file would otherwise navigate the document and carry the
// window-control bindings into whatever landed there. Plain text must still
// drop (the token form is a textarea), so the guard has to inspect the payload
// rather than cancel every drag.
func TestChromeInitJSRefusesNavigatingDropsOnly(t *testing.T) {
	js := initJS(500)
	for _, want := range []string{
		"'dragover'",
		"'drop'",
		"'Files'",
		"'text/uri-list'",
		"e.preventDefault()",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("the drop guard is missing %s", want)
		}
	}
	if strings.Contains(js, "var block=function(e){e.preventDefault") {
		t.Error("the drop guard cancels every drag; plain-text drops must still work")
	}
}

// The script is injected verbatim into the page; an unescaped </script> would
// truncate whatever document it lands in.
func TestChromeInitJSCannotCloseAScriptTag(t *testing.T) {
	if strings.Contains(strings.ToLower(initJS(500)), "</script") {
		t.Fatal("initJS contains </script")
	}
}

// The page times its own double-clicks, so it needs the user's real setting —
// and a sane number even when the OS call fails.
func TestInitJSCarriesTheDoubleClickTime(t *testing.T) {
	if !strings.Contains(initJS(900), "window.__jarvisDblClickMs=900;") {
		t.Error("initJS did not carry the configured double-click time")
	}
	if !strings.Contains(initJS(0), "window.__jarvisDblClickMs=500;") {
		t.Error("initJS must fall back to the Windows default of 500ms")
	}
}
