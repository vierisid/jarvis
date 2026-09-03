package winchrome

import (
	"strings"
	"testing"

	"github.com/jarvis/sidecar/internal/brand"
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

// The caption sync is only as good as its inverse: a window that could not get
// its caption back is exactly the trap the sync exists to prevent.
func TestCaptionedStyleRestoresWhatCaptionlessStyleRemoved(t *testing.T) {
	for name, style := range map[string]uint32{
		// HintNone, as webview's SetSize leaves it.
		"resizable": wsOverlappedWindow,
		// HintFixed: SetSize strips the resize border and the maximize box.
		"fixed": wsOverlappedWindow &^ (wsThickFrame | wsMaximizeBox),
	} {
		t.Run(name, func(t *testing.T) {
			if got := captionedStyle(captionlessStyle(style)); got != style {
				t.Errorf("round trip gave %#08x, want %#08x", got, style)
			}
			// The sync calls whichever direction the document asks for, on a
			// style that may already be in that state, so both halves must be
			// no-ops the second time.
			once := captionedStyle(style)
			if twice := captionedStyle(once); twice != once {
				t.Errorf("captionedStyle not idempotent: %#08x then %#08x", once, twice)
			}
		})
	}
}

func TestCaptionedStyleAddsTheCaption(t *testing.T) {
	got := captionedStyle(captionlessStyle(wsOverlappedWindow))
	if got&wsCaption == 0 {
		t.Fatalf("WS_CAPTION not restored: %#08x", got)
	}
	// It must not take back what captionlessStyle added: a restored window
	// still wants Alt+Space and a working taskbar minimise.
	if got&wsSysMenu == 0 || got&wsMinimizeBox == 0 {
		t.Errorf("WS_SYSMENU/WS_MINIMIZEBOX lost on the way back: %#08x", got)
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

// The caption sync's JS half. The Go half (syncCaption) is Windows-only; this
// is what pins the contract between them.
func TestChromeInitJSSyncsTheCaptionToTheDocument(t *testing.T) {
	js := initJS(500)
	for _, want := range []string{
		// The discriminator. Not location: a NavigateToString document already
		// reports about:blank, exactly like the blank one a reload leaves.
		"getElementById('wchrome')",
		"window.__jarvis_chrome_sync",
		// Deferred, because the strip is the last element in <body> and does
		// not exist when this script runs.
		"DOMContentLoaded",
		// Top frame only: init runs in every frame, and a subframe without a
		// strip of its own must not un-chrome the window.
		"window.top===window",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("initJS is missing %q — the caption sync would not work", want)
		}
	}
}

// initJS asks for '#wchrome' and internal/brand's markup is what provides it.
// Nothing else couples those two strings: rename the id in the strip's markup
// and every chromed document starts reporting "no title bar here", so the sync
// hands back a native caption on top of a page that is already drawing its own.
// Test-only import, so no production dependency and no cycle.
func TestTheIDInitJSLooksForIsTheOneTheStripDefines(t *testing.T) {
	const id = "wchrome"
	if !strings.Contains(initJS(500), "getElementById('"+id+"')") {
		t.Fatalf("initJS no longer looks for #%s", id)
	}
	if !strings.Contains(brand.TitlebarHTML, `id="`+id+`"`) {
		t.Errorf("the title bar markup has no id=%q — the caption sync would fire on every chromed document", id)
	}
}
