package main

// The Windows handlers cannot run on the machine most tests run on, and the
// decisions they rest on are tested as plain functions (desktop_reach_test.go,
// desktop_pointer_test.go). Those tests would still pass if a handler stopped
// asking, or asked after it had acted. These read the handlers' own text and
// fail then: each says "this is asked, and before that is done".

import (
	"os"
	"strings"
	"testing"
)

// goFunc is the text of one top-level function of a source file.
func goFunc(t *testing.T, file, name string) string {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	src := string(raw)
	start := strings.Index(src, "\nfunc "+name+"(")
	if start < 0 {
		t.Fatalf("%s has no func %s", file, name)
	}
	end := strings.Index(src[start:], "\n}\n")
	if end < 0 {
		t.Fatalf("%s: func %s has no end", file, name)
	}
	return src[start : start+end]
}

// before fails unless every one of `first` is in body and comes before `then`.
func before(t *testing.T, where, body, then string, first ...string) {
	t.Helper()
	at := strings.Index(body, then)
	if at < 0 {
		t.Fatalf("%s: %q is not there", where, then)
	}
	for _, f := range first {
		if i := strings.Index(body, f); i < 0 || i > at {
			t.Errorf("%s: %q must come before %q", where, f, then)
		}
	}
}

func TestWindowsTypingAsksWhereItGoesBeforeTheFirstKey(t *testing.T) {
	typing := goFunc(t, "desktop_windows.go", "handleTypeText")
	before(t, "handleTypeText", typing, "typeTextNative(", "typeLineBreakIsSoft(params)", "ownWindow(front)", "windowKeyReach(front)", "keysBlocked")
	if !strings.Contains(typing, "typeTextNative(text, softBreak)") {
		t.Error("handleTypeText must type its line breaks the way it was asked to")
	}
	if !strings.Contains(typing, `"foreground_pid"`) || !strings.Contains(typing, `"delivery"`) {
		t.Error("handleTypeText must say which window got the text")
	}
	keys := goFunc(t, "desktop_windows.go", "handlePressKeys")
	before(t, "handlePressKeys", keys, "pressKeysNative(", "ownWindow(front)", "windowKeyReach(front)", "keysBlocked")
}

func TestWindowsPointerLooksBeforeItActs(t *testing.T) {
	act := goFunc(t, "desktop_pointer_windows.go", "handlePointerAction")
	before(t, "handlePointerAction", act, "switch req.Action {", "parsePointerRequest(params)", "pointerPlaceFree(x, y)")
	before(t, "handlePointerAction (drag)", act, "win32Drag(", "pointerPlaceFree(toX, toY)")
	free := goFunc(t, "desktop_pointer_windows.go", "pointerPlaceFree")
	for _, asked := range []string{"ownOverlayWindow(hit)", "ownWindow(hit)", "windowKeyReach(hit) == keysBlocked"} {
		if !strings.Contains(free, asked) {
			t.Errorf("pointerPlaceFree must ask %s", asked)
		}
	}
	// The last look, with the pointer already there, comes before any button.
	press := goFunc(t, "win32_reach_windows.go", "pointerPress")
	before(t, "pointerPress", press, "procMouseEvent.Call(", "procSetCursorPos.Call(", "ownWindow(win32RootWindow(win32WindowFromPoint(x, y)))")
	for _, name := range []string{"win32Scroll", "win32Drag"} {
		body := goFunc(t, "desktop_pointer_windows.go", name)
		before(t, name, body, "procMouseEvent.Call(", "ownWindow(win32RootWindow(win32WindowFromPoint(x, y)))")
	}
	// An element's click goes the same road.
	for _, name := range []string{"actionClick", "actionDoubleClick", "actionRightClick"} {
		body := goFunc(t, "uia_actions_windows.go", name)
		before(t, name, body, "pointerPress(x, y,", "pointerReachesElement(state, id, elem)")
	}
	reach := goFunc(t, "uia_actions_windows.go", "pointerReachesElement")
	if !strings.Contains(reach, "ownOverlayWindow(hit)") || !strings.Contains(reach, "pointerUnderNotch(") {
		t.Error("a click under the notch must be refused as that")
	}
}

func TestWindowsReadsTheWindowAPersonMeansAndSaysWhyItIsEmpty(t *testing.T) {
	find := goFunc(t, "uia_windows.go", "findWindowByPid")
	before(t, "findWindowByPid", find, "uiaElementFindFirst(", "topWindowOfPid(pid)")
	top := goFunc(t, "win32_reach_windows.go", "topWindowOfPid")
	before(t, "topWindowOfPid", top, "pickWindowOfPid(", "win32GetForegroundWindow()")
	walk := goFunc(t, "uia_windows.go", "walkTree")
	for _, asked := range []string{"budget.room(len(*results))", "budget.room(len(*results) + len(kids))", "budget.fits(len(*results))"} {
		if !strings.Contains(walk, asked) {
			t.Errorf("walkTree must ask %s", asked)
		}
	}
	inspect := goFunc(t, "uia_windows.go", "uiaInspect")
	for _, said := range []string{`"truncated"`, `"window_minimized"`, `"window_elevated"`} {
		if !strings.Contains(inspect, said) {
			t.Errorf("a window read must be able to say %s", said)
		}
	}
	list := goFunc(t, "win32_native_windows.go", "enumWindowsCallback")
	if !strings.Contains(list, "ownOverlayWindow(hwnd)") {
		t.Error("the notch's own windows must not be in the list of open windows")
	}
}

func TestWindowsNotchComesBackForAQuestion(t *testing.T) {
	asking := goFunc(t, "notch_host_windows.go", "platformNotchAsking")
	before(t, "platformNotchAsking", asking, "w.show()", "w.asking.Swap(asking)", "w.hidden.CompareAndSwap(true, false)")
	host, err := os.ReadFile("notch_host_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(host), "notchShouldHide(fullscreen, awake, playing, w.asking.Load())") {
		t.Error("the fullscreen rule must hear whether a question is waiting")
	}
	reveal := goFunc(t, "notch_host_windows.go", "platformNotchReveal")
	if !strings.Contains(reveal, "w.asking.Store(false)") {
		t.Error("a page that has just loaded is asking nothing")
	}
}

func TestWindowsLaunchKeepsOnePathWholeAndAsksTheStartMenuInGo(t *testing.T) {
	launch := goFunc(t, "desktop_windows.go", "handleLaunchApp")
	before(t, "handleLaunchApp", launch, "Start-Process", "launchArgLine(params,")
	menu := goFunc(t, "desktop_windows.go", "launchFromStartMenu")
	before(t, "launchFromStartMenu", menu, "startMenuLaunchScript(", "startMenuListScript()", "startMenuApps(out)", "startMenuPick(want, apps)")
}
