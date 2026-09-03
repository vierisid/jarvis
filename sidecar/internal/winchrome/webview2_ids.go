package winchrome

// COM identifiers for the one WebView2 setting this package changes.
//
// Deliberately in a file with NO build tag. The values are ABI facts about
// Microsoft's SDK header, not Windows code, so keeping them here lets
// webview2_ids_test.go re-derive them from the vendored WebView2.h on any
// host — which is the only thing standing between a mistyped hex digit and a
// call through the wrong vtable slot on a user's machine.

// guid mirrors Win32 GUID (and REFIID): a DWORD, two WORDs, then 8 bytes.
type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// iidCoreWebView2Settings3 is IID_ICoreWebView2Settings3, the lowest settings
// interface carrying AreBrowserAcceleratorKeysEnabled. Later revisions
// (Settings4 and up) all derive from it, so this is the one to ask for: it is
// the most widely available runtime that can answer.
var iidCoreWebView2Settings3 = guid{
	0xfdb5ab74, 0xaf33, 0x4854,
	[8]byte{0x84, 0xf0, 0x0a, 0x63, 0x1d, 0xeb, 0x5e, 0xba},
}

// Vtable slots, counted from the C-style `…Vtbl` structs in the vendored
// libs/mswebview2/include/WebView2.h. Slots 0, 1 and 2 are IUnknown's
// QueryInterface, AddRef and Release on every COM interface; everything below
// is that offset plus the interface's own declaration order, inherited
// methods first.
//
// webview2_ids_test.go parses those structs and fails if any of these drifts —
// including after an SDK header bump that inserts a method.
const (
	idxIUnknownRelease = 2

	// ICoreWebView2ControllerVtbl
	idxControllerGetCoreWebView2 = 25

	// ICoreWebView2Vtbl
	idxCoreWebView2GetSettings = 3

	// ICoreWebView2Settings3Vtbl
	idxSettings3PutBrowserAcceleratorKeys = 24
)
