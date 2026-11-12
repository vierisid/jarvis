//go:build windows

package main

import (
	"fmt"
	"log"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	procNotchCreatePolygonRgn = gdi32.NewProc("CreatePolygonRgn")
	procNotchGetDpiForWindow  = user32.NewProc("GetDpiForWindow")
	procNotchGetClientRect    = user32.NewProc("GetClientRect")
	procNotchCallNtPowerInfo  = syscall.NewLazyDLL("powrprof.dll").NewProc("CallNtPowerInformation")
)

const (
	notchSwHide           = 0
	notchSwShowNoActivate = 4
	// CallNtPowerInformation level and the flag a playing video sets.
	notchSystemExecutionState = 16
	notchEsDisplayRequired    = 0x00000002
	// CreatePolygonRgn fill mode.
	notchWinding = 2
)

// notchWindow is what the window's own goroutines share. One notch per
// process, so one of these.
type notchWindow struct {
	hwnd       uintptr
	loaded     atomic.Bool    // the page has loaded and may be shown
	hidden     atomic.Bool    // hidden by the fullscreen rule
	hasFocus   atomic.Bool    // the page asked for the keyboard and has it
	previousFg atomic.Uintptr // who had the keyboard before the page took it
	outlineLog atomic.Int64   // unix ms of the last outline log line
}

var notchWin atomic.Pointer[notchWindow]

func notchWindowFor(handle unsafe.Pointer) *notchWindow {
	w := notchWin.Load()
	if w == nil || w.hwnd != uintptr(handle) {
		return nil
	}
	return w
}

// platformNotchSetUp sizes the window for the display it is on, puts it at the
// top centre of the main display, cuts it to nothing until the page reports an
// outline, and starts the fullscreen watch. It runs once, before the page
// loads, while the window is still hidden.
func platformNotchSetUp(handle unsafe.Pointer, done <-chan struct{}) {
	if handle == nil {
		return
	}
	hwnd := uintptr(handle)
	w := &notchWindow{hwnd: hwnd}
	notchWin.Store(w)

	// Per-monitor DPI: the window is given in logical pixels and Windows
	// wants physical ones.
	dpi := uintptr(96)
	if procNotchGetDpiForWindow.Find() == nil {
		if d, _, _ := procNotchGetDpiForWindow.Call(hwnd); d != 0 {
			dpi = d
		}
	}
	width := int(notchWindowW * dpi / 96)
	height := int(notchWindowH * dpi / 96)
	screenW, screenH := platformGetScreenSize()
	x := notchTopCentre(screenW, width)

	// Nothing shows until the page says what shape it is.
	_ = platformSetInteractiveRegions(handle, nil)
	procSetWindowPos.Call(hwnd, hwndTopmost,
		uintptr(int32(x)), 0, uintptr(int32(width)), uintptr(int32(height)),
		swpNoActivate)
	log.Printf("[notch] window %dx%d at (%d, 0) on a %dx%d display, dpi %d", width, height, x, screenW, screenH, dpi)

	go w.watch(done)
}

// platformNotchReveal is called once the page has loaded. The window is shown
// without taking the keyboard, unless the fullscreen rule is hiding it.
func platformNotchReveal(handle unsafe.Pointer) {
	w := notchWindowFor(handle)
	if w == nil {
		return
	}
	w.loaded.Store(true)
	if !w.hidden.Load() {
		w.show()
	}
	log.Printf("[notch] page loaded, window shown without focus")
}

func (w *notchWindow) show() {
	procShowWindow.Call(w.hwnd, notchSwShowNoActivate)
	procSetWindowPos.Call(w.hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

func (w *notchWindow) hide() {
	procShowWindow.Call(w.hwnd, notchSwHide)
}

// watch applies the fullscreen rule twice a second, and notes in the log when
// the notch holds the keyboard without having asked for it: that is the fault
// the window exists to avoid, so a test run should leave a trace of it.
func (w *notchWindow) watch(done <-chan struct{}) {
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	stoleFocus := false
	for {
		select {
		case <-done:
			notchWin.CompareAndSwap(w, nil)
			return
		case <-ticker.C:
		}
		if ok, _, _ := procIsWindow.Call(w.hwnd); ok == 0 {
			notchWin.CompareAndSwap(w, nil)
			return
		}
		fullscreen := fullscreenAppCovers(w.hwnd)
		awake := displayKeptAwake()
		hide := notchShouldHide(fullscreen, awake)
		if hide != w.hidden.Load() {
			w.hidden.Store(hide)
			if hide {
				w.hide()
				log.Printf("[notch] hidden: a fullscreen app is in front and the display is being kept awake")
			} else {
				if w.loaded.Load() {
					w.show()
				}
				log.Printf("[notch] shown again (fullscreen app in front: %v, display kept awake: %v)", fullscreen, awake)
			}
		}
		fg, _, _ := procGetForegroundWindow.Call()
		holds := fg == w.hwnd && !w.hasFocus.Load()
		if holds && !stoleFocus {
			log.Printf("[notch] WARNING: the notch has the keyboard without having asked for it")
		}
		stoleFocus = holds
	}
}

// displayKeptAwake reports whether anything on the machine is asking for the
// display to stay on. A playing video does; a page that is only being read
// does not.
func displayKeptAwake() bool {
	if procNotchCallNtPowerInfo.Find() != nil {
		return false
	}
	var state uint32
	status, _, _ := procNotchCallNtPowerInfo.Call(notchSystemExecutionState, 0, 0,
		uintptr(unsafe.Pointer(&state)), unsafe.Sizeof(state))
	if status != 0 {
		return false
	}
	return state&notchEsDisplayRequired != 0
}

// platformNotchWindowSize is the window's size in the pixels an outline uses.
func platformNotchWindowSize(handle unsafe.Pointer) (int, int) {
	var r w32Rect
	if ok, _, _ := procNotchGetClientRect.Call(uintptr(handle), uintptr(unsafe.Pointer(&r))); ok == 0 {
		return notchWindowW, notchWindowH
	}
	return int(r.Right - r.Left), int(r.Bottom - r.Top)
}

// platformNotchSetOutline cuts the window to the polygon. Windows owns the
// region after SetWindowRgn, so nothing is freed here.
func platformNotchSetOutline(handle unsafe.Pointer, outline []notchPoint) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	if len(outline) < notchOutlineMinPoints {
		return fmt.Errorf("outline too short")
	}
	rgn, _, _ := procNotchCreatePolygonRgn.Call(
		uintptr(unsafe.Pointer(&outline[0])), uintptr(len(outline)), notchWinding)
	if rgn == 0 {
		return fmt.Errorf("CreatePolygonRgn failed for %d points", len(outline))
	}
	procSetWindowRgn.Call(uintptr(handle), rgn, 1)
	if w := notchWindowFor(handle); w != nil {
		now := time.Now().UnixMilli()
		if last := w.outlineLog.Load(); now-last > 2000 && w.outlineLog.CompareAndSwap(last, now) {
			minX, minY, maxX, maxY := outline[0].X, outline[0].Y, outline[0].X, outline[0].Y
			for _, p := range outline {
				minX, maxX = min(minX, p.X), max(maxX, p.X)
				minY, maxY = min(minY, p.Y), max(maxY, p.Y)
			}
			log.Printf("[notch] outline: %d points, box %dx%d at (%d, %d)", len(outline), maxX-minX, maxY-minY, minX, minY)
		}
	}
	return nil
}

// platformNotchFocus takes the keyboard for the page, or gives it back to the
// window that had it. It reports whether the notch has the keyboard afterwards.
func platformNotchFocus(handle unsafe.Pointer, take bool) bool {
	w := notchWindowFor(handle)
	if w == nil {
		return false
	}
	ex := getWindowLong(w.hwnd, gwlExStyle)
	if take {
		if fg, _, _ := procGetForegroundWindow.Call(); fg != 0 && fg != w.hwnd {
			w.previousFg.Store(fg)
		}
		setWindowLong(w.hwnd, gwlExStyle, ex&^wsExNoActivate)
		w.hasFocus.Store(true)
		procSetForegroundWindow.Call(w.hwnd)
		fg, _, _ := procGetForegroundWindow.Call()
		got := fg == w.hwnd
		log.Printf("[notch] keyboard asked for by the page: %v", got)
		if !got {
			// Windows refused. Go back to never taking it.
			setWindowLong(w.hwnd, gwlExStyle, ex|wsExNoActivate)
			w.hasFocus.Store(false)
		}
		return got
	}
	setWindowLong(w.hwnd, gwlExStyle, ex|wsExNoActivate)
	w.hasFocus.Store(false)
	previous := w.previousFg.Swap(0)
	returned := false
	if previous != 0 {
		if ok, _, _ := procIsWindow.Call(previous); ok != 0 {
			procSetForegroundWindow.Call(previous)
			fg, _, _ := procGetForegroundWindow.Call()
			returned = fg == previous
		}
	}
	log.Printf("[notch] keyboard given back: %v", returned)
	return false
}
