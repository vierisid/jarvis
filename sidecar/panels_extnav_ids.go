package main

// WebView2 COM identifiers for routing panel new-window requests to the system
// browser (panels_extnav_windows.go). In a file with NO build tag, like
// winchrome's webview2_ids.go: the values are ABI facts about Microsoft's SDK
// header, so keeping them tag-free lets panels_extnav_ids_test.go re-derive
// them from the vendored WebView2.h on any host — a mistyped slot would call
// through the wrong vtable entry on a user's machine, and no Windows-only test
// could catch it here.

// comGUID mirrors Win32 GUID (and REFIID): a DWORD, two WORDs, then 8 bytes.
type comGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// iidNewWindowRequestedHandler is IID_ICoreWebView2NewWindowRequestedEventHandler
// — the interface our Go callback object claims to implement, so WebView2's
// QueryInterface for it succeeds.
var iidNewWindowRequestedHandler = comGUID{
	0xd4c185fe, 0xc81c, 0x4989,
	[8]byte{0x97, 0xaf, 0x2d, 0x3f, 0xa7, 0xab, 0x56, 0x51},
}

// iidIUnknown is IID_IUnknown, the other GUID QueryInterface must answer.
var iidIUnknown = comGUID{
	0x00000000, 0x0000, 0x0000,
	[8]byte{0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46},
}

// Vtable slots, counted from the C-style `…Vtbl` structs in the vendored
// libs/mswebview2/include/WebView2.h. Slots 0,1,2 are IUnknown's
// QueryInterface/AddRef/Release on every COM interface; the rest are that
// offset plus the interface's own declaration order. panels_extnav_ids_test.go
// parses those structs and fails if any drifts (including after an SDK header
// bump that inserts a method).
const (
	idxPanelIUnknownRelease = 2

	// ICoreWebView2ControllerVtbl
	idxPanelControllerGetCoreWebView2 = 25

	// ICoreWebView2Vtbl
	idxPanelCoreWebView2AddNewWindowRequested = 44

	// ICoreWebView2NewWindowRequestedEventArgsVtbl
	idxPanelNewWindowArgsGetUri     = 3
	idxPanelNewWindowArgsPutHandled = 6
)
