//go:build windows

package main

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"github.com/go-ole/go-ole"
)

// ── COM vtable offsets (must match sidecar/uia_windows.go) ───────────
//
// IUIAutomation vtable (inherits IUnknown):
//  [5]  GetRootElement          [9-12] BuildCache variants
//  [13] CreateTreeWalker        [16] get_RawViewWalker
//  [21] CreateTrueCondition     [23] CreatePropertyCondition
//  [25] CreateAndCondition
//
// IUIAutomationElement vtable (inherits IUnknown):
//  [3]  SetFocus                [5]  FindFirst
//  [6]  FindAll                 [10] GetCurrentPropertyValue
//  [16] GetCurrentPattern       [43] get_CurrentBoundingRectangle
//
// IUIAutomationElementArray vtable (inherits IUnknown):
//  [3]  get_Length              [4]  GetElement

const (
	// IUIAutomation
	vt_GetRootElement          = 5
	vt_CreateTrueCondition     = 21
	vt_CreatePropertyCondition = 23
	vt_CreateAndCondition      = 25

	// IUIAutomationElement
	vt_SetFocus                    = 3
	vt_FindFirst                   = 5
	vt_FindAll                     = 6
	vt_GetCurrentPropertyValue     = 10
	vt_GetCurrentPattern           = 16
	vt_GetCurrentBoundingRectangle = 43

	// IUIAutomationElementArray
	vt_ArrayGetLength  = 3
	vt_ArrayGetElement = 4

	// UIA property IDs
	uia_ProcessIdPropertyId   = 30002
	uia_ControlTypePropertyId = 30003
	uia_NamePropertyId        = 30005
	uia_IsEnabledPropertyId   = 30010
	uia_AutomationIdPropertyId = 30011

	// UIA pattern IDs
	uia_InvokePatternId = 10000
	uia_ValuePatternId  = 10002
	uia_TogglePatternId = 10015

	// TreeScope
	treeScope_Children    = 0x2
	treeScope_Descendants = 0x4
)

var (
	clsid_CUIAutomation = ole.NewGUID("{FF48DBA4-60EF-4201-AA87-54103EEF594E}")
	iid_IUIAutomation   = ole.NewGUID("{30CBE57D-D9D0-452A-AB13-7AC5AC4825EE}")
)

// ── COM state ────────────────────────────────────────────────────────

type comState struct {
	automation *ole.IDispatch
}

var (
	comOnce  sync.Once
	comSt    *comState
	comErr   error
	comReqCh chan comReq
)

type comReq struct {
	fn     func(*comState) (any, error)
	result chan comRes
}

type comRes struct {
	val any
	err error
}

func ensureCOM() error {
	comOnce.Do(func() {
		comReqCh = make(chan comReq, 16)
		ready := make(chan error, 1)
		go comLoop(ready)
		comErr = <-ready
	})
	return comErr
}

func comLoop(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Recover from any panic during init so the main goroutine doesn't deadlock.
	defer func() {
		if r := recover(); r != nil {
			ready <- fmt.Errorf("COM init panic: %v", r)
		}
	}()

	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		ready <- fmt.Errorf("CoInitializeEx: %w", err)
		return
	}
	defer ole.CoUninitialize()

	unknown, err := ole.CreateInstance(clsid_CUIAutomation, iid_IUIAutomation)
	if err != nil {
		ready <- fmt.Errorf("create IUIAutomation: %w", err)
		return
	}
	automation := (*ole.IDispatch)(unsafe.Pointer(unknown))

	comSt = &comState{automation: automation}
	ready <- nil

	for req := range comReqCh {
		val, err := func() (v any, e error) {
			defer func() {
				if r := recover(); r != nil {
					v = nil
					e = fmt.Errorf("COM panic: %v", r)
				}
			}()
			return req.fn(comSt)
		}()
		req.result <- comRes{val, err}
	}
}

func comCall(fn func(*comState) (any, error)) (any, error) {
	if err := ensureCOM(); err != nil {
		return nil, err
	}
	req := comReq{fn: fn, result: make(chan comRes, 1)}
	comReqCh <- req
	res := <-req.result
	return res.val, res.err
}

// ── Vtable helpers ───────────────────────────────────────────────────

func vtbl(iface *ole.IDispatch, idx int) uintptr {
	return (*(*[1024]uintptr)(unsafe.Pointer(iface.RawVTable)))[idx]
}

// IUIAutomation

func getRootElement(automation *ole.IDispatch) (*ole.IDispatch, error) {
	var elem *ole.IDispatch
	hr, _, _ := syscall.SyscallN(vtbl(automation, vt_GetRootElement),
		uintptr(unsafe.Pointer(automation)),
		uintptr(unsafe.Pointer(&elem)))
	if hr != 0 {
		return nil, fmt.Errorf("GetRootElement: HRESULT 0x%x", hr)
	}
	return elem, nil
}


func createTrueCondition(automation *ole.IDispatch) (*ole.IDispatch, error) {
	var cond *ole.IDispatch
	hr, _, _ := syscall.SyscallN(vtbl(automation, vt_CreateTrueCondition),
		uintptr(unsafe.Pointer(automation)),
		uintptr(unsafe.Pointer(&cond)))
	if hr != 0 {
		return nil, fmt.Errorf("CreateTrueCondition: HRESULT 0x%x", hr)
	}
	return cond, nil
}

func createPropertyCondition(automation *ole.IDispatch, propertyId int, value int) (*ole.IDispatch, error) {
	v := ole.NewVariant(ole.VT_I4, int64(value))
	var cond *ole.IDispatch
	hr, _, _ := syscall.SyscallN(vtbl(automation, vt_CreatePropertyCondition),
		uintptr(unsafe.Pointer(automation)),
		uintptr(propertyId),
		uintptr(unsafe.Pointer(&v)),
		uintptr(unsafe.Pointer(&cond)))
	if hr != 0 {
		return nil, fmt.Errorf("CreatePropertyCondition: HRESULT 0x%x", hr)
	}
	return cond, nil
}

func createAndCondition(automation, cond1, cond2 *ole.IDispatch) (*ole.IDispatch, error) {
	var cond *ole.IDispatch
	hr, _, _ := syscall.SyscallN(vtbl(automation, vt_CreateAndCondition),
		uintptr(unsafe.Pointer(automation)),
		uintptr(unsafe.Pointer(cond1)),
		uintptr(unsafe.Pointer(cond2)),
		uintptr(unsafe.Pointer(&cond)))
	if hr != 0 {
		return nil, fmt.Errorf("CreateAndCondition: HRESULT 0x%x", hr)
	}
	return cond, nil
}

// IUIAutomationElement

func elemGetPropertyStr(elem *ole.IDispatch, propertyId int) (string, error) {
	var v ole.VARIANT
	ole.VariantInit(&v)
	defer ole.VariantClear(&v)
	hr, _, _ := syscall.SyscallN(vtbl(elem, vt_GetCurrentPropertyValue),
		uintptr(unsafe.Pointer(elem)),
		uintptr(propertyId),
		uintptr(unsafe.Pointer(&v)))
	if hr != 0 {
		return "", fmt.Errorf("GetCurrentPropertyValue(%d): HRESULT 0x%x", propertyId, hr)
	}
	if v.VT == ole.VT_BSTR {
		return v.ToString(), nil
	}
	return "", nil
}

func elemGetPropertyInt(elem *ole.IDispatch, propertyId int) (int, error) {
	var v ole.VARIANT
	ole.VariantInit(&v)
	defer ole.VariantClear(&v)
	hr, _, _ := syscall.SyscallN(vtbl(elem, vt_GetCurrentPropertyValue),
		uintptr(unsafe.Pointer(elem)),
		uintptr(propertyId),
		uintptr(unsafe.Pointer(&v)))
	if hr != 0 {
		return 0, fmt.Errorf("GetCurrentPropertyValue(%d): HRESULT 0x%x", propertyId, hr)
	}
	if v.VT == ole.VT_I4 {
		return int(v.Val), nil
	}
	return 0, nil
}

func elemGetPropertyBool(elem *ole.IDispatch, propertyId int) (bool, error) {
	var v ole.VARIANT
	ole.VariantInit(&v)
	defer ole.VariantClear(&v)
	hr, _, _ := syscall.SyscallN(vtbl(elem, vt_GetCurrentPropertyValue),
		uintptr(unsafe.Pointer(elem)),
		uintptr(propertyId),
		uintptr(unsafe.Pointer(&v)))
	if hr != 0 {
		return false, fmt.Errorf("GetCurrentPropertyValue(%d): HRESULT 0x%x", propertyId, hr)
	}
	if v.VT == ole.VT_BOOL {
		return v.Val != 0, nil
	}
	return false, nil
}

type rect struct{ Left, Top, Right, Bottom int32 }

func elemGetBoundingRect(elem *ole.IDispatch) (x, y, w, h int, err error) {
	var r rect
	hr, _, _ := syscall.SyscallN(vtbl(elem, vt_GetCurrentBoundingRectangle),
		uintptr(unsafe.Pointer(elem)),
		uintptr(unsafe.Pointer(&r)))
	if hr != 0 {
		return 0, 0, 0, 0, fmt.Errorf("get_CurrentBoundingRectangle: HRESULT 0x%x", hr)
	}
	return int(r.Left), int(r.Top), int(r.Right - r.Left), int(r.Bottom - r.Top), nil
}

func elemSetFocus(elem *ole.IDispatch) error {
	hr, _, _ := syscall.SyscallN(vtbl(elem, vt_SetFocus),
		uintptr(unsafe.Pointer(elem)))
	if hr != 0 {
		return fmt.Errorf("SetFocus: HRESULT 0x%x", hr)
	}
	return nil
}

func elemFindFirst(elem *ole.IDispatch, scope int, condition *ole.IDispatch) (*ole.IDispatch, error) {
	var found *ole.IDispatch
	hr, _, _ := syscall.SyscallN(vtbl(elem, vt_FindFirst),
		uintptr(unsafe.Pointer(elem)),
		uintptr(scope),
		uintptr(unsafe.Pointer(condition)),
		uintptr(unsafe.Pointer(&found)))
	if hr != 0 {
		return nil, fmt.Errorf("FindFirst: HRESULT 0x%x", hr)
	}
	return found, nil
}

func elemFindAll(elem *ole.IDispatch, scope int, condition *ole.IDispatch) (*ole.IDispatch, error) {
	var arr *ole.IDispatch
	hr, _, _ := syscall.SyscallN(vtbl(elem, vt_FindAll),
		uintptr(unsafe.Pointer(elem)),
		uintptr(scope),
		uintptr(unsafe.Pointer(condition)),
		uintptr(unsafe.Pointer(&arr)))
	if hr != 0 {
		return nil, fmt.Errorf("FindAll: HRESULT 0x%x", hr)
	}
	return arr, nil
}

func elemGetPattern(elem *ole.IDispatch, patternId int) (*ole.IDispatch, error) {
	var pattern *ole.IDispatch
	hr, _, _ := syscall.SyscallN(vtbl(elem, vt_GetCurrentPattern),
		uintptr(unsafe.Pointer(elem)),
		uintptr(patternId),
		uintptr(unsafe.Pointer(&pattern)))
	if hr != 0 || pattern == nil {
		return nil, fmt.Errorf("GetCurrentPattern(%d): HRESULT 0x%x", patternId, hr)
	}
	return pattern, nil
}


// IUIAutomationElementArray

func arrayLength(arr *ole.IDispatch) int {
	var length int32
	syscall.SyscallN(vtbl(arr, vt_ArrayGetLength),
		uintptr(unsafe.Pointer(arr)),
		uintptr(unsafe.Pointer(&length)))
	return int(length)
}

func arrayGetElement(arr *ole.IDispatch, index int) *ole.IDispatch {
	var elem *ole.IDispatch
	syscall.SyscallN(vtbl(arr, vt_ArrayGetElement),
		uintptr(unsafe.Pointer(arr)),
		uintptr(index),
		uintptr(unsafe.Pointer(&elem)))
	return elem
}

// ── Win32 helpers ────────────────────────────────────────────────────

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadPid  = user32.NewProc("GetWindowThreadProcessId")
)

func getForegroundPid() (int, error) {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return 0, fmt.Errorf("no foreground window")
	}
	var pid uint32
	procGetWindowThreadPid.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return 0, fmt.Errorf("could not get PID for foreground window")
	}
	return int(pid), nil
}

// ── Tests ────────────────────────────────────────────────────────────

func platformTests() []testCase {
	return []testCase{
		{"COM/Init", testCOMInit},
		{"IUIAutomation/GetRootElement", testGetRootElement},
		{"IUIAutomation/CreateTrueCondition", testCreateTrueCondition},
		{"IUIAutomation/CreatePropertyCondition_Int", testCreatePropertyConditionInt},
		{"IUIAutomation/CreateAndCondition", testCreateAndCondition},
		{"IUIAutomationElement/GetCurrentPropertyValue_Str", testElemPropertyStr},
		{"IUIAutomationElement/GetCurrentPropertyValue_Int", testElemPropertyInt},
		{"IUIAutomationElement/GetCurrentPropertyValue_Bool", testElemPropertyBool},
		{"IUIAutomationElement/GetCurrentBoundingRectangle", testElemBoundingRect},
		{"IUIAutomationElement/SetFocus", testElemSetFocus},
		{"IUIAutomationElement/FindFirst", testElemFindFirst},
		{"IUIAutomationElement/FindAll", testElemFindAll},
		{"IUIAutomationElement/GetCurrentPattern", testElemGetPattern},
		{"Integration/FindAllChildren", testFindAllChildren},
		{"Integration/FindWindowByPid", testFindWindowByPid},
		{"Integration/InspectForegroundWindow", testInspectForeground},
	}
}

func requireCOM(t *testCtx) {
	if err := ensureCOM(); err != nil {
		t.Skipf("COM init failed: %v", err)
	}
}

func testCOMInit(t *testCtx) {
	if err := ensureCOM(); err != nil {
		t.Fatalf("COM init: %v", err)
	}
	t.Logf("COM thread started, IUIAutomation acquired")
}

func testGetRootElement(t *testCtx) {
	requireCOM(t)
	val, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		if root == nil {
			return nil, fmt.Errorf("nil root")
		}
		defer root.Release()
		name, _ := elemGetPropertyStr(root, uia_NamePropertyId)
		return name, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
	t.Logf("root name: %q", val)
}

func testCreateTrueCondition(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		cond, err := createTrueCondition(s.automation)
		if err != nil {
			return nil, err
		}
		if cond == nil {
			return nil, fmt.Errorf("nil condition")
		}
		cond.Release()
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testCreatePropertyConditionInt(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		cond, err := createPropertyCondition(s.automation, uia_ProcessIdPropertyId, 0)
		if err != nil {
			return nil, err
		}
		if cond == nil {
			return nil, fmt.Errorf("nil condition")
		}
		cond.Release()
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testCreateAndCondition(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		c1, err := createTrueCondition(s.automation)
		if err != nil {
			return nil, fmt.Errorf("cond1: %w", err)
		}
		defer c1.Release()

		c2, err := createPropertyCondition(s.automation, uia_ProcessIdPropertyId, 0)
		if err != nil {
			return nil, fmt.Errorf("cond2: %w", err)
		}
		defer c2.Release()

		combined, err := createAndCondition(s.automation, c1, c2)
		if err != nil {
			return nil, err
		}
		if combined == nil {
			return nil, fmt.Errorf("nil combined condition")
		}
		combined.Release()
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testElemPropertyStr(t *testCtx) {
	requireCOM(t)
	val, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()
		return elemGetPropertyStr(root, uia_NamePropertyId)
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
	t.Logf("root name: %q", val)
}

func testElemPropertyInt(t *testCtx) {
	requireCOM(t)
	val, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()
		return elemGetPropertyInt(root, uia_ControlTypePropertyId)
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
	t.Logf("root ControlType: %v", val)
}

func testElemPropertyBool(t *testCtx) {
	requireCOM(t)
	val, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()
		return elemGetPropertyBool(root, uia_IsEnabledPropertyId)
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
	t.Logf("root IsEnabled: %v", val)
}

func testElemBoundingRect(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()
		x, y, w, h, err := elemGetBoundingRect(root)
		if err != nil {
			return nil, err
		}
		t.Logf("root rect: x=%d y=%d w=%d h=%d", x, y, w, h)
		if w == 0 && h == 0 {
			t.Errorf("root has zero-size bounding rect")
		}
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testElemSetFocus(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()
		// SetFocus on root may return E_INVALIDARG — that's fine, we just
		// want to confirm the vtable offset doesn't crash.
		err = elemSetFocus(root)
		if err != nil {
			t.Logf("SetFocus on root returned error (expected): %v", err)
		}
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testElemFindFirst(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()

		cond, err := createTrueCondition(s.automation)
		if err != nil {
			return nil, fmt.Errorf("create condition: %w", err)
		}
		defer cond.Release()

		child, err := elemFindFirst(root, treeScope_Children, cond)
		if err != nil {
			return nil, err
		}
		if child == nil {
			t.Logf("FindFirst returned nil (no children)")
			return true, nil
		}
		defer child.Release()
		name, _ := elemGetPropertyStr(child, uia_NamePropertyId)
		t.Logf("first child: %q", name)
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testElemFindAll(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()

		cond, err := createTrueCondition(s.automation)
		if err != nil {
			return nil, fmt.Errorf("create condition: %w", err)
		}
		defer cond.Release()

		arr, err := elemFindAll(root, treeScope_Children, cond)
		if err != nil {
			return nil, err
		}
		if arr == nil {
			t.Logf("FindAll returned nil")
			return true, nil
		}
		defer arr.Release()

		length := arrayLength(arr)
		t.Logf("FindAll: %d top-level children", length)

		for i := 0; i < length && i < 5; i++ {
			elem := arrayGetElement(arr, i)
			if elem == nil {
				continue
			}
			name, _ := elemGetPropertyStr(elem, uia_NamePropertyId)
			t.Logf("  [%d] %q", i, name)
			elem.Release()
		}
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testElemGetPattern(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()

		// Root doesn't support most patterns — just confirm the call
		// doesn't crash and returns a clean error.
		for _, pc := range []struct {
			id   int
			name string
		}{
			{uia_InvokePatternId, "Invoke"},
			{uia_ValuePatternId, "Value"},
			{uia_TogglePatternId, "Toggle"},
		} {
			p, err := elemGetPattern(root, pc.id)
			if err != nil {
				t.Logf("  %s: not supported (expected)", pc.name)
			} else {
				t.Logf("  %s: supported", pc.name)
				p.Release()
			}
		}
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testFindAllChildren(t *testCtx) {
	requireCOM(t)
	_, err := comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()

		cond, err := createTrueCondition(s.automation)
		if err != nil {
			return nil, fmt.Errorf("create condition: %w", err)
		}
		defer cond.Release()

		arr, err := elemFindAll(root, treeScope_Children, cond)
		if err != nil {
			return nil, err
		}
		if arr == nil {
			t.Logf("FindAll returned nil")
			return true, nil
		}
		defer arr.Release()

		length := arrayLength(arr)
		t.Logf("FindAll(Children): %d top-level children", length)
		for i := 0; i < length && i < 5; i++ {
			child := arrayGetElement(arr, i)
			if child == nil {
				continue
			}
			name, _ := elemGetPropertyStr(child, uia_NamePropertyId)
			t.Logf("  [%d] %q", i, name)
			child.Release()
		}
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testFindWindowByPid(t *testCtx) {
	requireCOM(t)
	pid, err := getForegroundPid()
	if err != nil {
		t.Skipf("no foreground window: %v", err)
	}
	t.Logf("foreground PID: %d", pid)

	_, err = comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()

		cond, err := createPropertyCondition(s.automation, uia_ProcessIdPropertyId, pid)
		if err != nil {
			return nil, fmt.Errorf("create PID condition: %w", err)
		}
		defer cond.Release()

		window, err := elemFindFirst(root, treeScope_Children, cond)
		if err != nil {
			return nil, fmt.Errorf("FindFirst for PID %d: %w", pid, err)
		}
		if window == nil {
			return nil, fmt.Errorf("no window found for PID %d", pid)
		}
		defer window.Release()

		title, _ := elemGetPropertyStr(window, uia_NamePropertyId)
		t.Logf("window title: %q", title)
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func testInspectForeground(t *testCtx) {
	requireCOM(t)
	pid, err := getForegroundPid()
	if err != nil {
		t.Skipf("no foreground window: %v", err)
	}

	_, err = comCall(func(s *comState) (any, error) {
		root, err := getRootElement(s.automation)
		if err != nil {
			return nil, err
		}
		defer root.Release()

		cond, err := createPropertyCondition(s.automation, uia_ProcessIdPropertyId, pid)
		if err != nil {
			return nil, fmt.Errorf("create PID condition: %w", err)
		}
		defer cond.Release()

		window, err := elemFindFirst(root, treeScope_Children, cond)
		if err != nil {
			return nil, err
		}
		if window == nil {
			return nil, fmt.Errorf("no window for PID %d", pid)
		}
		defer window.Release()

		title, _ := elemGetPropertyStr(window, uia_NamePropertyId)
		t.Logf("inspecting: %q (PID %d)", title, pid)

		// Enumerate children using FindAll
		trueCond, err := createTrueCondition(s.automation)
		if err != nil {
			return nil, fmt.Errorf("create condition: %w", err)
		}
		defer trueCond.Release()

		arr, err := elemFindAll(window, treeScope_Children, trueCond)
		if err != nil {
			return nil, fmt.Errorf("FindAll: %w", err)
		}
		if arr == nil {
			t.Logf("no children found")
			return true, nil
		}
		defer arr.Release()

		length := arrayLength(arr)
		count := 0
		for i := 0; i < length; i++ {
			child := arrayGetElement(arr, i)
			if child == nil {
				continue
			}

			name, _ := elemGetPropertyStr(child, uia_NamePropertyId)
			ctrlType, _ := elemGetPropertyInt(child, uia_ControlTypePropertyId)
			_, _, w, h, _ := elemGetBoundingRect(child)

			if w > 0 && h > 0 {
				count++
				if count <= 10 {
					t.Logf("  [%d] type=%d name=%q", count, ctrlType, truncStr(name, 60))
				}
			}
			child.Release()
		}

		t.Logf("total visible elements (depth 0): %d", count)
		if count == 0 {
			t.Errorf("expected at least one visible element")
		}
		return true, nil
	})
	if err != nil {
		t.Fatalf("%v", err)
	}
}

func truncStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
