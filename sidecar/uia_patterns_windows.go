//go:build windows

// uia_patterns_windows.go — UIAutomation pattern wrappers.
//
// Each function acquires the pattern interface from an element, calls
// the desired method, and releases the pattern. These match the actions
// the previous bridge implementation supported.

package main

import (
	"fmt"
	"syscall"
	"unsafe"

	"github.com/go-ole/go-ole"
)

// uiaOpError converts a failed UIA call into an error the model can act on.
// Raw HRESULTs ("Invoke failed: HRESULT 0x80004005") gave the LLM nothing to
// correct with; these map the common failures to concrete next steps.
func uiaOpError(op string, hr uintptr) error {
	return fmt.Errorf("%s failed: %s", op, hresultText(hr))
}

func hresultText(hr uintptr) string {
	switch uint32(hr) {
	case 0x80040201: // UIA_E_ELEMENTNOTAVAILABLE
		return "the element no longer exists — the UI changed or the window closed since the last snapshot; take a fresh desktop_snapshot and use a new element id"
	case 0x80040200: // UIA_E_ELEMENTNOTENABLED
		return "the element is disabled and cannot be interacted with right now — something in the app must enable it first"
	case 0x80040202: // UIA_E_NOCLICKABLEPOINT
		return "the element has no clickable point — it is offscreen or covered by another element; try action=scroll_into_view first"
	case 0x80070005: // E_ACCESSDENIED
		return "access denied — the target app likely runs elevated (as administrator) while the sidecar does not; Windows blocks UI automation across that boundary"
	case 0x80004005: // E_FAIL
		return "the control rejected the action — it may be busy, mid-update, or not truly support this operation; take a fresh desktop_snapshot and retry once"
	default:
		return fmt.Sprintf("HRESULT 0x%08x — take a fresh desktop_snapshot and retry once; if it persists the control does not support this action", uint32(hr))
	}
}

// patternInvoke calls IUIAutomationInvokePattern::Invoke.
func patternInvoke(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_InvokePatternId)
	if err != nil {
		return fmt.Errorf("element does not support the Invoke action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationInvokePattern::Invoke = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return uiaOpError("Invoke", hr)
	}
	return nil
}

// patternGetValue calls IUIAutomationValuePattern::get_CurrentValue.
func patternGetValue(elem *ole.IDispatch) (string, error) {
	pattern, err := uiaElementGetPattern(elem, UIA_ValuePatternId)
	if err != nil {
		return "", fmt.Errorf("element does not support the Value action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	var bstr *int16
	// IUIAutomationValuePattern::get_CurrentValue = IUnknown(3) + offset 1 = vtable[4]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 4),
		uintptr(unsafe.Pointer(pattern)),
		uintptr(unsafe.Pointer(&bstr)),
	)
	if hr != 0 {
		return "", uiaOpError("get_CurrentValue", hr)
	}
	if bstr == nil {
		return "", nil
	}
	val := ole.BstrToString((*uint16)(unsafe.Pointer(bstr)))
	ole.SysFreeString(bstr)
	return val, nil
}

// patternSetValue calls IUIAutomationValuePattern::SetValue.
func patternSetValue(elem *ole.IDispatch, value string) error {
	pattern, err := uiaElementGetPattern(elem, UIA_ValuePatternId)
	if err != nil {
		return fmt.Errorf("element does not support the Value action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	bstr := ole.SysAllocStringLen(value)
	defer ole.SysFreeString(bstr)

	// IUIAutomationValuePattern::SetValue = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
		uintptr(unsafe.Pointer(bstr)),
	)
	if hr != 0 {
		return uiaOpError("SetValue", hr)
	}
	return nil
}

// patternToggle calls IUIAutomationTogglePattern::Toggle.
func patternToggle(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_TogglePatternId)
	if err != nil {
		return fmt.Errorf("element does not support the Toggle action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationTogglePattern::Toggle = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return uiaOpError("Toggle", hr)
	}
	return nil
}

// patternGetToggleState calls IUIAutomationTogglePattern::get_CurrentToggleState.
// Returns 0=Off, 1=On, 2=Indeterminate.
func patternGetToggleState(elem *ole.IDispatch) (int, error) {
	pattern, err := uiaElementGetPattern(elem, UIA_TogglePatternId)
	if err != nil {
		return 0, fmt.Errorf("element does not support the Toggle action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	var state int32
	// IUIAutomationTogglePattern::get_CurrentToggleState = IUnknown(3) + offset 1 = vtable[4]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 4),
		uintptr(unsafe.Pointer(pattern)),
		uintptr(unsafe.Pointer(&state)),
	)
	if hr != 0 {
		return 0, uiaOpError("get_CurrentToggleState", hr)
	}
	return int(state), nil
}

// patternExpand calls IUIAutomationExpandCollapsePattern::Expand.
func patternExpand(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_ExpandCollapsePatternId)
	if err != nil {
		return fmt.Errorf("element does not support the ExpandCollapse action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationExpandCollapsePattern::Expand = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return uiaOpError("Expand", hr)
	}
	return nil
}

// patternCollapse calls IUIAutomationExpandCollapsePattern::Collapse.
func patternCollapse(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_ExpandCollapsePatternId)
	if err != nil {
		return fmt.Errorf("element does not support the ExpandCollapse action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationExpandCollapsePattern::Collapse = IUnknown(3) + offset 1 = vtable[4]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 4),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return uiaOpError("Collapse", hr)
	}
	return nil
}

// patternSelectItem calls IUIAutomationSelectionItemPattern::Select.
func patternSelectItem(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_SelectionItemPatternId)
	if err != nil {
		return fmt.Errorf("element does not support the SelectionItem action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationSelectionItemPattern::Select = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return uiaOpError("Select", hr)
	}
	return nil
}

// patternScrollIntoView calls IUIAutomationScrollItemPattern::ScrollIntoView.
func patternScrollIntoView(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_ScrollItemPatternId)
	if err != nil {
		return fmt.Errorf("element does not support the ScrollItem action — run desktop_snapshot and check the element's listed patterns/actions before retrying: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationScrollItemPattern::ScrollIntoView = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return uiaOpError("ScrollIntoView", hr)
	}
	return nil
}
