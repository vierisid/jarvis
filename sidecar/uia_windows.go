//go:build windows

// uia_windows.go — Core UIAutomation COM wrapper.
//
// All COM operations run on a single dedicated goroutine (STA apartment)
// to avoid threading issues. Public functions send requests via channel.

package main

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"github.com/go-ole/go-ole"
)

// ── COM GUIDs ────────────────────────────────────────────────────────

var (
	CLSID_CUIAutomation = ole.NewGUID("{FF48DBA4-60EF-4201-AA87-54103EEF594E}")
	IID_IUIAutomation   = ole.NewGUID("{30CBE57D-D9D0-452A-AB13-7AC5AC4825EE}")
)

// UIAutomation property IDs
const (
	UIA_BoundingRectanglePropertyId  = 30001
	UIA_ProcessIdPropertyId          = 30002
	UIA_ControlTypePropertyId        = 30003
	UIA_NamePropertyId               = 30005
	UIA_IsKeyboardFocusablePropertyId = 30009
	UIA_IsEnabledPropertyId          = 30010
	UIA_AutomationIdPropertyId       = 30011
	UIA_ClassNamePropertyId          = 30012
)

// UIAutomation pattern IDs
const (
	UIA_InvokePatternId         = 10000
	UIA_ValuePatternId          = 10002
	UIA_ExpandCollapsePatternId = 10005
	UIA_SelectionItemPatternId  = 10010
	UIA_TextPatternId           = 10014
	UIA_TogglePatternId         = 10015
	UIA_ScrollItemPatternId     = 10017
)

// TreeScope constants
const (
	TreeScope_Children    = 0x2
	TreeScope_Descendants = 0x4
)

// ── COM Thread ───────────────────────────────────────────────────────

// uiaComThread manages the dedicated COM thread and request dispatch.
type uiaComThread struct {
	once    sync.Once
	reqCh   chan uiaReq
	initErr error
}

type uiaReq struct {
	fn     func(*uiaState) (any, error)
	result chan uiaRes
}

type uiaRes struct {
	val any
	err error
}

// uiaState holds COM objects that live on the COM thread.
type uiaState struct {
	automation *ole.IDispatch // IUIAutomation
	cache      *uiaElementCache
}

var comThread = &uiaComThread{
	reqCh: make(chan uiaReq, 16),
}

// ensureStarted lazily starts the COM thread on first use.
func (t *uiaComThread) ensureStarted() error {
	t.once.Do(func() {
		ready := make(chan error, 1)
		go t.run(ready)
		t.initErr = <-ready
		if t.initErr != nil {
			log.Printf("[uia] COM thread init failed: %v", t.initErr)
		} else {
			log.Printf("[uia] COM thread started")
		}
	})
	return t.initErr
}

func (t *uiaComThread) run(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		ready <- fmt.Errorf("CoInitializeEx: %w", err)
		return
	}
	defer ole.CoUninitialize()

	// Create IUIAutomation
	unknown, err := ole.CreateInstance(CLSID_CUIAutomation, IID_IUIAutomation)
	if err != nil {
		ready <- fmt.Errorf("create IUIAutomation: %w", err)
		return
	}
	automation := (*ole.IDispatch)(unsafe.Pointer(unknown))

	state := &uiaState{
		automation: automation,
		cache:      newUIAElementCache(),
	}

	ready <- nil

	// Process requests forever (with panic recovery to avoid crashing the sidecar)
	for req := range t.reqCh {
		val, err := func() (v any, e error) {
			defer func() {
				if r := recover(); r != nil {
					v = nil
					e = fmt.Errorf("COM thread panic: %v", r)
					log.Printf("[uia] Recovered from panic: %v", r)
				}
			}()
			return req.fn(state)
		}()
		req.result <- uiaRes{val, err}
	}

	// Cleanup (only reached if channel is closed)
	state.cache.clear()
	automation.Release()
}

// call dispatches a function to the COM thread and waits for result.
func (t *uiaComThread) call(fn func(*uiaState) (any, error)) (any, error) {
	if err := t.ensureStarted(); err != nil {
		return nil, err
	}
	req := uiaReq{fn: fn, result: make(chan uiaRes, 1)}
	t.reqCh <- req
	res := <-req.result
	return res.val, res.err
}

// ── IUIAutomation vtable helpers ─────────────────────────────────────

// IUIAutomation vtable layout (inherits IUnknown):
//  [0]  QueryInterface    [1]  AddRef             [2]  Release
//  [3]  CompareElements   [4]  CompareRuntimeIds  [5]  GetRootElement
//  [6]  ElementFromHandle [7]  ElementFromPoint   [8]  GetFocusedElement
//  [9]  GetRootElementBuildCache   [10] ElementFromHandleBuildCache
//  [11] ElementFromPointBuildCache [12] GetFocusedElementBuildCache
//  [13] CreateTreeWalker  [14] get_ControlViewWalker
//  [15] get_ContentViewWalker     [16] get_RawViewWalker
//  [17] get_RawViewCondition      [18] get_ControlViewCondition
//  [19] get_ContentViewCondition
//  [20] CreateCacheRequest        [21] CreateTrueCondition
//  [22] CreateFalseCondition      [23] CreatePropertyCondition
//  [24] CreatePropertyConditionEx [25] CreateAndCondition

func vtblOffset(iface *ole.IDispatch, idx int) uintptr {
	// IDispatch vtable: [QueryInterface, AddRef, Release, GetTypeInfoCount, GetTypeInfo, GetIDsOfNames, Invoke]
	// IUIAutomation is actually IUnknown-based, not IDispatch, but go-ole wraps it.
	// The actual vtable pointer is at the beginning of the object.
	vtbl := (*[1024]uintptr)(unsafe.Pointer(iface.RawVTable))
	return vtbl[idx]
}

func uiaGetRootElement(automation *ole.IDispatch) (*ole.IDispatch, error) {
	var elem *ole.IDispatch
	// IUIAutomation::GetRootElement = IUnknown(3) + offset 2 = vtable[5]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(automation, 5),
		uintptr(unsafe.Pointer(automation)),
		uintptr(unsafe.Pointer(&elem)),
	)
	if hr != 0 {
		return nil, fmt.Errorf("GetRootElement failed: HRESULT 0x%x", hr)
	}
	return elem, nil
}

func uiaCreateTrueCondition(automation *ole.IDispatch) (*ole.IDispatch, error) {
	var cond *ole.IDispatch
	// IUIAutomation::CreateTrueCondition = vtable[21]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(automation, 21),
		uintptr(unsafe.Pointer(automation)),
		uintptr(unsafe.Pointer(&cond)),
	)
	if hr != 0 {
		return nil, fmt.Errorf("CreateTrueCondition failed: HRESULT 0x%x", hr)
	}
	return cond, nil
}

func uiaCreatePropertyCondition(automation *ole.IDispatch, propertyId int, value interface{}) (*ole.IDispatch, error) {
	v := ole.NewVariant(ole.VT_I4, int64(0))
	switch val := value.(type) {
	case int:
		v = ole.NewVariant(ole.VT_I4, int64(val))
	case string:
		bstr := ole.SysAllocStringLen(val)
		v = ole.NewVariant(ole.VT_BSTR, int64(uintptr(unsafe.Pointer(bstr))))
		defer ole.SysFreeString(bstr)
	}

	var cond *ole.IDispatch
	// IUIAutomation::CreatePropertyCondition = vtable[23]
	// VARIANT (16 bytes) is passed by reference on x64 per Windows calling convention.
	hr, _, _ := syscall.SyscallN(
		vtblOffset(automation, 23),
		uintptr(unsafe.Pointer(automation)),
		uintptr(propertyId),
		uintptr(unsafe.Pointer(&v)),
		uintptr(unsafe.Pointer(&cond)),
	)
	if hr != 0 {
		return nil, fmt.Errorf("CreatePropertyCondition(%d) failed: HRESULT 0x%x", propertyId, hr)
	}
	return cond, nil
}

func uiaCreateAndCondition(automation *ole.IDispatch, cond1, cond2 *ole.IDispatch) (*ole.IDispatch, error) {
	var cond *ole.IDispatch
	// IUIAutomation::CreateAndCondition = vtable[25]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(automation, 25),
		uintptr(unsafe.Pointer(automation)),
		uintptr(unsafe.Pointer(cond1)),
		uintptr(unsafe.Pointer(cond2)),
		uintptr(unsafe.Pointer(&cond)),
	)
	if hr != 0 {
		return nil, fmt.Errorf("CreateAndCondition failed: HRESULT 0x%x", hr)
	}
	return cond, nil
}

// ── IUIAutomationElement helpers ─────────────────────────────────────
//
// IUIAutomationElement vtable layout (inherits IUnknown):
//  [0]  QueryInterface         [1]  AddRef                 [2]  Release
//  [3]  SetFocus               [4]  GetRuntimeId           [5]  FindFirst
//  [6]  FindAll                [7]  FindFirstBuildCache    [8]  FindAllBuildCache
//  [9]  BuildUpdatedCache      [10] GetCurrentPropertyValue
//  [11] GetCurrentPropertyValueEx  [12] GetCachedPropertyValue
//  [13] GetCachedPropertyValueEx   [14] GetCurrentPatternAs
//  [15] GetCachedPatternAs     [16] GetCurrentPattern      [17] GetCachedPattern
//  [18] GetCachedParent        [19] GetCachedChildren
//  [20] get_CurrentProcessId   [21] get_CurrentControlType
//  [22] get_CurrentLocalizedControlType  [23] get_CurrentName
//  ... (more Current* properties) ...
//  [43] get_CurrentBoundingRectangle

func uiaElementGetPropertyStr(elem *ole.IDispatch, propertyId int) string {
	var v ole.VARIANT
	ole.VariantInit(&v)
	defer ole.VariantClear(&v)

	// IUIAutomationElement::GetCurrentPropertyValue = IUnknown(3) + offset 7 = vtable[10]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(elem, 10),
		uintptr(unsafe.Pointer(elem)),
		uintptr(propertyId),
		uintptr(unsafe.Pointer(&v)),
	)
	if hr != 0 {
		return ""
	}
	if v.VT == ole.VT_BSTR {
		return v.ToString()
	}
	return ""
}

func uiaElementGetPropertyInt(elem *ole.IDispatch, propertyId int) int {
	var v ole.VARIANT
	ole.VariantInit(&v)
	defer ole.VariantClear(&v)

	// IUIAutomationElement::GetCurrentPropertyValue = vtable[10]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(elem, 10),
		uintptr(unsafe.Pointer(elem)),
		uintptr(propertyId),
		uintptr(unsafe.Pointer(&v)),
	)
	if hr != 0 {
		return 0
	}
	if v.VT == ole.VT_I4 {
		return int(v.Val)
	}
	return 0
}

func uiaElementGetPropertyBool(elem *ole.IDispatch, propertyId int) bool {
	var v ole.VARIANT
	ole.VariantInit(&v)
	defer ole.VariantClear(&v)

	// IUIAutomationElement::GetCurrentPropertyValue = vtable[10]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(elem, 10),
		uintptr(unsafe.Pointer(elem)),
		uintptr(propertyId),
		uintptr(unsafe.Pointer(&v)),
	)
	if hr != 0 {
		return false
	}
	if v.VT == ole.VT_BOOL {
		return v.Val != 0
	}
	return false
}

// RECT matches the Windows RECT structure.
type uiaRECT struct {
	Left, Top, Right, Bottom int32
}

func uiaElementGetBoundingRect(elem *ole.IDispatch) (x, y, w, h int) {
	var r uiaRECT
	// IUIAutomationElement::get_CurrentBoundingRectangle = IUnknown(3) + offset 40 = vtable[43]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(elem, 43),
		uintptr(unsafe.Pointer(elem)),
		uintptr(unsafe.Pointer(&r)),
	)
	if hr != 0 {
		return 0, 0, 0, 0
	}
	return int(r.Left), int(r.Top), int(r.Right - r.Left), int(r.Bottom - r.Top)
}

func uiaElementSetFocus(elem *ole.IDispatch) error {
	// IUIAutomationElement::SetFocus = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(elem, 3),
		uintptr(unsafe.Pointer(elem)),
	)
	if hr != 0 {
		return fmt.Errorf("SetFocus failed: HRESULT 0x%x", hr)
	}
	return nil
}

// IUIAutomationElement::FindFirst
func uiaElementFindFirst(elem *ole.IDispatch, scope int, condition *ole.IDispatch) (*ole.IDispatch, error) {
	var found *ole.IDispatch
	// IUIAutomationElement::FindFirst = IUnknown(3) + offset 2 = vtable[5]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(elem, 5),
		uintptr(unsafe.Pointer(elem)),
		uintptr(scope),
		uintptr(unsafe.Pointer(condition)),
		uintptr(unsafe.Pointer(&found)),
	)
	if hr != 0 {
		return nil, fmt.Errorf("FindFirst failed: HRESULT 0x%x", hr)
	}
	return found, nil
}

// IUIAutomationElement::FindAll
func uiaElementFindAll(elem *ole.IDispatch, scope int, condition *ole.IDispatch) (*ole.IDispatch, error) {
	var arr *ole.IDispatch
	// IUIAutomationElement::FindAll = IUnknown(3) + offset 3 = vtable[6]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(elem, 6),
		uintptr(unsafe.Pointer(elem)),
		uintptr(scope),
		uintptr(unsafe.Pointer(condition)),
		uintptr(unsafe.Pointer(&arr)),
	)
	if hr != 0 {
		return nil, fmt.Errorf("FindAll failed: HRESULT 0x%x", hr)
	}
	return arr, nil
}

// IUIAutomationElement::GetCurrentPattern
func uiaElementGetPattern(elem *ole.IDispatch, patternId int) (*ole.IDispatch, error) {
	var pattern *ole.IDispatch
	// IUIAutomationElement::GetCurrentPattern = IUnknown(3) + offset 13 = vtable[16]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(elem, 16),
		uintptr(unsafe.Pointer(elem)),
		uintptr(patternId),
		uintptr(unsafe.Pointer(&pattern)),
	)
	if hr != 0 || pattern == nil {
		return nil, fmt.Errorf("GetCurrentPattern(%d) failed: HRESULT 0x%x", patternId, hr)
	}
	return pattern, nil
}

// ── IUIAutomationElementArray helpers ────────────────────────────────

func uiaArrayLength(arr *ole.IDispatch) int {
	var length int32
	// IUIAutomationElementArray::get_Length = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(arr, 3),
		uintptr(unsafe.Pointer(arr)),
		uintptr(unsafe.Pointer(&length)),
	)
	if hr != 0 {
		return 0
	}
	return int(length)
}

func uiaArrayGetElement(arr *ole.IDispatch, index int) *ole.IDispatch {
	var elem *ole.IDispatch
	// IUIAutomationElementArray::GetElement = IUnknown(3) + offset 1 = vtable[4]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(arr, 4),
		uintptr(unsafe.Pointer(arr)),
		uintptr(index),
		uintptr(unsafe.Pointer(&elem)),
	)
	if hr != 0 {
		return nil
	}
	return elem
}

// ── High-level operations ────────────────────────────────────────────

// controlTypeNames maps UIAutomation ControlType IDs to human-readable names.
var controlTypeNames = map[int]string{
	50000: "Button", 50001: "Calendar", 50002: "CheckBox",
	50003: "ComboBox", 50004: "Edit", 50005: "Hyperlink",
	50006: "Image", 50007: "ListItem", 50008: "List",
	50009: "Menu", 50010: "MenuBar", 50011: "MenuItem",
	50012: "ProgressBar", 50013: "RadioButton", 50014: "ScrollBar",
	50015: "Slider", 50016: "Spinner", 50017: "StatusBar",
	50018: "Tab", 50019: "TabItem", 50020: "Text",
	50021: "ToolBar", 50022: "ToolTip", 50023: "Tree",
	50024: "TreeItem", 50025: "Custom", 50026: "Group",
	50027: "Thumb", 50028: "DataGrid", 50029: "DataItem",
	50030: "Document", 50031: "SplitButton", 50032: "Window",
	50033: "Pane", 50034: "Header", 50035: "HeaderItem",
	50036: "Table", 50037: "TitleBar", 50038: "Separator",
	50039: "SemanticZoom", 50040: "AppBar",
}

func controlTypeName(id int) string {
	if name, ok := controlTypeNames[id]; ok {
		return name
	}
	return fmt.Sprintf("Unknown(%d)", id)
}

// buildElementInfo extracts element properties into a map matching the expected JSON shape.
func buildElementInfo(elem *ole.IDispatch, id, depth int) map[string]any {
	x, y, w, h := uiaElementGetBoundingRect(elem)
	name := uiaElementGetPropertyStr(elem, UIA_NamePropertyId)
	if len(name) > 100 {
		name = name[:100]
	}
	ctrlType := uiaElementGetPropertyInt(elem, UIA_ControlTypePropertyId)

	return map[string]any{
		"id":            id,
		"name":          name,
		"automation_id": uiaElementGetPropertyStr(elem, UIA_AutomationIdPropertyId),
		"class_name":    uiaElementGetPropertyStr(elem, UIA_ClassNamePropertyId),
		"control_type":  controlTypeName(ctrlType),
		"enabled":       uiaElementGetPropertyBool(elem, UIA_IsEnabledPropertyId),
		"focusable":     uiaElementGetPropertyBool(elem, UIA_IsKeyboardFocusablePropertyId),
		"rect":          map[string]any{"x": x, "y": y, "w": w, "h": h},
		"patterns":      getSupportedPatterns(elem),
		"depth":         depth,
	}
}

// getSupportedPatterns checks which UIA patterns are available on an element.
func getSupportedPatterns(elem *ole.IDispatch) []string {
	patternChecks := []struct {
		id   int
		name string
	}{
		{UIA_InvokePatternId, "Invoke"},
		{UIA_ValuePatternId, "Value"},
		{UIA_TogglePatternId, "Toggle"},
		{UIA_SelectionItemPatternId, "SelectionItem"},
		{UIA_ExpandCollapsePatternId, "ExpandCollapse"},
		{UIA_ScrollItemPatternId, "ScrollItem"},
		{UIA_TextPatternId, "Text"},
	}

	var patterns []string
	for _, pc := range patternChecks {
		p, err := uiaElementGetPattern(elem, pc.id)
		if err == nil && p != nil {
			patterns = append(patterns, pc.name)
			p.Release()
		}
	}
	return patterns
}

// findWindowByPid finds the first top-level window for a given PID using UIAutomation.
func findWindowByPid(state *uiaState, pid int) (*ole.IDispatch, error) {
	root, err := uiaGetRootElement(state.automation)
	if err != nil {
		return nil, err
	}
	defer root.Release()

	cond, err := uiaCreatePropertyCondition(state.automation, UIA_ProcessIdPropertyId, pid)
	if err != nil {
		return nil, err
	}
	defer cond.Release()

	window, err := uiaElementFindFirst(root, TreeScope_Children, cond)
	if err != nil {
		return nil, err
	}
	if window == nil {
		return nil, fmt.Errorf("no window found for PID %d", pid)
	}
	return window, nil
}

// resolvePid returns the given PID or resolves the foreground window PID.
func resolvePid(pid int) (int, error) {
	if pid > 0 {
		return pid, nil
	}
	fgHwnd := win32GetForegroundWindow()
	if fgHwnd == 0 {
		return 0, fmt.Errorf("no foreground window found")
	}
	fgPid := win32GetWindowPid(fgHwnd)
	if fgPid == 0 {
		return 0, fmt.Errorf("could not determine foreground window PID")
	}
	return int(fgPid), nil
}

// walkTree recursively walks the UIAutomation tree using FindAll(TreeScope_Children).
// trueCond is a pre-created TrueCondition to avoid repeated COM allocations.
func walkTree(state *uiaState, trueCond *ole.IDispatch, parent *ole.IDispatch, depth, maxDepth int, includeInvisible bool, results *[]map[string]any) {
	if depth > maxDepth {
		return
	}

	arr, err := uiaElementFindAll(parent, TreeScope_Children, trueCond)
	if err != nil || arr == nil {
		return
	}
	defer arr.Release()

	count := uiaArrayLength(arr)
	for i := 0; i < count; i++ {
		child := uiaArrayGetElement(arr, i)
		if child == nil {
			continue
		}

		x, y, w, h := uiaElementGetBoundingRect(child)
		visible := w > 0 && h > 0
		_ = x
		_ = y

		if visible || includeInvisible {
			id := state.cache.add(child)
			info := buildElementInfo(child, id, depth)
			*results = append(*results, info)
		}

		walkTree(state, trueCond, child, depth+1, maxDepth, includeInvisible, results)

		if !visible && !includeInvisible {
			child.Release()
		}
	}
}

// uiaInspect performs a tree inspection and returns the result map.
func uiaInspect(state *uiaState, pid, maxDepth int, includeInvisible bool) (map[string]any, error) {
	pid, err := resolvePid(pid)
	if err != nil {
		return nil, err
	}

	window, err := findWindowByPid(state, pid)
	if err != nil {
		return nil, err
	}
	defer window.Release()

	state.cache.clear()

	trueCond, err := uiaCreateTrueCondition(state.automation)
	if err != nil {
		return nil, fmt.Errorf("CreateTrueCondition: %w", err)
	}
	defer trueCond.Release()

	var elements []map[string]any
	walkTree(state, trueCond, window, 0, maxDepth, includeInvisible, &elements)

	windowTitle := uiaElementGetPropertyStr(window, UIA_NamePropertyId)

	return map[string]any{
		"window_title":  windowTitle,
		"pid":           pid,
		"element_count": len(elements),
		"elements":      elements,
	}, nil
}

// uiaFindElements searches for elements matching the given criteria.
func uiaFindElements(state *uiaState, pid int, automationId, name, className, controlType string) (map[string]any, error) {
	pid, err := resolvePid(pid)
	if err != nil {
		return nil, err
	}

	window, err := findWindowByPid(state, pid)
	if err != nil {
		return nil, err
	}
	defer window.Release()

	// Build conditions
	var conditions []*ole.IDispatch
	defer func() {
		for _, c := range conditions {
			c.Release()
		}
	}()

	if automationId != "" {
		c, err := uiaCreatePropertyCondition(state.automation, UIA_AutomationIdPropertyId, automationId)
		if err == nil {
			conditions = append(conditions, c)
		}
	}
	if name != "" {
		c, err := uiaCreatePropertyCondition(state.automation, UIA_NamePropertyId, name)
		if err == nil {
			conditions = append(conditions, c)
		}
	}
	if className != "" {
		c, err := uiaCreatePropertyCondition(state.automation, UIA_ClassNamePropertyId, className)
		if err == nil {
			conditions = append(conditions, c)
		}
	}
	if controlType != "" {
		// Map control type name to ID
		ctrlId := controlTypeIdFromName(controlType)
		if ctrlId > 0 {
			c, err := uiaCreatePropertyCondition(state.automation, UIA_ControlTypePropertyId, ctrlId)
			if err == nil {
				conditions = append(conditions, c)
			}
		}
	}

	if len(conditions) == 0 {
		return nil, fmt.Errorf("at least one search criterion required: automation_id, name, class_name, or control_type")
	}

	// Combine conditions with AND
	var condition *ole.IDispatch
	if len(conditions) == 1 {
		condition = conditions[0]
		condition.AddRef() // prevent release in defer above
	} else {
		combined := conditions[0]
		combined.AddRef()
		for i := 1; i < len(conditions); i++ {
			next, err := uiaCreateAndCondition(state.automation, combined, conditions[i])
			if err != nil {
				combined.Release()
				return nil, err
			}
			combined.Release()
			combined = next
		}
		condition = combined
	}
	defer condition.Release()

	// Find all matching elements
	arr, err := uiaElementFindAll(window, TreeScope_Descendants, condition)
	if err != nil {
		return nil, err
	}
	if arr == nil {
		return map[string]any{"match_count": 0, "elements": []any{}}, nil
	}
	defer arr.Release()

	// Don't clear cache — allow mixing inspect + find results (matches C# behavior)
	var results []map[string]any
	length := uiaArrayLength(arr)
	for i := 0; i < length; i++ {
		elem := uiaArrayGetElement(arr, i)
		if elem != nil {
			id := state.cache.add(elem)
			results = append(results, buildElementInfo(elem, id, 0))
		}
	}

	return map[string]any{
		"match_count": len(results),
		"elements":    results,
	}, nil
}

// controlTypeIdFromName maps a human-readable control type name to its UIAutomation ID.
func controlTypeIdFromName(name string) int {
	for id, n := range controlTypeNames {
		if n == name {
			return id
		}
	}
	return 0
}

// ── Win32 helpers ────────────────────────────────────────────────────

var (
	user32                   = syscall.NewLazyDLL("user32.dll")
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGetForegroundWindow  = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcId = user32.NewProc("GetWindowThreadProcessId")
	procSetCursorPos         = user32.NewProc("SetCursorPos")
	procMouseEvent           = user32.NewProc("mouse_event")
	procSetForegroundWindow  = user32.NewProc("SetForegroundWindow")
	procShowWindow           = user32.NewProc("ShowWindow")
	procSleep                = kernel32.NewProc("Sleep")
)

func win32GetForegroundWindow() uintptr {
	hwnd, _, _ := procGetForegroundWindow.Call()
	return hwnd
}

func win32GetWindowPid(hwnd uintptr) uint32 {
	var pid uint32
	procGetWindowThreadProcId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid
}

const (
	MOUSEEVENTF_LEFTDOWN  = 0x0002
	MOUSEEVENTF_LEFTUP    = 0x0004
	MOUSEEVENTF_RIGHTDOWN = 0x0008
	MOUSEEVENTF_RIGHTUP   = 0x0010
)

func win32Click(x, y int) {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
	procSleep.Call(50)
	procMouseEvent.Call(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
	procMouseEvent.Call(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
}

func win32DoubleClick(x, y int) {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
	procSleep.Call(50)
	procMouseEvent.Call(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
	procMouseEvent.Call(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
	procSleep.Call(50)
	procMouseEvent.Call(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
	procMouseEvent.Call(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
}

func win32RightClick(x, y int) {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
	procSleep.Call(50)
	procMouseEvent.Call(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
	procMouseEvent.Call(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)
}
