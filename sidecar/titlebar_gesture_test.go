package main

// The title bar's gesture machine, driven in a real browser engine.
//
// TitlebarJS is the riskiest code in the custom-chrome feature and the only
// part with no Go surface to test: it decides, from a stream of pointer events,
// whether the user meant a click, a drag, or a double-click, and a wrong answer
// is a window that maximizes when it should move or sticks to the cursor. The
// Win32 half (the modal move loop itself) needs Windows, but everything above
// the bindings is ordinary DOM behaviour — so this stubs the five bindings,
// drives real PointerEvents through Chromium, and reads back what the page
// would have asked the window to do.
//
// OPT-IN: set JARVIS_BROWSER_TESTS=1 to run it, the same shape of gate as the
// page dump's JARVIS_PAGE_DUMP_DIR. It is not in the default suite because a
// headless browser is not a dependency this suite can rely on: on a CI runner
// Chrome was found, launched, and then never exited, taking the whole package
// to its 10-minute timeout. The hard timeout below means the worst case is now
// a failed test rather than a wedged suite, but the gate is what keeps a
// browser out of CI entirely.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// gestureDriver stubs the window-control bindings, then plays each scenario and
// records which bindings the page called. Appended after TitlebarJS so the
// listeners it installs are already live.
const gestureDriver = `
<script>
(async function () {
  var calls = [];
  var maximized = false;
  var stub = function (name, fn) {
    window['__jarvis_chrome_' + name] = function () {
      calls.push(name);
      return Promise.resolve(fn ? fn() : undefined);
    };
  };
  stub('drag');
  stub('minimize');
  stub('close');
  stub('sysmenu');
  stub('is_maximized', function () { return maximized; });
  stub('toggle_maximize', function () { maximized = !maximized; return maximized; });

  var bar = document.getElementById('wchrome-drag');
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var at = function (type, x, y, buttons) {
    var e = new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0,
      buttons: buttons === undefined ? 1 : buttons,
      clientX: x, clientY: y, screenX: x, screenY: y, pointerType: 'mouse'
    });
    (type === 'pointerdown' ? bar : window).dispatchEvent(e);
  };

  var results = {};
  var since = function () { return calls.length; };
  var taken = function (n) { return calls.slice(n); };

  // A press and release that never moved is a click, not a drag.
  var n = since();
  at('pointerdown', 60, 17); at('pointermove', 62, 18); at('pointerup', 62, 18, 0);
  results.click = taken(n);

  // Past the threshold, with the button still down, it is a drag -- once.
  await wait(600);
  n = since();
  at('pointerdown', 60, 17); at('pointermove', 90, 17); at('pointermove', 140, 17);
  at('pointerup', 140, 17, 0);
  await wait(0);
  results.drag = taken(n);

  // Dropping and grabbing again straight away must NOT read as a double-click.
  n = since();
  at('pointerdown', 141, 17); at('pointerup', 141, 17, 0);
  results.regrabAfterDrag = taken(n);

  // Two presses in the same place, inside the double-click window, maximize.
  await wait(600);
  n = since();
  at('pointerdown', 200, 17); at('pointerup', 200, 17, 0);
  await wait(40);
  at('pointerdown', 202, 17); at('pointerup', 202, 17, 0);
  results.doubleClick = taken(n);
  results.maximizedAfterDoubleClick = maximized;

  // ... and again to restore.
  await wait(600);
  n = since();
  at('pointerdown', 200, 17); at('pointerup', 200, 17, 0);
  await wait(40);
  at('pointerdown', 200, 17); at('pointerup', 200, 17, 0);
  results.restore = taken(n);
  results.maximizedAfterRestore = maximized;

  // Two presses far apart in time are two clicks, not a double-click.
  await wait(900);
  n = since();
  at('pointerdown', 300, 17); at('pointerup', 300, 17, 0);
  await wait(700);
  at('pointerdown', 300, 17); at('pointerup', 300, 17, 0);
  results.slowClicks = taken(n);

  // A press whose release was missed (released outside the window) must not
  // start a drag on the next stray move.
  await wait(600);
  n = since();
  at('pointerdown', 400, 17);
  at('pointermove', 460, 17, 0); // button already up
  results.lostRelease = taken(n);
  at('pointerup', 460, 17, 0);

  // The controls are not part of the drag region.
  await wait(600);
  n = since();
  document.getElementById('wchrome-min').click();
  document.getElementById('wchrome-close').click();
  results.controls = taken(n);

  // Right-click anywhere on the caption opens the system menu.
  n = since();
  document.getElementById('wchrome').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  results.contextMenu = taken(n);

  document.body.setAttribute('data-gesture', JSON.stringify(results));
})();
</script>
`

var gestureProbe = regexp.MustCompile(`data-gesture="([^"]*)"`)

type gestureResults struct {
	Click                     []string `json:"click"`
	Drag                      []string `json:"drag"`
	RegrabAfterDrag           []string `json:"regrabAfterDrag"`
	DoubleClick               []string `json:"doubleClick"`
	MaximizedAfterDoubleClick bool     `json:"maximizedAfterDoubleClick"`
	Restore                   []string `json:"restore"`
	MaximizedAfterRestore     bool     `json:"maximizedAfterRestore"`
	SlowClicks                []string `json:"slowClicks"`
	LostRelease               []string `json:"lostRelease"`
	Controls                  []string `json:"controls"`
	ContextMenu               []string `json:"contextMenu"`
}

func TestTitlebarGesture(t *testing.T) {
	if os.Getenv("JARVIS_BROWSER_TESTS") == "" {
		t.Skip("set JARVIS_BROWSER_TESTS=1 to drive the title bar in a real browser")
	}
	chrome := findChromium()
	if chrome == "" {
		t.Skip("no chromium/chrome on PATH — the gesture machine is browser-driven")
	}

	page := withCustomChrome(t, "settings", settingsWindowHTML)
	page = strings.Replace(page, "</body>", gestureDriver+"</body>", 1)
	dir := t.TempDir()
	path := filepath.Join(dir, "gesture.html")
	if err := os.WriteFile(path, []byte(page), 0600); err != nil {
		t.Fatal(err)
	}

	// The driver needs a few seconds of virtual time; anything beyond this is a
	// browser that is not going to finish, and it must not become the suite's
	// problem.
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, chrome,
		"--headless=new", "--disable-gpu", "--no-sandbox",
		"--disable-dev-shm-usage", "--no-first-run", "--disable-extensions",
		"--user-data-dir="+filepath.Join(dir, "profile"),
		"--virtual-time-budget=8000", "--window-size=520,560",
		"--dump-dom", "file://"+path,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("%s never exited within 90s; stderr:\n%s", chrome, stderr.String())
	}
	if err != nil {
		t.Fatalf("%s: %v; stderr:\n%s", chrome, err, stderr.String())
	}
	m := gestureProbe.FindSubmatch(out)
	if m == nil {
		t.Fatal("the driver never reported — TitlebarJS or the harness threw before finishing")
	}
	var got gestureResults
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(m[1]), "&quot;", `"`)), &got); err != nil {
		t.Fatalf("probe: %v", err)
	}

	eq := func(name string, got []string, want ...string) {
		t.Helper()
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s: called %v, want %v", name, got, want)
		}
	}
	// A click must not move the window: entering the modal move loop on a
	// press that never moved is what glues a window to the cursor.
	eq("plain click", got.Click)
	// Exactly one drag per gesture, however many moves it takes — followed by a
	// state re-read, because dropping a maximized window restores it and the
	// page's glyph has to follow.
	eq("drag", got.Drag, "drag", "is_maximized")
	// The press that ended a drag must not pair with the next one.
	eq("regrab after drag", got.RegrabAfterDrag)
	eq("double-click", got.DoubleClick, "toggle_maximize")
	if !got.MaximizedAfterDoubleClick {
		t.Error("double-click did not maximize")
	}
	eq("double-click again", got.Restore, "toggle_maximize")
	if got.MaximizedAfterRestore {
		t.Error("the second double-click did not restore")
	}
	// Two deliberate clicks are two clicks.
	eq("slow clicks", got.SlowClicks)
	eq("press whose release was lost", got.LostRelease)
	eq("window controls", got.Controls, "minimize", "close")
	eq("right-click", got.ContextMenu, "sysmenu")
}

func findChromium() string {
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}
