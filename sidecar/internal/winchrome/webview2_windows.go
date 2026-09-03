//go:build windows

package winchrome

import (
	"log"
	"syscall"
	"unsafe"

	webview "github.com/webview/webview_go"
)

// vtblSlot returns the address of a COM object's nth vtable entry.
//
// Pointer arithmetic only, and no uintptr round trip: obj is an interface
// pointer whose first word is the vtable, and what comes back is a code
// address, never a Go pointer. Keeping it that way is what lets the callers
// stay clean under `go vet -unsafeptr`.
func vtblSlot(obj unsafe.Pointer, i int) uintptr {
	return (*(**[64]uintptr)(obj))[i]
}

// release drops a reference taken by a propget or a QueryInterface.
func release(obj unsafe.Pointer) {
	if obj == nil {
		return
	}
	syscall.SyscallN(vtblSlot(obj, idxIUnknownRelease), uintptr(obj))
}

// disableBrowserAccelerators turns off WebView2's browser accelerator keys for
// this one window, which is what stops F5 and Ctrl+R from reloading a document
// that was loaded with SetHtml — a reload of one of those lands on about:blank
// and leaves a custom-chromed window with no page and, until syncCaption
// notices, no title bar.
//
// Scoped to the window rather than set globally in the engine on purpose: the
// dashboard panels and the account window show remote pages at real URLs where
// reload works and is wanted, and the panels are frameless WS_POPUP windows
// that syncCaption never touches.
//
// Failure is never fatal. Every step logs and returns, leaving the window with
// working accelerators — the caption sync is still there to catch the reload.
//
// Threading: bindings and Install both run on the OS thread that created the
// engine (every host calls runtime.LockOSThread before webview.New), which is
// the STA WebView2 lives on, so there is no Dispatch hop and no CoInitialize
// to do here.
func disableBrowserAccelerators(w webview.WebView) {
	ctrl := webview.BrowserController(w)
	if ctrl == nil {
		log.Printf("[chrome] no browser controller; leaving the browser accelerator keys on")
		return
	}

	// Each call below is written inline rather than through a shared helper.
	// syscall.SyscallN carries //go:uintptrkeepalive, which only covers
	// uintptr(unsafe.Pointer(x)) conversions written directly in the call's
	// own argument list; routing the out-params through a variadic helper
	// would drop both that guarantee and the protection against the stack
	// moving under them.

	var core unsafe.Pointer
	hr, _, _ := syscall.SyscallN(
		vtblSlot(ctrl, idxControllerGetCoreWebView2),
		uintptr(ctrl),
		uintptr(unsafe.Pointer(&core)),
	)
	// Both checks, every time: a NULL out-param behind an S_OK would be
	// dereferenced as a vtable, and that is an access violation no recover()
	// can catch.
	if hr != 0 || core == nil {
		log.Printf("[chrome] get_CoreWebView2 failed (hr=%#x); leaving the browser accelerator keys on", hr)
		return
	}
	defer release(core)

	var settings unsafe.Pointer
	hr, _, _ = syscall.SyscallN(
		vtblSlot(core, idxCoreWebView2GetSettings),
		uintptr(core),
		uintptr(unsafe.Pointer(&settings)),
	)
	if hr != 0 || settings == nil {
		log.Printf("[chrome] get_Settings failed (hr=%#x); leaving the browser accelerator keys on", hr)
		return
	}
	defer release(settings)

	// ICoreWebView2Settings3 arrived in runtime 1.0.864.35. An older
	// fixed-version runtime answers E_NOINTERFACE, which is a clean no.
	var settings3 unsafe.Pointer
	hr, _, _ = syscall.SyscallN(
		vtblSlot(settings, 0), // IUnknown::QueryInterface
		uintptr(settings),
		uintptr(unsafe.Pointer(&iidCoreWebView2Settings3)),
		uintptr(unsafe.Pointer(&settings3)),
	)
	if hr != 0 || settings3 == nil {
		log.Printf("[chrome] this WebView2 runtime has no ICoreWebView2Settings3 (hr=%#x); leaving the browser accelerator keys on", hr)
		return
	}
	defer release(settings3)

	hr, _, _ = syscall.SyscallN(
		vtblSlot(settings3, idxSettings3PutBrowserAcceleratorKeys),
		uintptr(settings3),
		0, // FALSE
	)
	if hr != 0 {
		log.Printf("[chrome] could not disable the browser accelerator keys (hr=%#x)", hr)
	}
}
