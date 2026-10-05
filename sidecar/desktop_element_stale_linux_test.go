//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A desktop element id names one element of one tree walk (#661). These tests
// drive the real handlers end to end -- the real tree walk, the real temp
// script, the real exec -- with `python3` and `xdotool` replaced by recording
// fakes on PATH, so what "the surface changed" means is just the next walk
// answering differently. There is no X server, no AT-SPI bus and no app here;
// what is exercised is every line of the sidecar between the RPC and the
// process it would spawn to move the pointer.

type fakeDesktopSurface struct {
	t        *testing.T
	treeFile string
	callLog  string
	failWalk string
}

// fakeDesktop installs the fakes and returns the surface they report. `python3`
// prints whatever tree was last set (or exits 1 while failWalk exists), and
// `xdotool` appends one NUL-separated argv line per call and answers a window
// search with a title.
func fakeDesktop(t *testing.T) *fakeDesktopSurface {
	t.Helper()
	dir := t.TempDir()
	s := &fakeDesktopSurface{
		t:        t,
		treeFile: filepath.Join(dir, "tree.json"),
		callLog:  filepath.Join(dir, "xdotool.log"),
		failWalk: filepath.Join(dir, "fail-walk"),
	}
	python := "#!/bin/sh\n" +
		"if [ -e '" + s.failWalk + "' ]; then echo 'Atspi: bus gone' >&2; exit 1; fi\n" +
		"exec /bin/cat '" + s.treeFile + "'\n"
	xdotool := "#!/bin/sh\n" +
		"for a in \"$@\"; do printf '%s\\037' \"$a\"; done >> '" + s.callLog + "'\n" +
		"printf '\\n' >> '" + s.callLog + "'\n" +
		"if [ \"$1\" = search ]; then echo 'Fake Window'; fi\n"
	for name, body := range map[string]string{"python3": python, "xdotool": xdotool} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("DISPLAY", "")
	return s
}

type fakeElement struct {
	name, role string
	x, y, w, h int
}

func (s *fakeDesktopSurface) show(elems ...fakeElement) {
	s.t.Helper()
	out := make([]map[string]any, 0, len(elems))
	for i, e := range elems {
		out = append(out, map[string]any{
			"id": i, "name": e.name, "control_type": e.role, "automation_id": "",
			"enabled": true, "focusable": true,
			"rect": map[string]any{"x": e.x, "y": e.y, "w": e.w, "h": e.h},
		})
	}
	raw, err := json.Marshal(map[string]any{"elements": out, "element_count": len(out)})
	if err != nil {
		s.t.Fatal(err)
	}
	if err := os.WriteFile(s.treeFile, raw, 0o644); err != nil {
		s.t.Fatal(err)
	}
}

func (s *fakeDesktopSurface) breakWalk() {
	s.t.Helper()
	if err := os.WriteFile(s.failWalk, nil, 0o644); err != nil {
		s.t.Fatal(err)
	}
}

// pointerCalls returns every xdotool call that moved the pointer, clicked or
// typed since the last call, and clears the log.
func (s *fakeDesktopSurface) pointerCalls() []string {
	s.t.Helper()
	raw, err := os.ReadFile(s.callLog)
	if err != nil {
		return nil
	}
	os.Remove(s.callLog)
	var acted []string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		argv := strings.Split(strings.TrimSuffix(line, "\x1f"), "\x1f")
		switch argv[0] {
		case "mousemove", "click", "type", "key":
			acted = append(acted, strings.Join(argv, " "))
		}
	}
	return acted
}

// snapshot takes a desktop_snapshot of pid 4242 and returns the ids its reply
// handed out, in walk order -- the ids a model would send back.
func (s *fakeDesktopSurface) snapshot() []float64 {
	s.t.Helper()
	return s.snapshotOf(4242)
}

func (s *fakeDesktopSurface) snapshotOf(pid int) []float64 {
	s.t.Helper()
	res, err := handleGetWindowTree(map[string]any{"pid": float64(pid), "depth": float64(5)})
	if err != nil {
		s.t.Fatalf("desktop_snapshot: %v", err)
	}
	s.pointerCalls()
	return replyIDs(s.t, res.Result)
}

// replyIDs reads the ids a snapshot or find_element reply handed out.
func replyIDs(t *testing.T, result any) []float64 {
	t.Helper()
	var elems []map[string]any
	switch v := result.(map[string]any)["elements"].(type) {
	case []any:
		for _, e := range v {
			elems = append(elems, e.(map[string]any))
		}
	case []map[string]any:
		elems = v
	}
	var ids []float64
	for _, e := range elems {
		switch id := e["id"].(type) {
		case int:
			ids = append(ids, float64(id))
		case float64:
			ids = append(ids, id)
		default:
			t.Fatalf("element %v carries no numeric id", e)
		}
	}
	return ids
}

var (
	cancelButton = fakeElement{"Cancel", "push button", 100, 400, 80, 30}
	deleteButton = fakeElement{"Delete account", "push button", 200, 400, 120, 30}
	nameField    = fakeElement{"Name", "text", 100, 100, 300, 24}
)

// The defect itself, measured: the surface changes after the snapshot and the
// old id is clicked anyway. Each case is a way a window really changes between
// turns. Before #661 every one of them dispatched a click at the snapshot's
// coordinates.
func TestClickElementRefusesAnIdTheSurfaceNoLongerMatches(t *testing.T) {
	for _, tc := range []struct {
		name  string
		after []fakeElement
	}{
		// The window moved: same element, different place. The old centre
		// is now over whatever the window uncovered.
		{"window moved", []fakeElement{{"Cancel", "push button", 600, 700, 80, 30}, deleteButton}},
		// The dialog changed underneath the id: index 0 is now a different
		// control in the very spot the reviewed one was.
		{"different element at the id", []fakeElement{{"Delete account", "push button", 100, 400, 80, 30}}},
		// Same name, different role at the same place.
		{"role changed", []fakeElement{{"Cancel", "link", 100, 400, 80, 30}, deleteButton}},
		// The id no longer exists at all.
		{"id gone", []fakeElement{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := fakeDesktop(t)
			s.show(cancelButton, deleteButton)
			ids := s.snapshot()
			s.show(tc.after...)

			_, err := handleClickElement(map[string]any{"element_id": ids[0]})
			if err == nil {
				t.Fatalf("clicked a stale element; xdotool ran %q", s.pointerCalls())
			}
			if !strings.Contains(err.Error(), "desktop_snapshot") {
				t.Errorf("refusal %q does not tell the model to take a fresh snapshot", err)
			}
			if acted := s.pointerCalls(); len(acted) != 0 {
				t.Errorf("refused, but xdotool still ran %q", acted)
			}
		})
	}
}

// The guard is not a blanket refusal: an element that is still exactly what the
// snapshot reported is clicked, at its centre, every action. Without this the
// test above would pass against a handler that refuses everything.
func TestClickElementStillClicksAnUnchangedElement(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton, deleteButton)
	ids := s.snapshot()

	for action, want := range map[string]string{
		"click":        "mousemove --sync 260 415 click 1",
		"double_click": "mousemove --sync 260 415 click --repeat 2 1",
		"right_click":  "mousemove --sync 260 415 click 3",
		"focus":        "mousemove --sync 260 415 click 1",
	} {
		res, err := handleClickElement(map[string]any{"element_id": ids[1], "action": action})
		if err != nil {
			t.Fatalf("%s on an unchanged element: %v", action, err)
		}
		if got := s.pointerCalls(); len(got) != 1 || got[0] != want {
			t.Errorf("%s ran %q, want [%q]", action, got, want)
		}
		if r := res.Result.(map[string]any); r["x"] != 260 || r["y"] != 415 {
			t.Errorf("%s reported %v,%v, want 260,415", action, r["x"], r["y"])
		}
	}
}

// A changed element ELSEWHERE in the tree does not refuse this one. The
// comparison is per id, so a clock label ticking does not block a button.
func TestClickElementIgnoresChangesToOtherElements(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton, deleteButton, fakeElement{"12:00", "label", 0, 0, 40, 20})
	ids := s.snapshot()
	s.show(cancelButton, deleteButton, fakeElement{"12:01", "label", 0, 0, 40, 20})

	if _, err := handleClickElement(map[string]any{"element_id": ids[0]}); err != nil {
		t.Fatalf("an unrelated element changed and the click was refused: %v", err)
	}
	if got := s.pointerCalls(); len(got) != 1 {
		t.Errorf("xdotool ran %q, want one click", got)
	}
}

// A walk that cannot run cannot confirm anything, so nothing is clicked.
func TestClickElementRefusesWhenTheSurfaceCannotBeReRead(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton)
	ids := s.snapshot()
	s.breakWalk()

	_, err := handleClickElement(map[string]any{"element_id": ids[0]})
	if err == nil {
		t.Fatalf("clicked without confirming the element; xdotool ran %q", s.pointerCalls())
	}
	if !strings.Contains(err.Error(), "nothing was done") {
		t.Errorf("error %q does not say nothing was done", err)
	}
	if acted := s.pointerCalls(); len(acted) != 0 {
		t.Errorf("xdotool ran %q", acted)
	}
}

// desktop_type reaches the same cache through its optional element_id, and the
// stakes are higher there: a stale focus click followed by typing puts the
// text in whatever is at the old coordinate now.
func TestTypeTextRefusesAStaleElementWithoutTypingAnything(t *testing.T) {
	s := fakeDesktop(t)
	s.show(nameField)
	ids := s.snapshot()
	s.show(fakeElement{"Search the web", "text", 100, 100, 300, 24})

	_, err := handleTypeText(map[string]any{"element_id": ids[0], "text": "hunter2"})
	if err == nil {
		t.Fatalf("typed into a stale element; xdotool ran %q", s.pointerCalls())
	}
	if acted := s.pointerCalls(); len(acted) != 0 {
		t.Errorf("refused, but xdotool still ran %q", acted)
	}
}

func TestTypeTextStillTypesIntoAnUnchangedElement(t *testing.T) {
	s := fakeDesktop(t)
	s.show(nameField)
	ids := s.snapshot()

	if _, err := handleTypeText(map[string]any{"element_id": ids[0], "text": "Ada"}); err != nil {
		t.Fatalf("type into an unchanged element: %v", err)
	}
	got := s.pointerCalls()
	want := []string{"mousemove --sync 250 112 click 1", "type --delay 12 -- Ada"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("xdotool ran %q, want %q", got, want)
	}
}

// An id minted by find_element is checked the same way: it indexes the same
// cache, filled by the same walk.
func TestClickElementChecksAnIdMintedByFindElement(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton, deleteButton)
	res, err := handleFindElement(map[string]any{"pid": float64(4242), "name": "Delete account"})
	if err != nil {
		t.Fatalf("find_element: %v", err)
	}
	found := replyIDs(t, res.Result)
	if len(found) != 1 {
		t.Fatalf("find_element returned ids %v, want one match", found)
	}
	s.pointerCalls()

	// Unchanged: the id find_element handed out clicks the element it named.
	if _, err := handleClickElement(map[string]any{"element_id": found[0]}); err != nil {
		t.Fatalf("click a find_element result: %v", err)
	}
	if got := s.pointerCalls(); len(got) != 1 || got[0] != "mousemove --sync 260 415 click 1" {
		t.Errorf("xdotool ran %q, want a click on Delete account", got)
	}

	s.show(cancelButton, fakeElement{"Delete account", "push button", 900, 900, 120, 30})
	if _, err := handleClickElement(map[string]any{"element_id": found[0]}); err == nil {
		t.Fatalf("clicked a moved find_element result; xdotool ran %q", s.pointerCalls())
	}
}

// An id is bound to the walk that minted it, not just to whatever the cache
// holds now (#661 review). Without that binding, an id from snapshot A resolved
// against a LATER walk -- another window's find_element, a sub-agent's
// snapshot -- and the read-back compared that later walk with itself, so it
// confirmed an element the model was never shown and clicked it.
func TestClickElementRefusesAnIdFromAnEarlierWalk(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton, deleteButton)
	old := s.snapshot()

	// A different window's walk refills the cache. Its element 1 is exactly as
	// that walk reported it, so a read-back alone would pass.
	s.show(fakeElement{"Archive", "push button", 10, 10, 50, 20}, fakeElement{"Wipe disk", "push button", 200, 400, 120, 30})
	if _, err := handleFindElement(map[string]any{"pid": float64(99), "name": "Archive"}); err != nil {
		t.Fatalf("find_element: %v", err)
	}
	s.pointerCalls()

	_, err := handleClickElement(map[string]any{"element_id": old[1]})
	var coded *codedError
	if !errors.As(err, &coded) || coded.code != desktopStaleElementCode {
		t.Fatalf("an id from the earlier snapshot got %v; xdotool ran %q", err, s.pointerCalls())
	}
	if acted := s.pointerCalls(); len(acted) != 0 {
		t.Errorf("xdotool ran %q", acted)
	}

	// And the same for snapshot-on-snapshot of the SAME window: the newer
	// snapshot's ids work, the older one's do not, even though the surface did
	// not change at all.
	s.show(cancelButton, deleteButton)
	first := s.snapshot()
	second := s.snapshot()
	if first[0] == second[0] {
		t.Fatalf("two snapshots handed out the same id %v", first[0])
	}
	if _, err := handleClickElement(map[string]any{"element_id": first[0]}); err == nil {
		t.Errorf("an id from the superseded snapshot was clicked: %q", s.pointerCalls())
	}
	if _, err := handleClickElement(map[string]any{"element_id": second[0]}); err != nil {
		t.Errorf("an id from the current snapshot was refused: %v", err)
	}
}

// The ids a model sees are guessable only within one walk: a raw index -- what
// ids used to be -- names nothing.
// A snapshot that FAILS retires the previous snapshot's ids too: the model was
// told the newest snapshot holds the valid ids, and a failed one holds none.
// Without this, ids from the walk before kept clicking once the window could
// be read again.
func TestAFailedSnapshotRetiresThePreviousIds(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton, deleteButton)
	ids := s.snapshot()

	// AT-SPI fails: handleGetWindowTree answers with its no-elements fallback.
	s.breakWalk()
	res, err := handleGetWindowTree(map[string]any{"pid": float64(4242), "depth": float64(5)})
	if err != nil {
		t.Fatalf("the fallback snapshot errored: %v", err)
	}
	if got := replyIDs(t, res.Result); len(got) != 0 {
		t.Fatalf("the fallback snapshot handed out ids %v", got)
	}

	// The window becomes readable again, unchanged.
	if err := os.Remove(s.failWalk); err != nil {
		t.Fatal(err)
	}
	_, err = handleClickElement(map[string]any{"element_id": ids[1]})
	var coded *codedError
	if !errors.As(err, &coded) || coded.code != desktopStaleElementCode {
		t.Fatalf("an id from before the failed snapshot got %v; xdotool ran %q", err, s.pointerCalls())
	}
	if acted := s.pointerCalls(); len(acted) != 0 {
		t.Errorf("xdotool ran %q", acted)
	}
}

// The hint is for a caller whose read-back budget is tighter than a
// snapshot's (macOS desktop_type); it rides on the read-back failure only.
func TestReadBackFailureCarriesTheCallersHint(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton)
	ids := s.snapshot()
	s.breakWalk()
	_, err := resolveDesktopElement(int(ids[0]), atSPIWalkTimeout, ". HINT")
	if err == nil || !strings.HasSuffix(err.Error(), "Run desktop_snapshot again. HINT") {
		t.Errorf("got %v, want the hint after the snapshot advice", err)
	}
}

func TestClickElementRefusesARawIndex(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton, deleteButton)
	s.snapshot()
	for _, guess := range []float64{0, 1, -1, 1e15} {
		if _, err := handleClickElement(map[string]any{"element_id": guess}); err == nil {
			t.Errorf("guessed id %v was clicked: %q", guess, s.pointerCalls())
		}
	}
	if acted := s.pointerCalls(); len(acted) != 0 {
		t.Errorf("xdotool ran %q", acted)
	}
}

// A snapshot that refills the cache while a click is confirming an id must
// refuse the click, even when the read-back itself matched: the id the model
// sent was minted by the snapshot before. The walk is swapped for one that
// lands a snapshot mid-call -- the interleaving two RPC goroutines produce.
func TestClickElementRefusesWhenASnapshotLandsMidCall(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton, deleteButton)
	ids := s.snapshot()

	walk := walkDesktopElements
	t.Cleanup(func() { walkDesktopElements = walk })
	walkDesktopElements = func(pid, depth int, budget time.Duration) ([]any, error) {
		elems, err := walk(pid, depth, budget)
		if err == nil {
			elementCache.fill(elems, pid, depth)
		}
		return elems, err
	}

	if _, err := handleClickElement(map[string]any{"element_id": ids[0]}); err == nil ||
		!strings.Contains(err.Error(), "new snapshot replaced") {
		t.Fatalf("got %v, want the superseded refusal", err)
	}
	if acted := s.pointerCalls(); len(acted) != 0 {
		t.Errorf("xdotool ran %q", acted)
	}
}

// Every refusal is coded, so the daemon can report it as not started: the
// model may take a fresh snapshot and retry without first checking whether a
// click landed.
func TestStaleElementRefusalsCarryTheNotStartedCode(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton)
	ids := s.snapshot()

	for _, tc := range []struct {
		name string
		call func() error
	}{
		{"never minted", func() error {
			_, err := handleClickElement(map[string]any{"element_id": float64(7)})
			return err
		}},
		{"moved", func() error {
			s.show(fakeElement{"Cancel", "push button", 1, 1, 80, 30})
			_, err := handleClickElement(map[string]any{"element_id": ids[0]})
			return err
		}},
		{"through type_text", func() error {
			_, err := handleTypeText(map[string]any{"element_id": ids[0], "text": "x"})
			return err
		}},
		{"walk failed", func() error {
			s.breakWalk()
			_, err := handleClickElement(map[string]any{"element_id": ids[0]})
			return err
		}},
	} {
		err := tc.call()
		var coded *codedError
		if !errors.As(err, &coded) || coded.code != desktopStaleElementCode {
			t.Errorf("%s: got %v, want a %s refusal", tc.name, err, desktopStaleElementCode)
		}
	}
	if acted := s.pointerCalls(); len(acted) != 0 {
		t.Errorf("xdotool ran %q", acted)
	}
}
