//go:build windows

package main

// Windows notifications.
//
// Primary path: a real WinRT toast with inline action buttons (design §01,
// candor: Approve/Deny inline for ordinary external actions, "Review in Jarvis"
// only for destructive ones). Getting a button click back into the ALREADY-
// RUNNING sidecar without a COM activator is done by protocol activation:
//   - each button's `arguments` is a jarvis://n?id=..&kind=..&a=.. URI;
//   - clicking launches this exe with that URI (the jarvis:// scheme + the AUMID
//     are registered under HKCU at startup, which also lets an unpackaged app
//     raise toasts at all);
//   - that launched instance finds the running sidecar's hidden tray window and
//     forwards the URI via WM_COPYDATA, then exits (never booting a 2nd sidecar);
//   - the running instance parses it and emits notify.action to the brain.
// The toast XML is shown by a hidden PowerShell call (no WinRT COM bindings).
//
// Fallback: if the toast fails to launch, a tray balloon (Shell_NotifyIcon
// NIF_INFO) — buttonless, so a click only ever opens the app to review.

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

const (
	notifyAUMID         = "Jarvis.Sidecar" // app id toasts attribute to
	trayMsgShowBalloon  = 0x0400 + 3       // WM_APP+3: client goroutine → tray thread (balloon)
	trayWmCopyData      = 0x004A           // WM_COPYDATA (forwarder → running instance)
	ninBalloonUserClick = 0x0405           // user clicked the balloon body
	trayNifInfo         = 0x00000010       // NIF_INFO — this NIM_MODIFY carries a balloon
	trayNiifUser        = 0x00000004       // NIIF_USER — show our brand icon in the balloon
	notifyCopyDataMagic = 0x4A415256       // 'JARV' — tags our WM_COPYDATA so we ignore others
	quitCopyDataMagic   = 0x4A565154       // 'JVQT' — external graceful-quit request (installer/updater)
	// createNoWindow (CREATE_NO_WINDOW) is declared in subprocess_windows.go —
	// reused here to keep the PowerShell toast call headless.
)

var (
	procFindWindowW = pebbleUser32.NewProc("FindWindowW")
	procSetAUMID    = trayShell32.NewProc("SetCurrentProcessExplicitAppUserModelID")

	pendingNotifyMu sync.Mutex
	pendingNotify   Notification
)

type copyDataStruct struct {
	dwData uintptr
	cbData uint32
	lpData uintptr
}

func init() {
	showNotification = windowsShowNotification
	setupNotifications = windowsSetupNotifications
	maybeForwardProtocolLaunch = windowsForwardProtocolLaunch
}

// ── setup: AUMID + jarvis:// scheme (idempotent, every startup) ──────────────

func windowsSetupNotifications() {
	if aumid, err := syscall.UTF16PtrFromString(notifyAUMID); err == nil {
		procSetAUMID.Call(uintptr(unsafe.Pointer(aumid)))
	}
	exe, _ := os.Executable()

	// AUMID display identity — an unpackaged app needs this (or a Start-menu
	// shortcut) for its toasts to appear at all.
	regSetString(`Software\Classes\AppUserModelId\`+notifyAUMID, "DisplayName", "Jarvis")
	if exe != "" {
		regSetString(`Software\Classes\AppUserModelId\`+notifyAUMID, "IconUri", exe)
	}

	// jarvis:// URI scheme → this exe, so a toast button's protocol activation
	// launches us with the action URI.
	regSetString(`Software\Classes\jarvis`, "", "URL:Jarvis Protocol")
	regSetString(`Software\Classes\jarvis`, "URL Protocol", "")
	if exe != "" {
		regSetString(`Software\Classes\jarvis\shell\open\command`, "", `"`+exe+`" "%1"`)
	}
}

func regSetString(path, name, val string) {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		log.Printf("[notify] registry create %q: %v", path, err)
		return
	}
	defer k.Close()
	if err := k.SetStringValue(name, val); err != nil {
		log.Printf("[notify] registry set %q\\%q: %v", path, name, err)
	}
}

// ── forwarder: launched by a button click, forward to the running instance ───

func windowsForwardProtocolLaunch() bool {
	var uri string
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, "jarvis://") {
			uri = a
			break
		}
	}
	if uri == "" {
		return false
	}
	// Find the running sidecar's hidden tray window (registered class) and hand it
	// the URI via WM_COPYDATA. If there's no running instance, drop it silently —
	// there's nothing to approve against.
	if cls, err := syscall.UTF16PtrFromString("JarvisSidecarTray"); err == nil {
		hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), 0)
		if hwnd != 0 {
			b := append([]byte(uri), 0)
			cds := copyDataStruct{
				dwData: notifyCopyDataMagic,
				cbData: uint32(len(b)),
				lpData: uintptr(unsafe.Pointer(&b[0])),
			}
			procSendMessageW.Call(hwnd, trayWmCopyData, 0, uintptr(unsafe.Pointer(&cds)))
			runtime.KeepAlive(b) // lpData is a bare uintptr — keep the buffer live across the syscall
		}
	}
	return true
}

// onNotifyCopyData runs on the tray thread when the forwarder posts an action.
// It validates the tag, parses jarvis://n?id=..&kind=..&a=.., and dispatches.
func onNotifyCopyData(lParam uintptr) {
	cds := (*copyDataStruct)(unsafe.Pointer(lParam))
	if cds == nil || cds.dwData != notifyCopyDataMagic || cds.cbData == 0 || cds.lpData == 0 {
		return
	}
	raw := unsafe.Slice((*byte)(unsafe.Pointer(cds.lpData)), cds.cbData)
	uri := strings.TrimRight(string(raw), "\x00")
	handleNotifyURI(uri)
}

func handleNotifyURI(uri string) {
	q := uri
	if i := strings.Index(uri, "?"); i >= 0 {
		q = uri[i+1:]
	}
	vals, err := url.ParseQuery(q)
	if err != nil {
		return
	}
	action := vals.Get("a")
	if action == "" {
		return
	}
	// approve/deny act on the brain, and this entry point is world-invokable —
	// require the single-use nonce minted into this toast's buttons. Everything
	// else (review/view/reconnect/restart) only opens the app, so it stays open.
	// A failed check (expired toast from the Action Center, replay, re-minted
	// notification) must never approve — but the click still deserves a
	// response, so it degrades to review: the app opens and the user decides
	// there.
	if action == "approve" || action == "deny" {
		if !consumeNotifyNonce(vals.Get("id"), vals.Get("n")) {
			log.Printf("[notify] unauthenticated %q for %q — degrading to review", action, vals.Get("id"))
			action = "review"
		}
	}
	// Let the brain act on approve/deny; everything else (review/view/reconnect/
	// restart) opens the app. Emit for all so the brain can mark-seen.
	notifyEmitAction(vals.Get("id"), vals.Get("kind"), action)
	switch action {
	case "review", "view", "reconnect", "restart":
		if trayOpenChat != nil {
			go trayOpenChat()
		}
	}
}

// ── primary path: WinRT toast with buttons via hidden PowerShell ─────────────

func windowsShowNotification(n Notification) {
	// Fire the toast off the RPC-handler goroutine; on failure fall back to a
	// balloon so a broken toast path still notifies.
	go func() {
		if err := showToast(n); err != nil {
			log.Printf("[notify] toast failed, falling back to balloon: %v", err)
			pendingNotifyMu.Lock()
			pendingNotify = n
			pendingNotifyMu.Unlock()
			if h := trayHwnd.Load(); h != 0 {
				procPostMessageW.Call(h, trayMsgShowBalloon, 0, 0)
			}
		}
	}()
}

func notifyURI(id, kind, action, nonce string) string {
	u := "jarvis://n?id=" + url.QueryEscape(id) + "&kind=" + url.QueryEscape(kind) + "&a=" + url.QueryEscape(action)
	if nonce != "" {
		u += "&n=" + url.QueryEscape(nonce)
	}
	return u
}

func showToast(n Notification) error {
	body := n.Body
	if n.Meta != "" {
		body += " · " + n.Meta
	}

	nonce := mintNotifyNonce(n.ID)

	var acts strings.Builder
	for _, a := range n.Actions {
		fmt.Fprintf(&acts, `<action content="%s" activationType="protocol" arguments="%s"/>`,
			xmlEscape(a.Label), xmlEscape(notifyURI(n.ID, n.Kind, a.ID, nonce)))
	}

	// launch (body click) always reviews in-app — never an approve.
	xml := `<toast activationType="protocol" launch="` + xmlEscape(notifyURI(n.ID, n.Kind, "review", nonce)) + `">` +
		`<visual><binding template="ToastGeneric">` +
		`<text>` + xmlEscape(n.Title) + `</text>` +
		`<text>` + xmlEscape(body) + `</text>` +
		`</binding></visual>`
	if acts.Len() > 0 {
		xml += `<actions>` + acts.String() + `</actions>`
	}
	xml += `</toast>`

	// The XML is one line (no newlines / no '@ sequence), safe inside a literal
	// single-quoted here-string.
	script := `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]|Out-Null
$d=New-Object Windows.Data.Xml.Dom.XmlDocument
$d.LoadXml(@'
` + xml + `
'@)
$t=New-Object Windows.UI.Notifications.ToastNotification $d
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('` + notifyAUMID + `').Show($t)`

	// Bounded: a hung PowerShell would otherwise leak a goroutine + process per
	// notification and suppress the balloon fallback forever.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", psEncode(script))
	hideSubprocessWindow(cmd)
	return cmd.Run() // wait so a toast/AUMID failure surfaces for the balloon fallback
}

// psEncode encodes a script as UTF-16LE base64 for powershell -EncodedCommand,
// sidestepping all shell quoting of the XML.
func psEncode(s string) string {
	u := utf16.Encode([]rune(s))
	b := make([]byte, len(u)*2)
	for i, r := range u {
		b[i*2] = byte(r)
		b[i*2+1] = byte(r >> 8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func xmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return r.Replace(s)
}

// ── fallback: tray balloon (buttonless) ──────────────────────────────────────

// showBalloonNow raises the tray balloon. Tray thread only (owns trayNID). Uses
// a local copy so trayNID keeps its steady-state flags — a lingering NIF_INFO
// would re-fire the balloon on the next icon swap.
func showBalloonNow() {
	pendingNotifyMu.Lock()
	n := pendingNotify
	pendingNotifyMu.Unlock()
	if n.Title == "" && n.Body == "" {
		return
	}

	nid := trayNID // struct copy; SzInfo/SzInfoTitle start zeroed (never set on trayNID)
	nid.UFlags = trayNID.UFlags | trayNifInfo
	nid.DwInfoFlags = trayNiifUser

	body := n.Body
	if n.Meta != "" {
		body += " · " + n.Meta
	}
	body = truncateRunes(body, 200) // SzInfo is 256 wchars; leave headroom for the null

	if title, err := syscall.UTF16FromString(n.Title); err == nil {
		copy(nid.SzInfoTitle[:len(nid.SzInfoTitle)-1], title)
	}
	if info, err := syscall.UTF16FromString(body); err == nil {
		copy(nid.SzInfo[:len(nid.SzInfo)-1], info)
	}
	procShellNotifyIconW.Call(trayNimModify, uintptr(unsafe.Pointer(&nid)))
}

// onBalloonClick — a buttonless balloon click is never an approve; it always
// opens the app to review (the click-only-in-app rule).
func onBalloonClick() {
	pendingNotifyMu.Lock()
	n := pendingNotify
	pendingNotifyMu.Unlock()
	if trayOpenChat != nil {
		go trayOpenChat()
	}
	notifyEmitAction(n.ID, n.Kind, "review")
}

// truncateRunes caps s to at most max runes (so a multi-byte tail isn't split).
func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
