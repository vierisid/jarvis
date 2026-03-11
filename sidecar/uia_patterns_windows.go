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

// patternInvoke calls IUIAutomationInvokePattern::Invoke.
func patternInvoke(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_InvokePatternId)
	if err != nil {
		return fmt.Errorf("element does not support Invoke pattern: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationInvokePattern::Invoke = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return fmt.Errorf("Invoke failed: HRESULT 0x%x", hr)
	}
	return nil
}

// patternGetValue calls IUIAutomationValuePattern::get_CurrentValue.
func patternGetValue(elem *ole.IDispatch) (string, error) {
	pattern, err := uiaElementGetPattern(elem, UIA_ValuePatternId)
	if err != nil {
		return "", fmt.Errorf("element does not support Value pattern: %w", err)
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
		return "", fmt.Errorf("get_CurrentValue failed: HRESULT 0x%x", hr)
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
		return fmt.Errorf("element does not support Value pattern: %w", err)
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
		return fmt.Errorf("SetValue failed: HRESULT 0x%x", hr)
	}
	return nil
}

// patternToggle calls IUIAutomationTogglePattern::Toggle.
func patternToggle(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_TogglePatternId)
	if err != nil {
		return fmt.Errorf("element does not support Toggle pattern: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationTogglePattern::Toggle = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return fmt.Errorf("Toggle failed: HRESULT 0x%x", hr)
	}
	return nil
}

// patternGetToggleState calls IUIAutomationTogglePattern::get_CurrentToggleState.
// Returns 0=Off, 1=On, 2=Indeterminate.
func patternGetToggleState(elem *ole.IDispatch) (int, error) {
	pattern, err := uiaElementGetPattern(elem, UIA_TogglePatternId)
	if err != nil {
		return 0, fmt.Errorf("element does not support Toggle pattern: %w", err)
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
		return 0, fmt.Errorf("get_CurrentToggleState failed: HRESULT 0x%x", hr)
	}
	return int(state), nil
}

// patternExpand calls IUIAutomationExpandCollapsePattern::Expand.
func patternExpand(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_ExpandCollapsePatternId)
	if err != nil {
		return fmt.Errorf("element does not support ExpandCollapse pattern: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationExpandCollapsePattern::Expand = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return fmt.Errorf("Expand failed: HRESULT 0x%x", hr)
	}
	return nil
}

// patternCollapse calls IUIAutomationExpandCollapsePattern::Collapse.
func patternCollapse(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_ExpandCollapsePatternId)
	if err != nil {
		return fmt.Errorf("element does not support ExpandCollapse pattern: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationExpandCollapsePattern::Collapse = IUnknown(3) + offset 1 = vtable[4]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 4),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return fmt.Errorf("Collapse failed: HRESULT 0x%x", hr)
	}
	return nil
}

// patternSelectItem calls IUIAutomationSelectionItemPattern::Select.
func patternSelectItem(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_SelectionItemPatternId)
	if err != nil {
		return fmt.Errorf("element does not support SelectionItem pattern: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationSelectionItemPattern::Select = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return fmt.Errorf("Select failed: HRESULT 0x%x", hr)
	}
	return nil
}

// patternScrollIntoView calls IUIAutomationScrollItemPattern::ScrollIntoView.
func patternScrollIntoView(elem *ole.IDispatch) error {
	pattern, err := uiaElementGetPattern(elem, UIA_ScrollItemPatternId)
	if err != nil {
		return fmt.Errorf("element does not support ScrollItem pattern: %w", err)
	}
	defer pattern.Release()

	// IUIAutomationScrollItemPattern::ScrollIntoView = IUnknown(3) + offset 0 = vtable[3]
	hr, _, _ := syscall.SyscallN(
		vtblOffset(pattern, 3),
		uintptr(unsafe.Pointer(pattern)),
	)
	if hr != 0 {
		return fmt.Errorf("ScrollIntoView failed: HRESULT 0x%x", hr)
	}
	return nil
}
