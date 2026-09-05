//go:build windows

package main

// Windows: route the panel webview's window.open / target=_blank to the system
// browser via WebView2's NewWindowRequested event (see panels_extnav.go for the
// why). We reach the ICoreWebView2 off the engine's controller — exposed by the
// vendored webview_go's BrowserController — and hand it a Go-implemented COM
// event handler, using the same vtable-slot machinery internal/winchrome uses
// for the accelerator-key setting, extended with one callback object.
//
// The handler is a single process-wide, stateless COM object: it only reads the
// requested URI and opens it, so AddRef/Release are inert and its vtable lives
// in package memory for the process lifetime (never freed, never moved). Its
// slots are syscall.NewCallback thunks, valid for the whole run.

import (
	"log"
	"syscall"
	"unsafe"

	webview "github.com/webview/webview_go"
	"golang.org/x/sys/windows"
)

// comObject is any COM interface pointer: its first word is the vtable. Typing
// callbacks and controllers as *comObject keeps the vtable lookups off
// uintptr→unsafe.Pointer conversions, so this file stays clean under
// `go vet -unsafeptr`.
type comObject struct {
	vtbl *[64]uintptr
}

// newWindowHandler is our ICoreWebView2NewWindowRequestedEventHandler: a vtable
// pointer and nothing else.
type newWindowHandlerVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	Invoke         uintptr
}

type newWindowHandler struct {
	lpVtbl *newWindowHandlerVtbl
}

var (
	nwHandler newWindowHandler // {&vtbl}; its address is passed to add_NewWindowRequested
	nwVtbl    newWindowHandlerVtbl
)

func init() {
	nwVtbl = newWindowHandlerVtbl{
		QueryInterface: syscall.NewCallback(nwQueryInterface),
		AddRef:         syscall.NewCallback(nwAddRef),
		Release:        syscall.NewCallback(nwRelease),
		Invoke:         syscall.NewCallback(nwInvoke),
	}
	nwHandler.lpVtbl = &nwVtbl
}

func guidEqual(a, b *comGUID) bool {
	return a.Data1 == b.Data1 && a.Data2 == b.Data2 && a.Data3 == b.Data3 && a.Data4 == b.Data4
}

// nwQueryInterface answers IUnknown and the handler's own IID with this same
// object; everything else is E_NOINTERFACE. AddRef is folded into the S_OK path.
func nwQueryInterface(this uintptr, riid *comGUID, ppv *uintptr) uintptr {
	if guidEqual(riid, &iidIUnknown) || guidEqual(riid, &iidNewWindowRequestedHandler) {
		*ppv = this
		return 0 // S_OK
	}
	*ppv = 0
	return 0x80004002 // E_NOINTERFACE
}

// Reference counting is inert: the object is a package global that outlives the
// engine, so a non-zero constant is a safe, standard answer for a singleton.
func nwAddRef(this uintptr) uintptr  { return 2 }
func nwRelease(this uintptr) uintptr { return 1 }

// nwInvoke fires when the page calls window.open / follows a target=_blank. We
// take the request over (put_Handled TRUE, so WebView2 opens no nested window)
// and send the URL to the system browser.
func nwInvoke(this uintptr, sender, args *comObject) uintptr {
	var uri *uint16
	hr, _, _ := syscall.SyscallN(
		args.vtbl[idxPanelNewWindowArgsGetUri],
		uintptr(unsafe.Pointer(args)),
		uintptr(unsafe.Pointer(&uri)),
	)
	if hr != 0 || uri == nil {
		// Couldn't read the URL (rare). Leave Handled FALSE so WebView2 falls
		// back to its default (a nested window) rather than swallowing the click
		// with nothing to open — best-effort, like the rest of this path.
		return 0 // S_OK
	}
	// put_Handled(TRUE): claim the request before opening, so a failure to
	// launch still can't leave WebView2 spawning its own nested window.
	syscall.SyscallN(
		args.vtbl[idxPanelNewWindowArgsPutHandled],
		uintptr(unsafe.Pointer(args)),
		1, // TRUE
	)
	url := windows.UTF16PtrToString(uri)
	windows.CoTaskMemFree(unsafe.Pointer(uri)) // get_Uri hands us an owned LPWSTR
	panelOpenExternal(url)
	return 0 // S_OK
}

// installPanelExternalNav registers the NewWindowRequested handler on the
// panel's WebView2. Best-effort: every failure leaves window.open behaving as
// before (a nested window) rather than breaking the panel.
func installPanelExternalNav(wv webview.WebView) {
	c := webview.BrowserController(wv)
	if c == nil {
		log.Printf("[panels] no browser controller; window.open will not route to the system browser")
		return
	}
	ctrl := (*comObject)(c)

	var core unsafe.Pointer
	hr, _, _ := syscall.SyscallN(
		ctrl.vtbl[idxPanelControllerGetCoreWebView2],
		uintptr(unsafe.Pointer(ctrl)),
		uintptr(unsafe.Pointer(&core)),
	)
	if hr != 0 || core == nil {
		log.Printf("[panels] get_CoreWebView2 failed (hr=%#x); window.open will not route to the system browser", hr)
		return
	}
	coreObj := (*comObject)(core)
	defer syscall.SyscallN(coreObj.vtbl[idxPanelIUnknownRelease], uintptr(unsafe.Pointer(coreObj)))

	var token int64 // EventRegistrationToken; never removed (panel-lifetime)
	hr, _, _ = syscall.SyscallN(
		coreObj.vtbl[idxPanelCoreWebView2AddNewWindowRequested],
		uintptr(unsafe.Pointer(coreObj)),
		uintptr(unsafe.Pointer(&nwHandler)),
		uintptr(unsafe.Pointer(&token)),
	)
	if hr != 0 {
		log.Printf("[panels] add_NewWindowRequested failed (hr=%#x)", hr)
	}
}
