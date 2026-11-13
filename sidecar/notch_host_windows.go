//go:build windows

package main

import (
	"fmt"
	"log"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	ole "github.com/go-ole/go-ole"
)

var (
	procNotchCreatePolyPolygonRgn = gdi32.NewProc("CreatePolyPolygonRgn")
	procNotchGetDpiForWindow      = user32.NewProc("GetDpiForWindow")
	procNotchGetClientRect        = user32.NewProc("GetClientRect")
	procNotchCallNtPowerInfo      = syscall.NewLazyDLL("powrprof.dll").NewProc("CallNtPowerInformation")
	procNotchGetLastInputInfo     = user32.NewProc("GetLastInputInfo")
	procNotchGetTickCount         = kernel32.NewProc("GetTickCount")
	procNotchGetCursorInfo        = user32.NewProc("GetCursorInfo")
)

const (
	notchSwHide           = 0
	notchSwShowNoActivate = 4
	// CallNtPowerInformation level and the flag a playing video sets.
	notchSystemExecutionState = 16
	notchEsDisplayRequired    = 0x00000002
	// CreatePolygonRgn fill mode.
	notchWinding = 2
	// SetWindowLongPtr index of a top-level window's owner.
	notchGwlpHwndParent = -8
)

// notchWindow is what the window's own goroutines share. One notch per
// process, so one of these.
//
// The notch is two windows on Windows. A web view can only be cut along whole
// pixels, which leaves a stair-stepped edge. So the edge is drawn by a second
// window underneath: a plain layered window that holds nothing but the black
// shape, anti-aliased, and lets every click through. The web view is cut one
// pixel inside that shape, so its own hard edge always lies on black.
type notchWindow struct {
	hwnd       uintptr
	backdrop   *notchBackdrop
	dpi        int
	loaded     atomic.Bool    // the page has loaded and may be shown
	hidden     atomic.Bool    // hidden by the fullscreen rule
	asking     atomic.Bool    // the page shows a question that waits for a yes or a no
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
// outline, creates the backdrop, and starts the fullscreen watch. It runs once
// on the window's own thread, before the page loads, while the window is
// still hidden.
func platformNotchSetUp(handle unsafe.Pointer, done <-chan struct{}) {
	if handle == nil {
		return
	}
	hwnd := uintptr(handle)

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

	w := &notchWindow{hwnd: hwnd, dpi: int(dpi)}
	backdrop, err := newNotchBackdrop(x, 0, width, height)
	if err != nil {
		// Without it the notch still works, with a hard edge.
		log.Printf("[notch] no smooth edge: %v", err)
	} else {
		w.backdrop = backdrop
		// An owned window always stays above its owner, so the web view can
		// never slip behind its own edge.
		setWindowLong(hwnd, notchGwlpHwndParent, backdrop.hwnd)
	}
	notchWin.Store(w)

	// Nothing shows until the page says what shape it is.
	_ = platformSetInteractiveRegions(handle, nil)
	procSetWindowPos.Call(hwnd, hwndTopmost,
		uintptr(int32(x)), 0, uintptr(int32(width)), uintptr(int32(height)),
		swpNoActivate)
	log.Printf("[notch] window %dx%d at (%d, 0) on a %dx%d display, dpi %d, smooth edge: %v",
		width, height, x, screenW, screenH, dpi, w.backdrop != nil)

	go w.watch(done)
}

// platformNotchTearDown runs on the window's own thread after its loop has
// ended, which is the only thread allowed to destroy the backdrop.
func platformNotchTearDown(handle unsafe.Pointer) {
	w := notchWindowFor(handle)
	if w == nil {
		return
	}
	notchWin.CompareAndSwap(w, nil)
	if w.backdrop != nil {
		w.backdrop.destroy()
	}
}

// platformNotchReveal is called once the page has loaded. The window is shown
// without taking the keyboard, unless the fullscreen rule is hiding it.
func platformNotchReveal(handle unsafe.Pointer) {
	w := notchWindowFor(handle)
	if w == nil {
		return
	}
	w.loaded.Store(true)
	// A page that has just loaded is asking nothing yet. (A page that was
	// asking when it went away never said it had stopped.)
	w.asking.Store(false)
	if !w.hidden.Load() {
		w.show()
	}
	log.Printf("[notch] page loaded, window shown without focus")
}

// platformNotchAsking is the page saying whether it shows a question that
// waits for an answer. A notch hidden for a fullscreen video comes back at
// once for one; the watch hides it again when the question is gone and the
// video is still playing.
func platformNotchAsking(handle unsafe.Pointer, asking bool) {
	w := notchWindowFor(handle)
	if w == nil {
		return
	}
	if w.asking.Swap(asking) == asking || !asking {
		return
	}
	if w.hidden.CompareAndSwap(true, false) {
		if w.loaded.Load() {
			w.show()
		}
		log.Printf("[notch] shown again over a fullscreen video: it has a question that waits for an answer")
	}
}

func (w *notchWindow) show() {
	if w.backdrop != nil {
		w.backdrop.setVisible(true)
	}
	procShowWindow.Call(w.hwnd, notchSwShowNoActivate)
	procSetWindowPos.Call(w.hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

func (w *notchWindow) hide() {
	procShowWindow.Call(w.hwnd, notchSwHide)
	if w.backdrop != nil {
		w.backdrop.setVisible(false)
	}
}

// watch applies the fullscreen rule twice a second, and notes in the log when
// the notch holds the keyboard without having asked for it: that is the fault
// the window exists to avoid, so a test run should leave a trace of it.
func (w *notchWindow) watch(done <-chan struct{}) {
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	stoleFocus := false
	first := true
	var (
		video      notchVideoWatch
		sampler    notchScreenSampler
		sampleFail bool
		soundFail  bool
		looks      int // looks at the fullscreen app now in front
	)
	defer sampler.release()
	// Asking which programs play sound goes through COM, which belongs to a
	// thread. This goroutine keeps one for as long as the notch is open.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	canAskSound := true
	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err == nil {
		defer ole.CoUninitialize()
	} else if oe, ok := err.(*ole.OleError); ok && oe.Code() == 1 {
		// Already started on this thread: usable, and still to be balanced.
		defer ole.CoUninitialize()
	} else if ok && oe.Code() == 0x80010106 {
		// Started in the other mode by someone else: usable as it is.
	} else {
		canAskSound = false
		log.Printf("[notch] cannot ask which programs play sound (%v); a video that does not move will keep the notch", err)
	}
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
		}
		if ok, _, _ := procIsWindow.Call(w.hwnd); ok == 0 {
			return
		}
		fullscreen := fullscreenAppCovers(w.hwnd)
		awake := displayKeptAwake()
		if first {
			first = false
			// Worth a line: if this is true with no video playing, some other
			// program holds the display, and on this machine the picture
			// alone decides whether a fullscreen app is showing a video.
			log.Printf("[notch] at start, display kept awake: %v", awake)
		}
		program, class := "", ""
		if fullscreen {
			program, class = notchForeground()
			if notchIsCaptureOverlay(program) {
				// A screen capture in progress: the notch stays as it was.
				continue
			}
		}
		// The picture is only looked at when the first two conditions hold:
		// on a machine where nothing holds the display, the screen is never
		// read at all.
		playing := false
		if fullscreen && awake {
			signs := notchVideoSigns{handsOff: notchIdleMs() >= notchInputGraceMs}
			signs.pointerHidden, signs.pointerElsewhere = notchPointerState(w.hwnd)
			if sample, ok := sampler.take(w.hwnd); ok {
				signs.change = video.change(sample)
			} else if !sampleFail {
				sampleFail = true
				log.Printf("[notch] could not read the screen; a muted video will keep the notch")
			}
			if canAskSound {
				if programs, err := notchProgramsPlayingSound(); err == nil {
					signs.appSound = notchAppPlaysSound(program, programs)
				} else if !soundFail {
					soundFail = true
					log.Printf("[notch] could not ask which programs play sound: %v", err)
				}
			}
			playing = video.observe(signs)
			// What was seen, so a test run can be read afterwards: every two
			// seconds for the first twenty, then once a minute.
			looks++
			if (looks <= 50 && looks%5 == 1) || looks%150 == 0 {
				log.Printf("[notch] looking at %s: hands off %v, pointer hidden %v (elsewhere %v), app sound %v, picture change %.3f, video %v",
					program, signs.handsOff, signs.pointerHidden, signs.pointerElsewhere, signs.appSound, signs.change, playing)
			}
		} else {
			video.reset()
			looks = 0
		}
		hide := notchShouldHide(fullscreen, awake, playing, w.asking.Load())
		if hide != w.hidden.Load() {
			w.hidden.Store(hide)
			if hide {
				w.hide()
				log.Printf("[notch] hidden: a video is playing in a fullscreen app (%s, window class %s)", program, class)
			} else {
				if w.loaded.Load() {
					w.show()
				}
				log.Printf("[notch] shown again (fullscreen app in front: %v, display kept awake: %v, video: %v)", fullscreen, awake, playing)
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

// notchForeground names the window in front by its program's file name and
// its window class. It is for the log, and for telling a screen capture apart
// from a fullscreen app. The window's title is left out on purpose.
func notchForeground() (program, class string) {
	fg, _, _ := procGetForegroundWindow.Call()
	if fg == 0 {
		return "", ""
	}
	var buf [256]uint16
	procGetClassNameW.Call(fg, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return processBaseName(win32GetWindowPid(fg)), syscall.UTF16ToString(buf[:])
}

// notchLastInput mirrors Win32 LASTINPUTINFO.
type notchLastInput struct {
	cbSize uint32
	dwTime uint32
}

// notchIdleMs is how long ago the person last touched the mouse or keyboard,
// in milliseconds. A failure reads as "just now", which keeps the notch.
func notchIdleMs() uint32 {
	li := notchLastInput{}
	li.cbSize = uint32(unsafe.Sizeof(li))
	if ok, _, _ := procNotchGetLastInputInfo.Call(uintptr(unsafe.Pointer(&li))); ok == 0 {
		return 0
	}
	now, _, _ := procNotchGetTickCount.Call()
	return uint32(now) - li.dwTime
}

// notchCursorInfo mirrors Win32 CURSORINFO.
type notchCursorInfo struct {
	cbSize  uint32
	flags   uint32
	hCursor uintptr
	pos     w32Point
}

// notchPointerState says what the mouse pointer tells about the app in front.
// hidden: the pointer is on the notch's display and is not being drawn, which
// is what a player does once the hand is off the mouse and a page never does.
// elsewhere: the pointer is on another display and tells nothing. A failure
// reads as a pointer in plain view, which keeps the notch.
func notchPointerState(hwnd uintptr) (hidden, elsewhere bool) {
	ci := notchCursorInfo{}
	ci.cbSize = uint32(unsafe.Sizeof(ci))
	if ok, _, _ := procNotchGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); ok == 0 {
		return false, false
	}
	monitor, _, _ := procPanelMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
	mi := panelMonitorInfo{}
	mi.cbSize = uint32(unsafe.Sizeof(mi))
	if ok, _, _ := procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&mi))); monitor == 0 || ok == 0 {
		return false, false
	}
	m := mi.rcMonitor
	if ci.pos.X < m.Left || ci.pos.X >= m.Right || ci.pos.Y < m.Top || ci.pos.Y >= m.Bottom {
		return false, true
	}
	// An app hides the pointer either by turning it off or by setting none.
	const cursorShowing = 0x1
	return ci.flags&cursorShowing == 0 || ci.hCursor == 0, false
}

// notchScreenSampler reads a grid of colours from the middle of the notch's
// display, for notchVideoWatch. It copies the middle quarter of the screen in
// one call and picks the grid out of that: on the machine this was measured
// on, every read of the screen cost about 7 ms whatever its size, so one read
// of an area is far cheaper than a read per point. The pixels never leave this
// function except as the grid, and the grid never leaves the process.
type notchScreenSampler struct {
	memDC, dib, oldBmp uintptr
	bits               unsafe.Pointer
	w, h               int32
	out                []uint32
}

func (s *notchScreenSampler) release() {
	if s.memDC != 0 {
		procSelectObject.Call(s.memDC, s.oldBmp)
		procDeleteObjectGdi.Call(s.dib)
		procDeleteDC.Call(s.memDC)
	}
	s.memDC, s.dib, s.oldBmp, s.bits, s.w, s.h = 0, 0, 0, nil, 0, 0
}

// take returns the grid for the display hwnd is on. The slice is reused by the
// next call.
func (s *notchScreenSampler) take(hwnd uintptr) ([]uint32, bool) {
	monitor, _, _ := procPanelMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
	if monitor == 0 {
		return nil, false
	}
	mi := panelMonitorInfo{}
	mi.cbSize = uint32(unsafe.Sizeof(mi))
	if ok, _, _ := procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&mi))); ok == 0 {
		return nil, false
	}
	m := mi.rcMonitor
	width, height := (m.Right-m.Left)/2, (m.Bottom-m.Top)/2
	if width < notchSampleCols || height < notchSampleRows {
		return nil, false
	}
	screenDC, _, _ := procGetDC.Call(0)
	if screenDC == 0 {
		return nil, false
	}
	defer procReleaseDC.Call(0, screenDC)
	if s.memDC == 0 || s.w != width || s.h != height {
		s.release()
		memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
		bi := pblBitmapInfo{
			Header: pblBitmapInfoHeader{
				BiSize:     uint32(unsafe.Sizeof(pblBitmapInfoHeader{})),
				BiWidth:    width,
				BiHeight:   -height,
				BiPlanes:   1,
				BiBitCount: 32,
			},
		}
		var bits unsafe.Pointer
		dib, _, _ := procCreateDIBSection.Call(memDC, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
		if memDC == 0 || dib == 0 || bits == nil {
			if memDC != 0 {
				procDeleteDC.Call(memDC)
			}
			return nil, false
		}
		s.oldBmp, _, _ = procSelectObject.Call(memDC, dib)
		s.memDC, s.dib, s.bits, s.w, s.h = memDC, dib, bits, width, height
	}
	const srcCopy = 0x00CC0020
	left, top := m.Left+width/2, m.Top+height/2
	if ok, _, _ := procBitBlt.Call(s.memDC, 0, 0, uintptr(width), uintptr(height),
		screenDC, uintptr(left), uintptr(top), srcCopy); ok == 0 {
		return nil, false
	}
	pixels := unsafe.Slice((*uint32)(s.bits), int(width)*int(height))
	s.out = s.out[:0]
	for row := 0; row < notchSampleRows; row++ {
		y := (2*row + 1) * int(height) / (2 * notchSampleRows)
		for col := 0; col < notchSampleCols; col++ {
			x := (2*col + 1) * int(width) / (2 * notchSampleCols)
			s.out = append(s.out, pixels[y*int(width)+x]&0x00ffffff)
		}
	}
	return s.out, true
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

// platformNotchCursor is where the pointer is, in the page's own pixels,
// measured from the window's top left corner. It can be far outside the window.
func platformNotchCursor(handle unsafe.Pointer) (int, int, bool, bool) {
	w := notchWindowFor(handle)
	if w == nil || w.dpi <= 0 {
		return 0, 0, false, false
	}
	cx, cy, err := platformGetCursorPos()
	if err != nil {
		return 0, 0, false, false
	}
	var r w32Rect
	if ok, _, _ := procGetWindowRect.Call(w.hwnd, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return 0, 0, false, false
	}
	// The main button is the left one unless the person swapped them.
	const vkLeft, vkRight, smSwapButton = 0x01, 0x02, 23
	button := uintptr(vkLeft)
	if swapped, _, _ := procGetSystemMetrics.Call(smSwapButton); swapped != 0 {
		button = vkRight
	}
	state, _, _ := procGetAsyncKeyState.Call(button)
	down := state&0x8000 != 0
	return (cx - int(r.Left)) * 96 / w.dpi, (cy - int(r.Top)) * 96 / w.dpi, down, true
}

// platformNotchSetOutline draws the silhouette and cuts the web view. shapes
// is the notch's true silhouette, drawn smooth by the backdrop. cuts is the
// same a little way in, which is where the web view ends. Windows owns the
// region after SetWindowRgn, so nothing is freed here.
func platformNotchSetOutline(handle unsafe.Pointer, shapes [][]notchVertex, cuts [][]notchPoint) error {
	if handle == nil {
		return fmt.Errorf("nil HWND")
	}
	w := notchWindowFor(handle)
	if w != nil && w.backdrop != nil {
		if err := w.backdrop.paint(shapes); err != nil {
			log.Printf("[notch] smooth edge not drawn: %v", err)
		}
	} else {
		// No backdrop: the web view carries the whole shape, hard edge and all.
		cuts = make([][]notchPoint, len(shapes))
		for i, shape := range shapes {
			cuts[i] = notchWhole(shape)
		}
	}
	// One region for all the polygons, joined where they overlap.
	points := make([]notchPoint, 0, 128)
	counts := make([]int32, 0, len(cuts))
	for _, cut := range cuts {
		if len(cut) < notchOutlineMinPoints {
			continue
		}
		points = append(points, cut...)
		counts = append(counts, int32(len(cut)))
	}
	var rgn uintptr
	if len(counts) == 0 {
		// Nothing has an inside: the web view shows nothing, the backdrop all.
		rgn, _, _ = procCreateRectRgn.Call(0, 0, 0, 0)
	} else {
		rgn, _, _ = procNotchCreatePolyPolygonRgn.Call(
			uintptr(unsafe.Pointer(&points[0])), uintptr(unsafe.Pointer(&counts[0])),
			uintptr(len(counts)), notchWinding)
	}
	if rgn == 0 {
		return fmt.Errorf("the window region could not be made for %d polygons", len(counts))
	}
	procSetWindowRgn.Call(uintptr(handle), rgn, 1)
	if w != nil {
		now := time.Now().UnixMilli()
		if last := w.outlineLog.Load(); now-last > 2000 && w.outlineLog.CompareAndSwap(last, now) {
			total := 0
			var minX, minY, maxX, maxY float64
			if len(shapes) > 0 {
				minX, minY, maxX, maxY = shapes[0][0].X, shapes[0][0].Y, shapes[0][0].X, shapes[0][0].Y
			}
			for _, shape := range shapes {
				total += len(shape)
				for _, p := range shape {
					minX, maxX = min(minX, p.X), max(maxX, p.X)
					minY, maxY = min(minY, p.Y), max(maxY, p.Y)
				}
			}
			log.Printf("[notch] outline: %d polygons, %d points, box %.1fx%.1f at (%.1f, %.1f)", len(shapes), total, maxX-minX, maxY-minY, minX, minY)
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

// ── the backdrop: the notch's shape, drawn smooth ───────────────────────────

type notchBackdrop struct {
	hwnd   uintptr
	x, y   int32
	w, h   int32
	memDC  uintptr
	dib    uintptr
	oldBmp uintptr
	pixels []uint32
	cover  []uint8
}

func notchBackdropWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

var notchBackdropProc = syscall.NewCallback(notchBackdropWndProc)

// newNotchBackdrop creates the window hidden. It belongs to the calling
// thread, which must be the one that runs the notch's message loop.
func newNotchBackdrop(x, y, width, height int) (*notchBackdrop, error) {
	className, _ := syscall.UTF16PtrFromString("JarvisNotchBackdrop")
	windowName, _ := syscall.UTF16PtrFromString("Jarvis")
	hInstance, _, _ := procGetModuleHandleW.Call(0)
	wc := pblWndClassEx{
		Size:      uint32(unsafe.Sizeof(pblWndClassEx{})),
		WndProc:   notchBackdropProc,
		Instance:  hInstance,
		ClassName: className,
	}
	// ERROR_CLASS_ALREADY_EXISTS is fine on re-registration.
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	// Transparent to the mouse as a whole: it is only a picture of the edge.
	exStyle := uintptr(pblWsExLayered | pblWsExTransparent | pblWsExTopmost | pblWsExNoActivate | pblWsExToolWindow)
	hwnd, _, err := procCreateWindowExW.Call(
		exStyle,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		uintptr(pblWsPopup),
		uintptr(uint32(int32(x))), uintptr(uint32(int32(y))),
		uintptr(uint32(int32(width))), uintptr(uint32(int32(height))),
		0, 0, hInstance, 0,
	)
	if hwnd == 0 {
		return nil, fmt.Errorf("CreateWindowExW failed: %v", err)
	}

	screenDC, _, _ := procGetDC.Call(0)
	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	procReleaseDC.Call(0, screenDC)
	bi := pblBitmapInfo{
		Header: pblBitmapInfoHeader{
			BiSize:     uint32(unsafe.Sizeof(pblBitmapInfoHeader{})),
			BiWidth:    int32(width),
			BiHeight:   -int32(height),
			BiPlanes:   1,
			BiBitCount: 32,
		},
	}
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(memDC, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if memDC == 0 || dib == 0 || bits == nil {
		if memDC != 0 {
			procDeleteDC.Call(memDC)
		}
		procDestroyWindow.Call(hwnd)
		return nil, fmt.Errorf("CreateDIBSection failed for %dx%d", width, height)
	}
	oldBmp, _, _ := procSelectObject.Call(memDC, dib)
	return &notchBackdrop{
		hwnd: hwnd, x: int32(x), y: int32(y), w: int32(width), h: int32(height),
		memDC: memDC, dib: dib, oldBmp: oldBmp,
		pixels: unsafe.Slice((*uint32)(bits), width*height),
		cover:  make([]uint8, width*height),
	}, nil
}

// paint draws the silhouette as anti-aliased black and hands it to the window.
// Black with premultiplied alpha is just the alpha, so coverage is the pixel.
func (b *notchBackdrop) paint(shapes [][]notchVertex) error {
	notchCoverage(b.cover, int(b.w), int(b.h), shapes)
	for i, c := range b.cover {
		b.pixels[i] = uint32(c) << 24
	}
	const acSrcOver, acSrcAlpha = 0x00, 0x01
	blend := pblBlendFunction{BlendOp: acSrcOver, SourceConstantAlpha: 255, AlphaFormat: acSrcAlpha}
	winPt := pblPoint{X: b.x, Y: b.y}
	winSz := pblSize{CX: b.w, CY: b.h}
	srcPt := pblPoint{}
	screenDC, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, screenDC)
	r, _, _ := procUpdateLayeredWindow.Call(b.hwnd, screenDC,
		uintptr(unsafe.Pointer(&winPt)), uintptr(unsafe.Pointer(&winSz)),
		b.memDC, uintptr(unsafe.Pointer(&srcPt)), 0,
		uintptr(unsafe.Pointer(&blend)), pblUlwAlpha)
	if r == 0 {
		return fmt.Errorf("UpdateLayeredWindow failed")
	}
	return nil
}

func (b *notchBackdrop) setVisible(visible bool) {
	if visible {
		procShowWindow.Call(b.hwnd, notchSwShowNoActivate)
		procSetWindowPos.Call(b.hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	} else {
		procShowWindow.Call(b.hwnd, notchSwHide)
	}
}

func (b *notchBackdrop) destroy() {
	procSelectObject.Call(b.memDC, b.oldBmp)
	procDeleteObjectGdi.Call(b.dib)
	procDeleteDC.Call(b.memDC)
	procDestroyWindow.Call(b.hwnd)
	b.pixels, b.cover = nil, nil
}
