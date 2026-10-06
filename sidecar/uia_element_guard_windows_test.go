//go:build windows

package main

import (
	"errors"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// #712: the Windows read-back (#661) against real UI Automation. The
// platform-neutral half is tested everywhere (uia_element_guard_test.go); this
// is the half that reads a live COM element's name, role and AutomationId, run
// against a window this test owns -- a button and an edit box -- so nothing
// else on the machine is read, focused or clicked. Every action used is
// get_value, which moves no pointer and takes no focus.
//
// Not in the sidecar-test-windows CI pattern (.github/workflows/test.yml) yet;
// run with `go test -run 'TestUIAReadBack' .` on Windows. findWindowByPid
// takes the first top-level window of this process, so these assume the test
// window is the only visible one -- keep that in mind before running them
// beside tests that leave a window open.
//
// Elements are found by AutomationId, which for a Win32 child window is its
// control id: 101 for the button, 102 for the edit box.

var (
	testUser32             = syscall.NewLazyDLL("user32.dll")
	testKernel32           = syscall.NewLazyDLL("kernel32.dll")
	tProcRegisterClassExW  = testUser32.NewProc("RegisterClassExW")
	tProcCreateWindowExW   = testUser32.NewProc("CreateWindowExW")
	tProcDefWindowProcW    = testUser32.NewProc("DefWindowProcW")
	tProcDestroyWindow     = testUser32.NewProc("DestroyWindow")
	tProcPeekMessageW      = testUser32.NewProc("PeekMessageW")
	tProcTranslateMessage  = testUser32.NewProc("TranslateMessage")
	tProcDispatchMessageW  = testUser32.NewProc("DispatchMessageW")
	tProcSetWindowTextW    = testUser32.NewProc("SetWindowTextW")
	tProcSetWindowLongPtrW = testUser32.NewProc("SetWindowLongPtrW")
	tProcGetModuleHandleW  = testKernel32.NewProc("GetModuleHandleW")
)

type testWndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSm     uintptr
}

type testMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      [2]int32
}

// testDialog is a top-level window with a "Send" button (control id 101) and
// an edit box (102), pumped on its own locked OS thread.
type testDialog struct {
	top, button, edit uintptr
	run               chan func()
	done              chan struct{}
}

func openTestDialog(t *testing.T) *testDialog {
	t.Helper()
	d := &testDialog{run: make(chan func()), done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer close(d.done)
		inst, cls := registerTestWindowClass()
		title, _ := syscall.UTF16PtrFromString("Jarvis read-back test")
		const wsOverlapped, wsVisible, wsChild, wsBorder = 0x00CF0000, 0x10000000, 0x40000000, 0x00800000
		const exToolWindow, exNoActivate = 0x00000080, 0x08000000
		d.top, _, _ = tProcCreateWindowExW.Call(exToolWindow|exNoActivate, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)),
			wsOverlapped|wsVisible, 40, 40, 320, 160, 0, 0, inst, 0)
		if d.top == 0 {
			ready <- errors.New("CreateWindowExW failed for the test window")
			return
		}
		mk := func(class, text string, x, id uintptr) uintptr {
			c, _ := syscall.UTF16PtrFromString(class)
			s, _ := syscall.UTF16PtrFromString(text)
			h, _, _ := tProcCreateWindowExW.Call(0, uintptr(unsafe.Pointer(c)), uintptr(unsafe.Pointer(s)),
				wsChild|wsVisible|wsBorder, x, 20, 120, 30, d.top, id, inst, 0)
			return h
		}
		d.button = mk("BUTTON", "Send", 10, 101)
		d.edit = mk("EDIT", "hello", 150, 102)
		ready <- nil
		var m testMsg
		for {
			select {
			case fn, ok := <-d.run:
				if !ok {
					tProcDestroyWindow.Call(d.top)
					return
				}
				fn()
			default:
			}
			for {
				r, _, _ := tProcPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, 1 /* PM_REMOVE */)
				if r == 0 {
					break
				}
				tProcTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
				tProcDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { close(d.run); <-d.done })
	return d
}

var (
	testClassOnce sync.Once
	testClassName *uint16
	testInstance  uintptr
)

// registerTestWindowClass registers the window class once per process: a
// callback made by syscall.NewCallback is never freed, and registering the
// same class again fails anyway.
func registerTestWindowClass() (uintptr, *uint16) {
	testClassOnce.Do(func() {
		testInstance, _, _ = tProcGetModuleHandleW.Call(0)
		testClassName, _ = syscall.UTF16PtrFromString("JarvisUIAReadBackTest")
		wc := testWndClassEx{wndProc: syscall.NewCallback(func(h, m, w, l uintptr) uintptr {
			r, _, _ := tProcDefWindowProcW.Call(h, m, w, l)
			return r
		}), instance: testInstance, className: testClassName, background: 16 /* COLOR_BTNFACE+1 */}
		wc.size = uint32(unsafe.Sizeof(wc))
		tProcRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	})
	return testInstance, testClassName
}

// on runs fn on the window's own thread.
func (d *testDialog) on(fn func()) {
	finished := make(chan struct{})
	d.run <- func() { fn(); close(finished) }
	<-finished
}

// snapshotIDs walks this process's window and returns the id of each named element.
func snapshotIDs(t *testing.T) map[string]int {
	t.Helper()
	out, err := comThread.call(func(s *uiaState) (any, error) {
		return uiaInspect(s, syscall.Getpid(), 3, false, false)
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	ids := map[string]int{}
	for _, el := range out.(map[string]any)["elements"].([]map[string]any) {
		if autoID, _ := el["automation_id"].(string); autoID != "" {
			ids[autoID] = el["id"].(int)
		}
	}
	return ids
}

// idOf is the id of the element with this AutomationId, failing the test when
// the walk did not list it -- an unlisted element's id would be 0, which is
// refused as "not cached" and would make a refusal test pass vacuously.
func idOf(t *testing.T, ids map[string]int, autoID string) int {
	t.Helper()
	id, ok := ids[autoID]
	if !ok {
		t.Fatalf("no element with AutomationId %q in the walk: %v", autoID, ids)
	}
	return id
}

func act(id int) (map[string]any, error) {
	out, err := comThread.call(func(s *uiaState) (any, error) { return uiaPerformAction(s, id, "get_value", "") })
	if out == nil {
		return nil, err
	}
	return out.(map[string]any), err
}

func isStale(err error) bool {
	var coded *codedError
	return errors.As(err, &coded) && coded.code == desktopStaleElementCode
}

func TestUIAReadBackActsOnAnUnchangedElement(t *testing.T) {
	openTestDialog(t)
	editID := idOf(t, snapshotIDs(t), "102")
	res, err := act(editID)
	if err != nil {
		t.Fatalf("an unchanged element was refused: %v", err)
	}
	if res["value"] != "hello" {
		t.Errorf("read %v, want the edit box's text", res["value"])
	}
}

func TestUIAReadBackRefusesARenamedElement(t *testing.T) {
	d := openTestDialog(t)
	sendID := idOf(t, snapshotIDs(t), "101")
	d.on(func() {
		s, _ := syscall.UTF16PtrFromString("Delete everything")
		tProcSetWindowTextW.Call(d.button, uintptr(unsafe.Pointer(s)))
	})
	_, err := act(sendID)
	if !isStale(err) || !strings.Contains(err.Error(), "different element") {
		t.Fatalf("got %v, want a stale-element refusal", err)
	}
}

func TestUIAReadBackRefusesAChangedAutomationID(t *testing.T) {
	// Same name, same role: only the AutomationId (a Win32 control's id) differs.
	d := openTestDialog(t)
	sendID := idOf(t, snapshotIDs(t), "101")
	d.on(func() {
		gwlpID := -12
		tProcSetWindowLongPtrW.Call(d.button, uintptr(gwlpID), 999)
	})
	_, err := act(sendID)
	if !isStale(err) || !strings.Contains(err.Error(), "different element") {
		t.Fatalf("got %v, want a stale-element refusal for a changed AutomationId", err)
	}
}

func TestUIAReadBackRefusesAnIDFromAnEarlierSnapshot(t *testing.T) {
	openTestDialog(t)
	first := idOf(t, snapshotIDs(t), "102")
	second := idOf(t, snapshotIDs(t), "102")
	if first == second {
		t.Fatalf("the second snapshot reused id %d", first)
	}
	if _, err := act(first); !isStale(err) || !strings.Contains(err.Error(), "not in the current element cache") {
		t.Fatalf("got %v, want a not-cached refusal", err)
	}
	if _, err := act(second); err != nil {
		t.Fatalf("the current snapshot's id was refused: %v", err)
	}
}
