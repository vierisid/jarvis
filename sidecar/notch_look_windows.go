//go:build windows

package main

import (
	"fmt"
	"log"
	"math"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	ole "github.com/go-ole/go-ole"
)

// The look on Windows: the watch on the pointer, the ink, and the reading.
//
// The pointer is watched with a low-level mouse hook, and only while the talk
// pair is down, a line is being drawn, or a click on a thing that was pointed
// at is waited for (that one is only seen, never kept): at every other time
// there is no hook and nothing of this program stands between the mouse and
// the apps. The hook
// is built like the keyboard's (notch_keys_windows.go): a thread of its own,
// every function resolved before it goes in, and a callback that only asks the
// pen. A click a program sent is not a click a person made, and is never
// taken.
//
// The ink is a window over the display the line was begun on. It takes no
// click and no hit test (a click goes through it, and so does every question
// about what is at a place), it never has the keyboard, and it dims nothing:
// every pixel the marker has not touched is clear. This process is aware of
// each display's own scale, so the pointer's place, the window and the
// elements' places are all in the same real pixels at any scale and on any
// display.
//
// The reading asks the apps for their own description of themselves (UI
// Automation), on the thread that program-wide owns it.

const (
	notchWhMouseLL       = 14
	notchWmMouseMove     = 0x0200
	notchWmLButtonDown   = 0x0201
	notchWmLButtonUp     = 0x0202
	notchWmRButtonUp     = 0x0205
	notchLlmhfInjected   = 0x00000001
	notchLookWmSync      = 0x8000 + 0x61 // WM_APP + 0x61: look again at whether to watch
	notchLookSrcCopy     = 0x00CC0020
	notchLookCaptureBlt  = 0x40000000
	uiaLocalizedTypeID   = 30004
	uiaValueValueID      = 30045
	notchLookTagFontPx   = 13
	notchLookTagPadX     = 10
	notchLookTagPadY     = 6
	notchLookTagRadius   = 9
	notchLookTagGap      = 10
	notchLookTagMaxWidth = 460
)

var (
	procLookUpdateLayeredIndirect = pebbleUser32.NewProc("UpdateLayeredWindowIndirect")
	procLookGetDpiForMonitor      = syscall.NewLazyDLL("shcore.dll").NewProc("GetDpiForMonitor")
	procLookBitBlt                = pebbleGdi32.NewProc("BitBlt")
)

// One callback for the life of the process, pointed at the look of the moment.
var (
	notchLookHookOnce sync.Once
	notchLookHookProc uintptr
	notchLookNow      atomic.Pointer[NotchLook]
)

func notchLookHook(nCode int32, wParam uintptr, lParam uintptr) uintptr {
	if nCode == 0 && (wParam == notchWmMouseMove || wParam == notchWmLButtonDown || wParam == notchWmLButtonUp || wParam == notchWmRButtonUp) {
		if l := notchLookNow.Load(); l != nil {
			// The documented exception to vet's unsafe.Pointer rule: lParam IS
			// a pointer, handed over by Windows for the length of this call.
			ev := (*msllHookStruct)(unsafe.Pointer(lParam))
			if ev.Flags&notchLlmhfInjected == 0 {
				x, y := int(ev.Pt.X), int(ev.Pt.Y)
				switch wParam {
				case notchWmMouseMove:
					l.Move(x, y)
				case notchWmLButtonDown:
					if l.Down(x, y) {
						return 1
					}
				case notchWmLButtonUp:
					if l.Up(x, y) {
						return 1
					}
					// A click that is the app's own: seen, when one is waited
					// for (something was pointed at), and never kept.
					l.Clicked(x, y)
				case notchWmRButtonUp:
					l.Clicked(x, y)
				}
			}
		}
	}
	ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
	return ret
}

// lookWindows is the look's hands on Windows.
type lookWindows struct {
	look *NotchLook
	// The thread that owns the hook, to post "look again" to.
	hookThread atomic.Uint32
	ink        chan lookInkCmd
}

// platformNotchLookHands starts the two threads the look needs and gives back
// its hands. Nil when the look cannot work here.
func platformNotchLookHands(l *NotchLook) lookHands {
	for _, p := range []*syscall.LazyProc{procCallNextHookEx, procSetWindowsHookExW, procUnhookWindowsHookEx} {
		if err := p.Find(); err != nil {
			log.Printf("[notch] look: not available: %v", err)
			return nil
		}
	}
	notchLookHookOnce.Do(func() { notchLookHookProc = syscall.NewCallback(notchLookHook) })
	w := &lookWindows{look: l, ink: make(chan lookInkCmd, 1024)}
	ready := make(chan uint32, 1)
	go w.watchThread(ready)
	w.hookThread.Store(<-ready)
	go w.inkThread()
	return w
}

// watchThread owns the hook: it puts it in when the look wants the pointer
// and takes it out when it does not.
func (w *lookWindows) watchThread(ready chan<- uint32) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tid, _, _ := procGetCurrentThread.Call()
	hMod, _, _ := procGetModuleHandleW.Call(0)
	// A first PeekMessage makes this thread's message queue, so that a post
	// sent the moment the thread id is known is not lost.
	var first w32Msg
	procPeekMessageW.Call(uintptr(unsafe.Pointer(&first)), 0, 0, 0, 0)
	ready <- uint32(tid)
	var hook uintptr
	for {
		var msg w32Msg
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if r == 0 || int32(r) == -1 {
			break
		}
		if msg.Message != notchLookWmSync {
			continue
		}
		want := w.look.Wants()
		switch {
		case want && hook == 0:
			h, _, callErr := procSetWindowsHookExW.Call(uintptr(notchWhMouseLL), notchLookHookProc, hMod, 0)
			if h == 0 {
				log.Printf("[notch] look: the pointer could not be watched: %v", callErr)
				continue
			}
			notchLookNow.Store(w.look)
			hook = h
		case !want && hook != 0:
			procUnhookWindowsHookEx.Call(hook)
			notchLookNow.Store(nil)
			hook = 0
		}
	}
	if hook != 0 {
		procUnhookWindowsHookEx.Call(hook)
		notchLookNow.Store(nil)
	}
}

func (w *lookWindows) Watch() {
	if tid := w.hookThread.Load(); tid != 0 {
		procPostThreadMsg.Call(uintptr(tid), notchLookWmSync, 0, 0)
	}
}

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

func (w *lookWindows) Screen(at lookPoint) (lookRect, float64) {
	mon, ok := monitorRectFromPoint(at.X, at.Y)
	if !ok {
		cx, _, _ := procGetSystemMetrics.Call(0)
		cy, _, _ := procGetSystemMetrics.Call(1)
		return lookRect{0, 0, int(int32(cx)), int(int32(cy))}, 1
	}
	screen := lookRect{mon.Left, mon.Top, mon.Right - mon.Left, mon.Bottom - mon.Top}
	scale := 1.0
	if procLookGetDpiForMonitor.Find() == nil {
		const monitorDefaultToNearest = 2
		packed := uintptr(uint32(int32(at.X))) | (uintptr(uint32(int32(at.Y))) << 32)
		if hMon, _, _ := procMonitorFromPoint.Call(packed, monitorDefaultToNearest); hMon != 0 {
			var dpiX, dpiY uint32
			// 0: the scale the person set for that display.
			if hr, _, _ := procLookGetDpiForMonitor.Call(hMon, 0, uintptr(unsafe.Pointer(&dpiX)), uintptr(unsafe.Pointer(&dpiY))); hr == 0 && dpiX >= 96 {
				scale = float64(dpiX) / 96
			}
		}
	}
	return screen, scale
}

func (w *lookWindows) Own(at lookPoint) bool {
	return ownWindow(win32RootWindow(win32WindowFromPoint(at.X, at.Y)))
}

func (w *lookWindows) Front(at lookPoint) (app, title string) {
	hwnd := win32RootWindow(win32WindowFromPoint(at.X, at.Y))
	if hwnd == 0 {
		return "", ""
	}
	return notchAppKey(processBaseName(win32GetWindowPid(hwnd))), win32WindowTitle(hwnd)
}

func (w *lookWindows) WindowRect(at lookPoint) lookRect {
	hwnd := win32RootWindow(win32WindowFromPoint(at.X, at.Y))
	if hwnd == 0 || ownWindow(hwnd) {
		return lookRect{}
	}
	var rc w32Rect
	if ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rc))); ok == 0 {
		return lookRect{}
	}
	return lookRect{int(rc.Left), int(rc.Top), int(rc.Right - rc.Left), int(rc.Bottom - rc.Top)}
}

// Around reads the names of what stands round a place: from the element
// there up through what holds it, as far as the window.
func (w *lookWindows) Around(at lookPoint) []string {
	result, err := comThread.call(func(state *uiaState) (any, error) {
		walker, err := uiaRawViewWalker(state.automation)
		if err != nil {
			return nil, err
		}
		defer walker.Release()
		elem, err := uiaElementFromPoint(state.automation, at.X, at.Y)
		if err != nil || elem == nil {
			return []string{}, nil
		}
		var names []string
		cur := elem
		for climb := 0; climb < 14 && cur != nil; climb++ {
			role := controlTypeName(uiaElementGetPropertyInt(cur, UIA_ControlTypePropertyId))
			// What is typed into a password field is never read; nor is its name needed.
			if !uiaElementGetPropertyBool(cur, UIA_IsPasswordPropertyId) {
				if name := uiaElementGetPropertyStr(cur, UIA_NamePropertyId); name != "" {
					names = append(names, name)
				}
			}
			parent, perr := uiaWalkerGetParent(walker, cur)
			cur.Release()
			cur = nil
			if perr != nil || parent == nil || role == "Window" {
				if parent != nil {
					parent.Release()
				}
				break
			}
			cur = parent
		}
		if cur != nil {
			cur.Release()
		}
		return names, nil
	})
	if err != nil {
		return nil
	}
	names, _ := result.([]string)
	return names
}

func (w *lookWindows) Snapshot(screen lookRect) lookSnapshot {
	if screen.empty() {
		return nil
	}
	screenDC, _, _ := procGetDC.Call(0)
	if screenDC == 0 {
		return nil
	}
	defer procReleaseDC.Call(0, screenDC)
	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	if memDC == 0 {
		return nil
	}
	defer procDeleteDC.Call(memDC)
	bi := pblBitmapInfo{Header: pblBitmapInfoHeader{
		BiSize: uint32(unsafe.Sizeof(pblBitmapInfoHeader{})), BiWidth: int32(screen.W), BiHeight: -int32(screen.H),
		BiPlanes: 1, BiBitCount: 32,
	}}
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(memDC, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if dib == 0 || bits == nil {
		return nil
	}
	old, _, _ := procSelectObject.Call(memDC, dib)
	defer func() {
		procSelectObject.Call(memDC, old)
		procDeleteObjectGdi.Call(dib)
	}()
	// With layered windows too: an app drawn that way is part of what the
	// person sees. The ink is not up yet.
	r, _, _ := procLookBitBlt.Call(memDC, 0, 0, uintptr(int32(screen.W)), uintptr(int32(screen.H)),
		screenDC, uintptr(uint32(int32(screen.X))), uintptr(uint32(int32(screen.Y))), notchLookSrcCopy|notchLookCaptureBlt)
	if r == 0 {
		return nil
	}
	shot := &lookShot{pixels: make([]byte, screen.W*screen.H*4), w: screen.W, h: screen.H, x: screen.X, y: screen.Y}
	copy(shot.pixels, unsafe.Slice((*byte)(bits), len(shot.pixels)))
	return shot
}

// ---------------------------------------------------------------------------
// The ink
// ---------------------------------------------------------------------------

type lookInkCmd struct {
	// 1 begin, 2 line, 3 tag, 4 end; 6 the hand goes to a rectangle and rings
	// it, 7 that was clicked, 8 every hand goes home; 9 a hand of a job goes to
	// a place, 10 the words beside the person's own pointer
	kind   uint8
	a, b   lookPoint
	screen lookRect
	scale  float64
	text   string
	bounds lookRect
	stay   time.Duration
	// 9: which hand, whether it comes up beside the person's pointer, and
	// where to say how long its way takes.
	n      int
	beside bool
	reply  chan time.Duration
}

func (w *lookWindows) post(cmd lookInkCmd) {
	select {
	case w.ink <- cmd:
	default:
		// A thousand pieces of line are waiting to be drawn. One more is not
		// worth holding the pointer up for.
	}
}

func (w *lookWindows) InkBegin(at lookPoint, screen lookRect, scale float64) {
	w.post(lookInkCmd{kind: 1, a: at, screen: screen, scale: scale})
}
func (w *lookWindows) InkLine(from, to lookPoint) { w.post(lookInkCmd{kind: 2, a: from, b: to}) }
func (w *lookWindows) InkTag(text string, bounds lookRect) {
	w.post(lookInkCmd{kind: 3, text: text, bounds: bounds})
}
func (w *lookWindows) InkEnd(stay time.Duration) { w.post(lookInkCmd{kind: 4, stay: stay}) }
func (w *lookWindows) Point(r lookRect, label string, stay time.Duration) {
	w.post(lookInkCmd{kind: 6, bounds: r, text: label, stay: stay})
}
func (w *lookWindows) PointHit() { w.post(lookInkCmd{kind: 7}) }
func (w *lookWindows) PointEnd() { w.post(lookInkCmd{kind: 8}) }

// HandTo sends one of the hands to a place and says how long its way takes.
func (w *lookWindows) HandTo(n int, at lookPoint, beside bool) time.Duration {
	if n < 0 || n >= notchHandCount {
		n = 0
	}
	reply := make(chan time.Duration, 1)
	w.post(lookInkCmd{kind: 9, n: n, a: at, beside: beside, reply: reply})
	select {
	case took := <-reply:
		return took
	case <-time.After(500 * time.Millisecond):
		// The ink is busy or its line is full: the step does not wait for the hand.
		return 0
	}
}
func (w *lookWindows) HandsHome() { w.post(lookInkCmd{kind: 8}) }
func (w *lookWindows) Hover(text string, at lookPoint) {
	w.post(lookInkCmd{kind: 10, text: text, a: at})
}

// notchHandHome is where the hand lives: inside the notch, at the top of its
// window. False when the notch has no window.
func (w *lookWindows) notchHandHome() (lookPoint, bool) {
	win := notchWin.Load()
	if win == nil || win.hwnd == 0 {
		return lookPoint{}, false
	}
	var rc w32Rect
	if ok, _, _ := procGetWindowRect.Call(win.hwnd, uintptr(unsafe.Pointer(&rc))); ok == 0 {
		return lookPoint{}, false
	}
	middle := lookPoint{int(rc.Left+rc.Right) / 2, int(rc.Top) + 8}
	_, scale := w.Screen(middle)
	// The resting notch is 32 px high at 100%: a little above its lower edge.
	return lookPoint{middle.X, int(rc.Top) + int(20*scale)}, true
}

// lookUlwInfo mirrors Win32 UPDATELAYEREDWINDOWINFO.
type lookUlwInfo struct {
	Size  uint32
	DcDst uintptr
	PtDst *pblPoint
	Sz    *pblSize
	DcSrc uintptr
	PtSrc *pblPoint
	Key   uint32
	Blend *pblBlendFunction
	Flags uint32
	Dirty *w32Rect
}

// lookSheet is one window with a picture of its own: the ink, or the tag.
type lookSheet struct {
	hwnd   uintptr
	memDC  uintptr
	dib    uintptr
	oldBmp uintptr
	pixels []uint32
	x, y   int32
	w, h   int32
}

var lookSheetClass sync.Once

func lookSheetProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

func newLookSheet(x, y, width, height int) (*lookSheet, error) {
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("a sheet of %d by %d", width, height)
	}
	className, _ := syscall.UTF16PtrFromString("JarvisNotchLook")
	hInstance, _, _ := procGetModuleHandleW.Call(0)
	lookSheetClass.Do(func() {
		wc := pblWndClassEx{Size: uint32(unsafe.Sizeof(pblWndClassEx{})), WndProc: syscall.NewCallback(lookSheetProc), Instance: hInstance, ClassName: className}
		procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	})
	// Layered: it has a picture with clear pixels. Transparent: clicks and hit
	// tests go through it. No-activate and tool window: it never has the
	// keyboard and is not in the taskbar or Alt + Tab.
	hwnd, _, callErr := procCreateWindowExW.Call(
		uintptr(pblWsExLayered|pblWsExTransparent|pblWsExTopmost|pblWsExNoActivate|pblWsExToolWindow),
		uintptr(unsafe.Pointer(className)), 0, uintptr(pblWsPopup),
		uintptr(uint32(int32(x))), uintptr(uint32(int32(y))), uintptr(int32(width)), uintptr(int32(height)),
		0, 0, hInstance, 0)
	if hwnd == 0 {
		return nil, fmt.Errorf("CreateWindowExW: %v", callErr)
	}
	screenDC, _, _ := procGetDC.Call(0)
	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	procReleaseDC.Call(0, screenDC)
	bi := pblBitmapInfo{Header: pblBitmapInfoHeader{
		BiSize: uint32(unsafe.Sizeof(pblBitmapInfoHeader{})), BiWidth: int32(width), BiHeight: -int32(height),
		BiPlanes: 1, BiBitCount: 32,
	}}
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(memDC, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if memDC == 0 || dib == 0 || bits == nil {
		if dib != 0 {
			procDeleteObjectGdi.Call(dib)
		}
		if memDC != 0 {
			procDeleteDC.Call(memDC)
		}
		procDestroyWindow.Call(hwnd)
		return nil, fmt.Errorf("no picture of %d by %d could be made", width, height)
	}
	old, _, _ := procSelectObject.Call(memDC, dib)
	return &lookSheet{
		hwnd: hwnd, memDC: memDC, dib: dib, oldBmp: old,
		pixels: unsafe.Slice((*uint32)(bits), width*height),
		x:      int32(x), y: int32(y), w: int32(width), h: int32(height),
	}, nil
}

// show hands the picture to the window. With dirty, only that part of it.
func (s *lookSheet) show(dirty *lookRect) {
	const acSrcOver, acSrcAlpha = 0x00, 0x01
	blend := pblBlendFunction{BlendOp: acSrcOver, SourceConstantAlpha: 255, AlphaFormat: acSrcAlpha}
	winPt, winSz, srcPt := pblPoint{X: s.x, Y: s.y}, pblSize{CX: s.w, CY: s.h}, pblPoint{}
	screenDC, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, screenDC)
	if dirty != nil && procLookUpdateLayeredIndirect.Find() == nil {
		rc := w32Rect{Left: int32(dirty.X), Top: int32(dirty.Y), Right: int32(dirty.X + dirty.W), Bottom: int32(dirty.Y + dirty.H)}
		info := lookUlwInfo{DcDst: screenDC, PtDst: &winPt, Sz: &winSz, DcSrc: s.memDC, PtSrc: &srcPt, Blend: &blend, Flags: pblUlwAlpha, Dirty: &rc}
		info.Size = uint32(unsafe.Sizeof(info))
		if r, _, _ := procLookUpdateLayeredIndirect.Call(s.hwnd, uintptr(unsafe.Pointer(&info))); r != 0 {
			return
		}
	}
	procUpdateLayeredWindow.Call(s.hwnd, screenDC,
		uintptr(unsafe.Pointer(&winPt)), uintptr(unsafe.Pointer(&winSz)),
		s.memDC, uintptr(unsafe.Pointer(&srcPt)), 0,
		uintptr(unsafe.Pointer(&blend)), pblUlwAlpha)
}

func (s *lookSheet) raise() {
	procShowWindow.Call(s.hwnd, notchSwShowNoActivate)
	procSetWindowPos.Call(s.hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

func (s *lookSheet) destroy() {
	procSelectObject.Call(s.memDC, s.oldBmp)
	procDeleteObjectGdi.Call(s.dib)
	procDeleteDC.Call(s.memDC)
	procDestroyWindow.Call(s.hwnd)
	s.pixels = nil
}

// inkHand is one of Jarvis's own pointers, in a small window of its own that
// is moved, so that the sheet under it is not painted again as it flies.
type inkHand struct {
	sheet *lookSheet
	// Where its tip is.
	tip lookPoint
	fly struct {
		on       bool
		from, to lookPoint
		began    time.Time
		took     time.Duration
		// Leaving the notch it grows and comes into sight. Going home it does the opposite, and is gone.
		grow, home bool
	}
}

// inkThread owns the ink's window, the tag's and the hands'. It draws what it
// is told to, in the order it is told, moves what is moving, and takes
// everything away when its time is up.
func (w *lookWindows) inkThread() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var (
		sheet   *lookSheet
		ink     *notchInk
		tag     *lookSheet
		tagText string
		screen  lookRect
		scale   = 1.0
		endAt   time.Time

		hands     [notchHandCount]*inkHand
		handPic   *notchHand
		handScale float64
		ring      struct {
			// To be drawn when the hand has landed; being drawn.
			due, on bool
			pieces  []lookPoint
			drawn   int
			began   time.Time
			bounds  lookRect
			text    string
			stay    time.Duration
		}
		// When the hand, left on a thing that was clicked, goes home by itself.
		homeAt time.Time
		// The words that follow the pointer while a thing is held to be put somewhere.
		hover     *lookSheet
		hoverText string
		hoverAt   lookPoint
	)
	anyHand := func() bool {
		for _, h := range hands {
			if h != nil {
				return true
			}
		}
		return false
	}
	closeInk := func() {
		if tag != nil {
			tag.destroy()
			tag = nil
		}
		if sheet != nil {
			sheet.destroy()
			sheet = nil
		}
		ink, tagText, endAt = nil, "", time.Time{}
		ring.due, ring.on, ring.pieces, ring.drawn = false, false, nil, 0
	}
	closeHover := func() {
		if hover != nil {
			hover.destroy()
			hover = nil
		}
		hoverText = ""
	}
	closeHand := func(i int) {
		if hands[i] != nil {
			hands[i].sheet.destroy()
			hands[i] = nil
		}
		if !anyHand() {
			handPic, homeAt = nil, time.Time{}
		}
	}
	closeHands := func() {
		for i := range hands {
			closeHand(i)
		}
	}
	closeAll := func() {
		closeInk()
		closeHands()
	}
	// placeHand shows a hand with its tip at a place, at a part of its size and strength.
	placeHand := func(h *inkHand, x, y, size, strength float64) {
		if h == nil || handPic == nil {
			return
		}
		handPic.frame(h.sheet.pixels, size, strength)
		h.sheet.x, h.sheet.y = int32(math.Round(x-handPic.tipX)), int32(math.Round(y-handPic.tipY))
		h.sheet.show(nil)
	}
	sendHome := func(i int) {
		h := hands[i]
		if h == nil || h.fly.home {
			return
		}
		home, ok := w.notchHandHome()
		if !ok {
			closeHand(i)
			return
		}
		h.fly.on, h.fly.from, h.fly.to, h.fly.began, h.fly.took, h.fly.grow, h.fly.home = true, h.tip, home, time.Now(), notchHandHome, false, true
	}
	goHome := func() {
		closeInk()
		for i := range hands {
			sendHome(i)
		}
		homeAt = time.Time{}
	}
	// bringHand gives the hand numbered i, making it when it is not out. Fresh
	// says it was made now and has yet to come into sight. Nil when no hand
	// could be made.
	bringHand := func(i int, at lookPoint) (h *inkHand, fresh bool) {
		_, s := w.Screen(at)
		if handPic != nil && handScale != s {
			// Another display, drawn at another size: the hands are made again.
			closeHands()
		}
		if handPic == nil {
			handPic, handScale = newNotchHand(s), s
		}
		if hands[i] != nil {
			if hands[i].fly.home {
				// On its way home: it turns round where it is.
				hands[i].fly.home = false
			}
			return hands[i], false
		}
		made, err := newLookSheet(0, 0, handPic.w, handPic.h)
		if err != nil {
			log.Printf("[notch] look: no hand: %v", err)
			return nil, false
		}
		hands[i] = &inkHand{sheet: made}
		return hands[i], true
	}
	// startRing puts up the sheet the ring is drawn on, under the hand.
	startRing := func() {
		ring.due = false
		s, err := newLookSheet(screen.X, screen.Y, screen.W, screen.H)
		if err != nil {
			log.Printf("[notch] look: no ring: %v", err)
			return
		}
		sheet, ink = s, newNotchInk(screen.W, screen.H)
		local := lookRect{ring.bounds.X - screen.X, ring.bounds.Y - screen.Y, ring.bounds.W, ring.bounds.H}
		ring.pieces = lookPathPieces(lookRingPath(local, 6*scale, 10*scale), 6*scale)
		ring.drawn, ring.began, ring.on = 0, time.Now(), true
		sheet.show(nil)
		sheet.raise()
		for _, h := range hands {
			if h != nil {
				h.sheet.raise()
			}
		}
	}
	pump := func() {
		for {
			var m w32Msg
			if r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, pblPmRemove); r == 0 {
				return
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}
	// A hand sets off for a place: out of the notch (or from beside the
	// person's own pointer) when it is new, from where it is when it is out.
	// It comes back with how long the way takes.
	setOff := func(i int, to lookPoint, beside, quick bool) time.Duration {
		h, fresh := bringHand(i, to)
		if h == nil {
			return 0
		}
		from, grow := h.tip, false
		if fresh {
			grow = true
			switch home, ok := w.notchHandHome(); {
			case beside:
				// The baton: it comes up where the person's hand is, and goes on from there.
				from = to
			case ok:
				// Each hand leaves the notch a little apart from the others.
				from = lookPoint{home.X + int(float64((i*2-(notchHandCount-1))*8)*handScale), home.Y}
			default:
				// No notch to come out of: from the top of the display the thing is on.
				sc, s := w.Screen(to)
				from = lookPoint{sc.X + sc.W/2, sc.Y + int(12*s)}
			}
		}
		took := lookHandFlight(from, to)
		if quick && !fresh {
			took = time.Duration(lookHandHop(from, to)) * time.Millisecond
		}
		if beside && fresh {
			took = notchHandGrow
		}
		h.fly.on, h.fly.from, h.fly.to, h.fly.began, h.fly.took, h.fly.grow, h.fly.home = true, from, to, time.Now(), took, grow, false
		h.tip = from
		if grow {
			placeHand(h, float64(from.X), float64(from.Y), notchHandSmall, 0)
		} else {
			placeHand(h, float64(from.X), float64(from.Y), 1, 1)
		}
		h.sheet.raise()
		return took
	}
	handle := func(cmd lookInkCmd, dirty *lookRect) {
		switch cmd.kind {
		case 1:
			closeAll()
			closeHover()
			screen, scale = cmd.screen, cmd.scale
			s, err := newLookSheet(screen.X, screen.Y, screen.W, screen.H)
			if err != nil {
				log.Printf("[notch] look: no ink: %v", err)
				return
			}
			sheet, ink = s, newNotchInk(screen.W, screen.H)
			// A dot where the press was: a click leaves a mark too.
			x, y := float64(cmd.a.X-screen.X), float64(cmd.a.Y-screen.Y)
			touched := ink.stroke(x, y, x, y, notchInkRadius*scale)
			ink.paint(sheet.pixels, touched)
			sheet.show(nil)
			sheet.raise()
		case 2:
			if sheet == nil || ink == nil || !endAt.IsZero() || ring.on || anyHand() {
				return
			}
			touched := ink.stroke(float64(cmd.a.X-screen.X), float64(cmd.a.Y-screen.Y), float64(cmd.b.X-screen.X), float64(cmd.b.Y-screen.Y), notchInkRadius*scale)
			*dirty = lookUnion(*dirty, touched)
		case 3:
			if sheet == nil || cmd.text == tagText || anyHand() {
				return
			}
			tagText = cmd.text
			if tag != nil {
				tag.destroy()
				tag = nil
			}
			if cmd.text != "" {
				tag = newLookTag(cmd.text, cmd.bounds, screen, scale)
			}
		case 4:
			if sheet == nil || anyHand() {
				return
			}
			if cmd.stay <= 0 {
				closeAll()
				return
			}
			endAt = time.Now().Add(cmd.stay)
		case 6:
			// The hand goes to a thing. Whatever was ringed before is taken
			// down first; the hand, if it is out, sets off from where it is.
			// The other hands, out for a job that is over, go home.
			closeInk()
			for i := 1; i < notchHandCount; i++ {
				sendHome(i)
			}
			middle := lookPoint{cmd.bounds.X + cmd.bounds.W/2, cmd.bounds.Y + cmd.bounds.H/2}
			screen, scale = w.Screen(middle)
			ring.due, ring.on, ring.bounds, ring.text, ring.stay = true, false, cmd.bounds, cmd.text, cmd.stay
			homeAt = time.Time{}
			if setOff(0, lookHandRest(cmd.bounds, scale), false, false); hands[0] == nil {
				// Without the hand the ring is still worth having.
				startRing()
			}
		case 7:
			// Clicked: the ring is not left lying over what the click opened.
			closeInk()
			if hands[0] != nil && !hands[0].fly.home {
				homeAt = time.Now().Add(notchHandLinger)
			}
		case 8:
			goHome()
		case 9:
			// A hand of a job goes to the place its next step lands on. No
			// ring: the thing that happens there is what is seen.
			closeInk()
			took := setOff(cmd.n, cmd.a, cmd.beside, true)
			homeAt = time.Now().Add(notchHandJobIdle)
			if cmd.reply != nil {
				cmd.reply <- took
			}
		case 10:
			// The words beside the person's pointer: what would be put here.
			if cmd.text == "" {
				closeHover()
				return
			}
			if cmd.text == hoverText && absInt(cmd.a.X-hoverAt.X) < 3 && absInt(cmd.a.Y-hoverAt.Y) < 3 {
				return
			}
			if hover != nil {
				hover.destroy()
				hover = nil
			}
			sc, s := w.Screen(cmd.a)
			hoverText, hoverAt = cmd.text, cmd.a
			hover = newLookTag(cmd.text, lookRect{cmd.a.X - int(10*s), cmd.a.Y - int(10*s), int(20 * s), int(20 * s)}, sc, s)
		}
	}
	for {
		var tick <-chan time.Time
		flying := false
		for _, h := range hands {
			if h != nil && h.fly.on {
				flying = true
			}
		}
		if sheet != nil || hover != nil || anyHand() {
			// Something is up: its messages are answered, its time is watched,
			// and what is moving is moved.
			every := 30 * time.Millisecond
			if flying || ring.on {
				every = 8 * time.Millisecond
			}
			tick = time.After(every)
		}
		dirty := lookRect{}
		select {
		case cmd := <-w.ink:
			handle(cmd, &dirty)
			// Everything that is waiting, then one picture: the line keeps up with the hand.
			for more := true; more; {
				select {
				case next := <-w.ink:
					handle(next, &dirty)
				default:
					more = false
				}
			}
		case <-tick:
		}
		now := time.Now()
		for i, h := range hands {
			if h == nil || !h.fly.on {
				continue
			}
			gone := now.Sub(h.fly.began)
			if gone >= h.fly.took {
				h.fly.on = false
				h.tip = h.fly.to
				if h.fly.home {
					closeHand(i)
					continue
				}
				placeHand(h, float64(h.tip.X), float64(h.tip.Y), 1, 1)
				if i == 0 && ring.due {
					startRing()
				}
				continue
			}
			part := float64(gone) / float64(h.fly.took)
			x, y := lookHandAt(h.fly.from, h.fly.to, part)
			size, strength := 1.0, 1.0
			if h.fly.grow {
				size = notchHandSmall + (1-notchHandSmall)*lookEase(0.2, 0.7, 0.2, 1, float64(gone)/float64(notchHandGrow))
				strength = math.Min(1, float64(gone)/float64(180*time.Millisecond))
			}
			if h.fly.home {
				size = 1 - (1-notchHandSmall)*part
				strength = 1 - part*part
			}
			h.tip = lookPoint{int(math.Round(x)), int(math.Round(y))}
			placeHand(h, x, y, size, strength)
		}
		if ring.on && sheet != nil && ink != nil {
			part := float64(now.Sub(ring.began)) / float64(notchHandRing)
			upTo := len(ring.pieces) - 1
			if part < 1 {
				upTo = int(part * float64(upTo))
			}
			for ring.drawn < upTo {
				a, b := ring.pieces[ring.drawn], ring.pieces[ring.drawn+1]
				dirty = lookUnion(dirty, ink.stroke(float64(a.X), float64(a.Y), float64(b.X), float64(b.Y), notchInkRadius*scale*0.8))
				ring.drawn++
			}
			if part >= 1 {
				ring.on = false
				if ring.text != "" {
					tagText = ring.text
					tag = newLookTag(ring.text, ring.bounds, screen, scale)
					for _, h := range hands {
						if h != nil {
							h.sheet.raise()
						}
					}
				}
				endAt = now.Add(ring.stay)
			}
		}
		if sheet != nil && ink != nil && !dirty.empty() {
			ink.paint(sheet.pixels, dirty)
			sheet.show(&dirty)
		}
		if sheet != nil || hover != nil || anyHand() {
			pump()
			if !endAt.IsZero() && now.After(endAt) {
				if anyHand() {
					// The ring had its time and nobody clicked: the hand goes home.
					goHome()
				} else {
					closeAll()
				}
			}
			if !homeAt.IsZero() && now.After(homeAt) {
				goHome()
			}
		}
	}
}

// newLookTag makes the tag's window: a dark plate with the words on it, above
// what was circled.
func newLookTag(text string, bounds, screen lookRect, scale float64) *lookSheet {
	px := func(v float64) int { return int(v*scale + 0.5) }
	words, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		return nil
	}
	font := makeMdFont(-int32(px(notchLookTagFontPx)), fwMedium, "Segoe UI")
	if font == 0 {
		return nil
	}
	defer procDeleteObjectGdi.Call(font)
	// How wide the words are, measured on a DC of the screen's kind.
	screenDC, _, _ := procGetDC.Call(0)
	measureDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	procReleaseDC.Call(0, screenDC)
	if measureDC == 0 {
		return nil
	}
	prev, _, _ := procSelectObject.Call(measureDC, font)
	most := int32(px(notchLookTagMaxWidth))
	size := pblRect{Right: most, Bottom: int32(px(40))}
	nullTerm := int32(-1)
	procDrawTextW.Call(measureDC, uintptr(unsafe.Pointer(words)), uintptr(nullTerm), uintptr(unsafe.Pointer(&size)), uintptr(uint32(dtLeft|dtSingleLine|dtCalcRect)))
	procSelectObject.Call(measureDC, prev)
	procDeleteDC.Call(measureDC)
	textW, textH := min(size.Right-size.Left, most), size.Bottom-size.Top
	if textW <= 0 || textH <= 0 {
		return nil
	}
	padX, padY := px(notchLookTagPadX), px(notchLookTagPadY)
	width, height := int(textW)+2*padX, int(textH)+2*padY
	x, y := notchTagPlace(bounds, width, height, screen, px(notchLookTagGap))
	sheet, err := newLookSheet(x, y, width, height)
	if err != nil {
		return nil
	}
	notchTagPill(sheet.pixels, width, height, float64(px(notchLookTagRadius)))
	prevFont, _, _ := procSelectObject.Call(sheet.memDC, font)
	procSetBkMode.Call(sheet.memDC, uintptr(bkModeTransparent))
	procSetTextColor.Call(sheet.memDC, uintptr(colorRef(0xEE, 0xF1, 0xF4)))
	rc := pblRect{Left: int32(padX), Top: int32(padY), Right: int32(padX) + textW, Bottom: int32(padY) + textH}
	procDrawTextW.Call(sheet.memDC, uintptr(unsafe.Pointer(words)), uintptr(nullTerm), uintptr(unsafe.Pointer(&rc)), uintptr(uint32(dtLeft|dtSingleLine|dtEndEllipsis)))
	procSelectObject.Call(sheet.memDC, prevFont)
	// Drawing words clears the fourth byte of every pixel it touches, which
	// would make them holes in the plate. Where the words are, the plate is
	// solid: put that back.
	for row := padY; row < padY+int(textH) && row < height; row++ {
		for col := padX; col < padX+int(textW) && col < width; col++ {
			sheet.pixels[row*width+col] |= 0xFF000000
		}
	}
	sheet.show(nil)
	sheet.raise()
	return sheet
}

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

// lookFound is an element the reading settled on, with what was read of it.
type lookFound struct {
	elem  *ole.IDispatch
	role  string
	local string
	rect  lookRect
}

func lookRectOf(elem *ole.IDispatch) lookRect {
	x, y, width, height := uiaElementGetBoundingRect(elem)
	return lookRect{x, y, width, height}
}

func lookRowLike(role, local string, r lookRect) bool {
	local = strings.ToLower(strings.TrimSpace(local))
	if local == "row" || role == "ListItem" || role == "TreeItem" {
		return true
	}
	return role == "DataItem" && lookKindOf(role, local, r) == "row"
}

// lookSettle goes from the element under a place up to the thing a person
// means there: the row a word is in; failing that the nearest thing that is
// one by itself (a button, a link, a field); failing that the element as it
// is. It takes over elem, and what it returns is the caller's to release.
func lookSettle(walker *ole.IDispatch, elem *ole.IDispatch) lookFound {
	read := func(e *ole.IDispatch) lookFound {
		return lookFound{
			elem:  e,
			role:  controlTypeName(uiaElementGetPropertyInt(e, UIA_ControlTypePropertyId)),
			local: uiaElementGetPropertyStr(e, uiaLocalizedTypeID),
			rect:  lookRectOf(e),
		}
	}
	leaf := read(elem)
	var item *lookFound
	chain := []*ole.IDispatch{elem}
	keep := func(found lookFound) lookFound {
		for _, e := range chain {
			if e != found.elem {
				e.Release()
			}
		}
		return found
	}
	cur := leaf
	for climb := 0; ; climb++ {
		if lookRowLike(cur.role, cur.local, cur.rect) && (climb == 0 || lookRowOf(cur.rect, leaf.rect)) {
			return keep(cur)
		}
		if item == nil && (lookItemRoles[cur.role] || lookKindOf(cur.role, cur.local, cur.rect) != "thing") && cur.role != "Text" {
			found := cur
			item = &found
		}
		if climb >= notchLookClimb {
			break
		}
		parent, err := uiaWalkerGetParent(walker, cur.elem)
		if err != nil || parent == nil {
			break
		}
		chain = append(chain, parent)
		next := read(parent)
		// The place the things are in is not a thing; it is only gone into
		// when it calls itself a row.
		if lookEdgeRoles[next.role] && !lookRowLike(next.role, next.local, next.rect) {
			break
		}
		cur = next
	}
	if item != nil {
		return keep(*item)
	}
	return keep(leaf)
}

// lookDescribe reads a settled element into a thing. light: only what the tag
// needs.
func lookDescribe(state *uiaState, found lookFound, light bool) lookThing {
	thing := lookThing{
		Kind: lookKindOf(found.role, found.local, found.rect),
		Role: found.role,
		Name: lookClean(uiaElementGetPropertyStr(found.elem, UIA_NamePropertyId)),
		Rect: found.rect,
	}
	// What is typed into a password field is never read, here or anywhere.
	secret := uiaElementGetPropertyBool(found.elem, UIA_IsPasswordPropertyId)
	if light || secret {
		return thing
	}
	if value := lookClean(uiaElementGetPropertyStr(found.elem, uiaValueValueID)); value != thing.Name {
		thing.Value = value
	}
	if thing.Kind != "row" && thing.Kind != "item" {
		return thing
	}
	// The cells of a row: what each one says. Explorer keeps the cell's words
	// in its value and the column's name in its name; a web page keeps the
	// words in the name.
	trueCond, err := uiaCreateTrueCondition(state.automation)
	if err != nil {
		return thing
	}
	defer trueCond.Release()
	children, err := uiaElementFindAll(found.elem, TreeScope_Children, trueCond)
	if err != nil || children == nil {
		return thing
	}
	defer children.Release()
	count := min(uiaArrayLength(children), notchLookMaxParts)
	for i := 0; i < count; i++ {
		child := uiaArrayGetElement(children, i)
		if child == nil {
			continue
		}
		if !uiaElementGetPropertyBool(child, UIA_IsPasswordPropertyId) {
			text := lookClean(uiaElementGetPropertyStr(child, uiaValueValueID))
			if text == "" {
				text = lookClean(uiaElementGetPropertyStr(child, UIA_NamePropertyId))
			}
			if text != "" {
				thing.Parts = append(thing.Parts, truncateRunes(text, notchLookPartRunes))
			}
		}
		child.Release()
	}
	// A row whose only cell says what the row is called says nothing new.
	if len(thing.Parts) == 1 && thing.Parts[0] == thing.Name {
		thing.Parts = nil
	}
	return thing
}

func (w *lookWindows) ThingAt(at lookPoint, light bool) (lookThing, bool) {
	result, err := comThread.call(func(state *uiaState) (any, error) {
		walker, err := uiaRawViewWalker(state.automation)
		if err != nil {
			return nil, err
		}
		defer walker.Release()
		elem, err := uiaElementFromPoint(state.automation, at.X, at.Y)
		if err != nil || elem == nil {
			return nil, fmt.Errorf("nothing at the place")
		}
		found := lookSettle(walker, elem)
		defer found.elem.Release()
		return lookDescribe(state, found, light), nil
	})
	if err != nil {
		return lookThing{}, false
	}
	thing, ok := result.(lookThing)
	return thing, ok && !thing.Rect.empty()
}

func (w *lookWindows) ThingsIn(line []lookPoint, light bool) []lookThing {
	result, err := comThread.call(func(state *uiaState) (any, error) {
		walker, err := uiaRawViewWalker(state.automation)
		if err != nil {
			return nil, err
		}
		defer walker.Release()
		// What is at a few places inside the line.
		var found []lookFound
		defer func() {
			for _, f := range found {
				f.elem.Release()
			}
		}()
		seen := map[string]bool{}
		for _, p := range lookSamplePoints(line, notchLookSamples) {
			elem, err := uiaElementFromPoint(state.automation, p.X, p.Y)
			if err != nil || elem == nil {
				continue
			}
			f := lookSettle(walker, elem)
			key := fmt.Sprintf("%s|%d|%d|%d|%d", f.role, f.rect.X, f.rect.Y, f.rect.W, f.rect.H)
			if seen[key] || f.rect.empty() {
				f.elem.Release()
				continue
			}
			seen[key] = true
			found = append(found, f)
		}
		if len(found) == 0 {
			return []lookThing{}, nil
		}
		// Things that stand side by side in one container: the container is
		// gone through, so that a row between two places that were asked
		// about is not left out.
		if len(found) >= 2 {
			if things, ok := lookSiblings(state, walker, found, line, light); ok {
				return things, nil
			}
		}
		things := make([]lookThing, 0, len(found))
		for _, f := range found {
			if lookCovers(line, f.rect) {
				things = append(things, lookDescribe(state, f, light))
			}
		}
		if len(things) == 0 {
			// A line with no inside, or one that holds only part of one large
			// thing: what it runs over is what is meant.
			for _, f := range found {
				things = append(things, lookDescribe(state, f, light))
			}
		}
		return things, nil
	})
	if err != nil {
		return nil
	}
	things, _ := result.([]lookThing)
	return things
}

// lookSiblings reads the children of the one container every found thing
// stands in, and keeps those the line holds. ok is false when they do not
// share a container.
func lookSiblings(state *uiaState, walker *ole.IDispatch, found []lookFound, line []lookPoint, light bool) ([]lookThing, bool) {
	parent, err := uiaWalkerGetParent(walker, found[0].elem)
	if err != nil || parent == nil {
		return nil, false
	}
	defer parent.Release()
	for _, f := range found[1:] {
		other, err := uiaWalkerGetParent(walker, f.elem)
		if err != nil || other == nil {
			return nil, false
		}
		same := uiaCompareElements(state.automation, parent, other)
		other.Release()
		if !same {
			return nil, false
		}
	}
	trueCond, err := uiaCreateTrueCondition(state.automation)
	if err != nil {
		return nil, false
	}
	defer trueCond.Release()
	children, err := uiaElementFindAll(parent, TreeScope_Children, trueCond)
	if err != nil || children == nil {
		return nil, false
	}
	defer children.Release()
	var things []lookThing
	count := min(uiaArrayLength(children), notchLookMaxSiblings)
	for i := 0; i < count && len(things) < notchLookMaxThings; i++ {
		child := uiaArrayGetElement(children, i)
		if child == nil {
			continue
		}
		rect := lookRectOf(child)
		if lookCovers(line, rect) {
			things = append(things, lookDescribe(state, lookFound{
				elem:  child,
				role:  controlTypeName(uiaElementGetPropertyInt(child, UIA_ControlTypePropertyId)),
				local: uiaElementGetPropertyStr(child, uiaLocalizedTypeID),
				rect:  rect,
			}, light))
		}
		child.Release()
	}
	return things, len(things) > 0
}

// ---------------------------------------------------------------------------
// The window the person is in, for "where is...?"
// ---------------------------------------------------------------------------

// platformNotchWindowRead reads the window the person is in: what it says of
// itself, element by element, each with its place in the screen's own pixels.
// It is the window in front, unless that is one of this program's own (the
// notch has the keyboard while something is typed into it): then it is the
// first window behind that is somebody else's.
func platformNotchWindowRead() (map[string]any, error) {
	var hwnd uintptr
	var pid uint32
	if fg := win32RootWindow(win32GetForegroundWindow()); fg != 0 && !ownWindow(fg) {
		hwnd, pid = fg, win32GetWindowPid(fg)
	} else {
		for _, w := range enumTopWindows() {
			if ownWindow(w.Hwnd) {
				continue
			}
			if minimized, _, _ := procIsIconic.Call(w.Hwnd); minimized != 0 {
				continue
			}
			// The desktop itself is not a window a person is "in".
			if w.ClassName == "Progman" || w.ClassName == "WorkerW" || w.ClassName == "Shell_TrayWnd" {
				continue
			}
			hwnd, pid = w.Hwnd, w.Pid
			break
		}
	}
	if hwnd == 0 || pid == 0 {
		return nil, fmt.Errorf("no window of another program is open")
	}
	app, title := notchAppKey(processBaseName(pid)), win32WindowTitle(hwnd)
	// Decided before anything is read (notch_where.go).
	if away := notchLookAway(app, title); away != "" {
		return map[string]any{"away": away}, nil
	}
	val, err := comThread.call(func(state *uiaState) (any, error) {
		result, err := uiaInspect(state, int(pid), 8, false, false)
		if err != nil {
			return nil, err
		}
		// What is open on top of the window comes first in the list: it is
		// what the person is looking at, and the list may be cut short.
		if popups := notchPopupElements(state, int(pid), hwnd); len(popups) > 0 {
			rest, _ := result["elements"].([]map[string]any)
			result["elements"] = append(popups, rest...)
			result["element_count"] = len(popups) + len(rest)
			result["popups"] = len(popups)
		}
		return result, nil
	})
	if err != nil {
		return nil, err
	}
	result, _ := val.(map[string]any)
	if result == nil {
		return nil, fmt.Errorf("the window could not be read")
	}
	result["app"] = app
	return result, nil
}

// The most that is read of what is open on top of a window.
const notchPopupElementLimit = 160

// notchPopupElements reads what a program has open on top of its window: a
// menu, a list dropped down from a box, a right-click menu. Each of those is
// a window of its own with no title bar, and is never the window "in front",
// so reading the window in front leaves it out. Without it, the second step
// of anything that begins with a menu could not be found: the menu is exactly
// where it is.
//
// Only the same program's windows, only those on the screen, and only those
// without a title bar: a second full window of the program is not what the
// person is in. A menu Windows itself draws (its class is "#32768") belongs
// to the program that opened it, and is taken the same way.
func notchPopupElements(state *uiaState, pid int, front uintptr) []map[string]any {
	root, err := uiaGetRootElement(state.automation)
	if err != nil || root == nil {
		return nil
	}
	defer root.Release()
	ofProgram, err := uiaCreatePropertyCondition(state.automation, UIA_ProcessIdPropertyId, pid)
	if err != nil || ofProgram == nil {
		return nil
	}
	defer ofProgram.Release()
	tops, err := uiaElementFindAll(root, TreeScope_Children, ofProgram)
	if err != nil || tops == nil {
		return nil
	}
	defer tops.Release()
	all, err := uiaCreateTrueCondition(state.automation)
	if err != nil || all == nil {
		return nil
	}
	defer all.Release()
	var found []map[string]any
	budget := newWalkBudget()
	count := uiaArrayLength(tops)
	for i := 0; i < count && len(found) < notchPopupElementLimit; i++ {
		top := uiaArrayGetElement(tops, i)
		if top == nil {
			continue
		}
		hwnd := uintptr(uiaElementGetPropertyInt(top, UIA_NativeWindowHandlePropertyId))
		_, _, w, h := uiaElementGetBoundingRect(top)
		titled := hwnd != 0 && getWindowLong(hwnd, gwlStyle)&wsCaption == wsCaption
		if hwnd == 0 || hwnd == front || titled || w <= 0 || h <= 0 || ownWindow(hwnd) || uiaElementGetPropertyBool(top, UIA_IsOffscreenPropertyId) {
			top.Release()
			continue
		}
		if visible, _, _ := procIsWindowVisible.Call(hwnd); visible == 0 {
			top.Release()
			continue
		}
		walkTree(state, all, top, 0, 6, false, false, nil, &found, budget)
		top.Release()
	}
	if len(found) > notchPopupElementLimit {
		found = found[:notchPopupElementLimit]
	}
	return found
}
