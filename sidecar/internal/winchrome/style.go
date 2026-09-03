// Package winchrome replaces a webview window's native Windows title bar with
// one the page draws itself, without giving up the behaviours a real window
// has: resize borders, Aero Snap, native maximize, minimize/restore
// animations, the Alt+Space system menu and the taskbar entry.
//
// The trick is to remove ONLY WS_CAPTION. The window keeps its overlapped
// frame, so Windows keeps computing the non-client area, the maximized rect
// and the snap behaviour exactly as it does for any other app — we never
// touch WM_NCCALCSIZE and never subclass the window procedure the vendored
// webview owns. What is left of the frame is the 1px system border.
//
// The page drives the window through four bindings (see Install); the caption
// drag is the ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION handshake, because
// the WebView2 child HWND covers the client area and swallows the mouse
// before any hit-test of ours could see it (CSS app-region is an Electron
// feature; stock WebView2 does not honour it).
//
// Known limitation: the Win11 Snap Layouts flyout does not appear when
// hovering the page's maximize button. The OS offers it only to a window whose
// WM_NCHITTEST answers HTMAXBUTTON, which needs the window procedure we
// deliberately do not own. Win+Z and edge-snap are unaffected.
//
// On every non-Windows platform Install is a no-op that reports false, so the
// shared page markup keeps its native title bar there.
package winchrome

import "strconv"

// TitleBar says which title bar a window wears. It exists so the choice reads
// as itself at a call site — `winchrome.CustomTitleBar` rather than a bare
// `true` six arguments deep — because the choice carries a security
// invariant: custom chrome binds window controls into the document, so only a
// window showing LOCAL html may ask for it. It also makes "which windows have
// chrome bindings?" a one-line grep.
type TitleBar bool

const (
	NativeTitleBar TitleBar = false
	CustomTitleBar TitleBar = true
)

// Win32 window styles. Duplicated here rather than imported from the sidecar's
// panels_windows.go so this package stays self-contained (the installer binary
// links it too, and the values are ABI constants that cannot drift).
const (
	wsCaption     = 0x00C00000 // WS_BORDER | WS_DLGFRAME — the title bar
	wsThickFrame  = 0x00040000 // sizing border: resize + Aero Snap eligibility
	wsSysMenu     = 0x00080000 // Alt+Space menu, taskbar close entry
	wsMinimizeBox = 0x00020000
	wsMaximizeBox = 0x00010000
)

// captionlessStyle is the WS_* mask for a window that draws its own title bar.
//
// Dropping WS_CAPTION is what hides the native bar. The two styles added back
// are invisible without a caption but are what Windows consults for behaviour:
// WS_SYSMENU for Alt+Space and the taskbar context menu, WS_MINIMIZEBOX so
// ShowWindow(SW_MINIMIZE) and the taskbar minimise as they would for a framed
// window. Keeping the overlapped frame (i.e. NOT switching to WS_POPUP) is
// deliberate: a maximized WS_POPUP covers the taskbar and needs a
// WM_GETMINMAXINFO handler — and a handler means a window procedure.
//
// WS_THICKFRAME (resize border, and with it Aero Snap eligibility) and
// WS_MAXIMIZEBOX are deliberately NOT forced on: webview's own SetSize sets
// them for WEBVIEW_HINT_NONE and strips them for WEBVIEW_HINT_FIXED, so
// preserving whatever is there keeps a fixed-size window fixed instead of
// silently handing it a resize border. A page that draws a maximize button on
// a window whose caller asked for HintFixed gets a button the OS refuses --
// which is the caller's contradiction to resolve, not this mask's.
//
// Pure so it can be unit-tested on any host.
func captionlessStyle(style uint32) uint32 {
	style &^= wsCaption
	style |= wsSysMenu | wsMinimizeBox
	return style
}

// captionedStyle is the inverse of captionlessStyle: it puts WS_CAPTION back.
//
// It does NOT take WS_SYSMENU and WS_MINIMIZEBOX away again. Those are not
// ours to remove — captionlessStyle adds them because a captionless window
// needs them to behave, and a framed window wants them just as much. So the
// pair round-trips for any window webview actually creates (WS_SYSMENU and
// WS_MINIMIZEBOX are in WS_OVERLAPPEDWINDOW, and SetSize's HintFixed strips
// neither), which is what the round-trip test pins.
//
// Pure, so it can be unit-tested on any host.
func captionedStyle(style uint32) uint32 {
	return style | wsCaption
}

// initJS marks the document as custom-chromed so the shared title bar CSS
// (internal/brand) can reveal itself only where the native bar is gone, and
// hands the page the user's real double-click speed: the strip times
// double-clicks itself (the native move loop owns the mouse, so no dblclick
// event is guaranteed), and a user who has slowed the setting down in
// accessibility settings would otherwise never manage one.
//
// It runs at document-creation time, before any page markup exists, so it
// cannot assume document.documentElement is there yet: it stamps the attribute
// immediately when it can and again on DOMContentLoaded, both idempotent. No
// visible flash either way — the window stays hidden until the reveal hook
// fires on load (internal/webviewui.RevealOnLoad).
// It also refuses navigating drops. Dropping a URL or a file onto a WebView2
// document navigates it by default, and the window's bindings — these window
// controls, and whatever else the page's host bound — survive into whatever
// lands there, since bind() re-injects its stubs on every document. Cancelling
// the drag lets Chromium's default never run. Scoped to drags that actually
// carry a URL or a file: a plain-text drag into the token form's textarea is
// a different, harmless payload, and stays working.
//
// This is a guard for the windows that took on window-control bindings, not a
// complete answer — the real fix is refusing foreign origins in the engine
// (NavigationStarting, or AllowExternalDrop=false), which means a change to
// the vendored webview and its patch file.
//
// Finally it keeps the WINDOW'S CAPTION IN SYNC WITH THE DOCUMENT, which is
// what stops a reload from trapping the window. Reloading a document loaded
// with SetHtml lands on about:blank: no strip, and — since the caption was
// removed once at Install time — no way to move or close the window either.
// So every document reports whether our strip is in it, and the host puts the
// native caption back when it is not (syncCaption). Three details are load
// bearing:
//
//   - It asks for '#wchrome', not for location. A NavigateToString document
//     ALREADY reports about:blank as its URI, identical to the blank one a
//     reload leaves behind, so the URL cannot tell the two apart. The strip
//     is the only honest discriminator.
//   - It waits for DOMContentLoaded. The strip is the last element in <body>
//     (internal/brand's markup contract), so at document-creation time — when
//     this script runs — it does not exist yet. Waiting for `load` instead
//     would hang on a page with a stalled subresource, which is the same
//     reason webviewui.RevealOnLoad carries a timeout. Deferring is also what
//     guarantees the binding stub is there: bind() registers each stub as its
//     own document-created script, and WebView2 does not promise those run in
//     registration order.
//   - Top frame only. init_impl is AddScriptToExecuteOnDocumentCreated, which
//     WebView2 injects into EVERY frame. No chromed page has an iframe today,
//     but the day one does, a subframe with no strip of its own would
//     otherwise tell the host to un-chrome a perfectly good window.
//
// It is a two-way sync rather than a one-way restore on purpose. The first-run
// window swaps documents from a goroutine (hosted_window.go's showShellError /
// showSelfHostHint), so a reload mid-handshake is followed by a fresh chromed
// document — and a host that only ever restored would leave that window
// wearing two title bars. Syncing both ways is also idempotent, so a second
// reload of an already-blank document changes nothing.
func initJS(dblClickMs uint32) string {
	if dblClickMs == 0 {
		dblClickMs = 500 // the Windows default, if the OS would not say
	}
	return `(function(){try{` +
		`window.__jarvisCustomChrome=true;` +
		`window.__jarvisDblClickMs=` + strconv.FormatUint(uint64(dblClickMs), 10) + `;` +
		`var a=function(){if(document.documentElement)document.documentElement.setAttribute('data-chrome','custom');};` +
		`a();document.addEventListener('DOMContentLoaded',a);` +
		`var navigating=function(e){var t=e.dataTransfer&&e.dataTransfer.types;if(!t)return false;` +
		`for(var i=0;i<t.length;i++){if(t[i]==='Files'||t[i]==='text/uri-list')return true;}return false;};` +
		`var block=function(e){if(navigating(e)){e.preventDefault();}};` +
		`document.addEventListener('dragover',block,true);document.addEventListener('drop',block,true);` +
		`if(window.top===window){var done=false,tries=0;` +
		`var chk=function(){if(done)return;` +
		`if(!window.__jarvis_chrome_sync){if(tries++<20)setTimeout(chk,0);return;}` +
		`done=true;try{window.__jarvis_chrome_sync(!!document.getElementById('wchrome'));}catch(e){}};` +
		`if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',chk);}` +
		`else{setTimeout(chk,0);}}` +
		`}catch(e){}})();`
}
