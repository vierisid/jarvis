//go:build windows

package main

// Win32 region-selection overlay.
//
// Strategy:
//   1. Snapshot the entire virtual screen via BitBlt BEFORE the overlay
//      appears, store as a 32-bit DIB. This gives us the pre-overlay
//      pixels so the final crop doesn't include our own selection rect.
//   2. Spawn a fullscreen layered always-on-top window covering the
//      virtual screen. NOT click-through (we need mouse events).
//   3. Paint a translucent dim layer over everything by default; while
//      dragging, cut a hole through the dim where the selection rect is
//      and outline it with a hairline.
//   4. On mouseup, crop the snapshot to the selection rect, encode PNG,
//      fire onCapture. On Esc / right-click / zero-area drag, fire
//      onCancel.

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// Win32 syscalls unique to region selection. Shared procs (GetSystemMetrics,
// SetWindowPos, etc.) are declared in panels_windows.go / pebble_*.go.
var (
	procRegionSetCursor   = pebbleUser32.NewProc("SetCursor")
	procRegionLoadCursorW = pebbleUser32.NewProc("LoadCursorW")
	procRegionBitBlt      = pebbleGdi32.NewProc("BitBlt")
)

const (
	regionIDCCross  = 32515
	regionSRCCOPY   = 0x00CC0020
	regionWmRButton = 0x0204
	regionWmKeyDown = 0x0100
	regionWmMouseMv = 0x0200
	regionWmLBtnDn  = 0x0201
	regionWmLBtnUp  = 0x0202
	regionVkEscape  = 0x1B
)

type regionSelectionWindows struct {
	mu     sync.Mutex
	active atomic.Bool
	hwnd   uintptr
	stopCh chan struct{}
	doneCh chan struct{}

	// Snapshot of the entire virtual screen taken before the overlay
	// appears, in BGRA s8 (little-endian uint32 0xAARRGGBB → BGRA bytes).
	screenshot []byte
	screenW    int
	screenH    int
	originX    int32 // virtual screen left edge
	originY    int32 // virtual screen top edge

	// Drag state
	dragMu   sync.Mutex
	dragging bool
	startX   int32
	startY   int32
	curX     int32
	curY     int32

	onCapture func([]byte, int, int)
	onCancel  func()
}

// Single global because Windows callbacks aren't easily closed over —
// we pin one active selection at a time and route messages through it.
var activeSel atomic.Pointer[regionSelectionWindows]

func NewRegionSelectionService() RegionSelectionService {
	return &regionSelectionWindows{}
}

func (s *regionSelectionWindows) Start(onCapture func([]byte, int, int), onCancel func()) error {
	if !s.active.CompareAndSwap(false, true) {
		return fmt.Errorf("region selection already in progress")
	}
	s.mu.Lock()
	s.onCapture = onCapture
	s.onCancel = onCancel
	s.stopCh = make(chan struct{})
	s.doneCh = make(chan struct{})
	s.mu.Unlock()

	// Capture the screen snapshot synchronously before showing overlay.
	if err := s.snapshotVirtualScreen(); err != nil {
		s.cleanup(false)
		return fmt.Errorf("snapshot virtual screen: %w", err)
	}

	activeSel.Store(s)
	go s.run()
	return nil
}

// snapshotVirtualScreen BitBlts the entire virtual desktop into an in-
// memory 32-bit BGRA buffer. Captured pre-overlay so the crop later
// doesn't include the selection rect.
func (s *regionSelectionWindows) snapshotVirtualScreen() error {
	xRaw, _, _ := procGetSystemMetrics.Call(uintptr(smXVirtualScreen))
	yRaw, _, _ := procGetSystemMetrics.Call(uintptr(smYVirtualScreen))
	wRaw, _, _ := procGetSystemMetrics.Call(uintptr(smCxVirtualScreen))
	hRaw, _, _ := procGetSystemMetrics.Call(uintptr(smCyVirtualScreen))
	// GetSystemMetrics returns a 32-bit signed int in the low dword of the
	// uintptr. Take it directly as int32 (matching w/h below) — the previous
	// 16-bit truncation produced a wrong origin once the virtual-screen left/top
	// edge passed +/-32768 px (e.g. several 4K monitors arranged to the left),
	// which then offset both the snapshot BitBlt and the overlay placement.
	x := int32(xRaw)
	y := int32(yRaw)
	w := int(int32(wRaw))
	h := int(int32(hRaw))
	if w <= 0 || h <= 0 {
		return fmt.Errorf("invalid virtual screen size %dx%d", w, h)
	}

	screenDC, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, screenDC)
	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	defer procDeleteDC.Call(memDC)

	bi := pblBitmapInfo{
		Header: pblBitmapInfoHeader{
			BiSize:        uint32(unsafe.Sizeof(pblBitmapInfoHeader{})),
			BiWidth:       int32(w),
			BiHeight:      -int32(h), // top-down
			BiPlanes:      1,
			BiBitCount:    32,
			BiCompression: 0,
		},
	}
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(
		memDC,
		uintptr(unsafe.Pointer(&bi)),
		0,
		uintptr(unsafe.Pointer(&bits)),
		0, 0,
	)
	if dib == 0 {
		return fmt.Errorf("CreateDIBSection failed")
	}
	// Restore the DC's default bitmap before deleting the DIB; DeleteObject
	// won't free a selected bitmap (see present() in pebble_overlay_windows.go).
	oldBmp, _, _ := procSelectObject.Call(memDC, dib)
	defer func() {
		procSelectObject.Call(memDC, oldBmp)
		procDeleteObjectGdi.Call(dib)
	}()

	// BitBlt the screen DC into our memDC.
	r, _, _ := procRegionBitBlt.Call(
		memDC, 0, 0, uintptr(int32(w)), uintptr(int32(h)),
		screenDC, uintptr(uint32(x)), uintptr(uint32(y)),
		regionSRCCOPY,
	)
	if r == 0 {
		return fmt.Errorf("BitBlt failed")
	}

	// Copy the pixels out — bits points into a DIB managed by the OS,
	// freed when we DeleteObject the DIB. We need an owned copy.
	pixels := unsafe.Slice((*byte)(bits), w*h*4)
	owned := make([]byte, len(pixels))
	copy(owned, pixels)

	s.screenshot = owned
	s.screenW = w
	s.screenH = h
	s.originX = x
	s.originY = y
	log.Printf("[region] snapshot %dx%d at origin (%d,%d), %d bytes", w, h, x, y, len(owned))
	return nil
}

func (s *regionSelectionWindows) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(s.doneCh)
	defer activeSel.Store(nil)

	className, _ := syscall.UTF16PtrFromString("JarvisRegionOverlay")
	windowName, _ := syscall.UTF16PtrFromString("JARVIS Region Select")

	hInstance, _, _ := procGetModuleHandleW.Call(0)

	wc := pblWndClassEx{
		Size:      uint32(unsafe.Sizeof(pblWndClassEx{})),
		Style:     0,
		WndProc:   syscall.NewCallback(regionWndProc),
		Instance:  hInstance,
		ClassName: className,
	}
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	exStyle := uintptr(pblWsExLayered | pblWsExTopmost | pblWsExNoActivate | pblWsExToolWindow)
	style := uintptr(pblWsPopup | pblWsVisible)

	hwnd, _, err := procCreateWindowExW.Call(
		exStyle,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		style,
		uintptr(uint32(s.originX)), uintptr(uint32(s.originY)),
		uintptr(int32(s.screenW)), uintptr(int32(s.screenH)),
		0, 0,
		hInstance, 0,
	)
	if hwnd == 0 {
		log.Printf("[region] CreateWindowExW failed: %v", err)
		s.fireCancel()
		return
	}
	s.hwnd = hwnd

	// Set crosshair cursor for the overlay.
	cursor, _, _ := procRegionLoadCursorW.Call(0, regionIDCCross)
	procRegionSetCursor.Call(cursor)

	const swpNoActivate = 0x0010
	const swpShowWindow = 0x0040
	procSetWindowPos.Call(
		hwnd, pblHwndTopmost,
		uintptr(uint32(s.originX)), uintptr(uint32(s.originY)),
		uintptr(int32(s.screenW)), uintptr(int32(s.screenH)),
		swpNoActivate|swpShowWindow,
	)

	// Initial paint (just the dim layer, no selection yet).
	s.paint()

	// Message loop — non-blocking PeekMessage so we exit promptly when
	// stopCh signals. Repaints on mouse move via direct paint() calls
	// from the WndProc.
	for {
		select {
		case <-s.stopCh:
			procDestroyWindow.Call(hwnd)
			return
		default:
		}
		s.pumpMessages()
	}
}

func (s *regionSelectionWindows) pumpMessages() {
	type msg struct {
		Hwnd    uintptr
		Message uint32
		WParam  uintptr
		LParam  uintptr
		Time    uint32
		Pt      pblPoint
		Extra   uint32
	}
	for {
		var m msg
		r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, pblPmRemove)
		if r == 0 {
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

// regionWndProc routes Win32 messages to the active selection. Only the
// fullscreen overlay window registers this proc.
func regionWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	s := activeSel.Load()
	if s == nil {
		r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
		return r
	}
	// Pull cursor coords (lParam packs x in low word, y in high word)
	mx := int32(int16(lParam & 0xFFFF))
	my := int32(int16((lParam >> 16) & 0xFFFF))
	switch msg {
	case regionWmLBtnDn:
		s.dragMu.Lock()
		s.dragging = true
		s.startX = mx
		s.startY = my
		s.curX = mx
		s.curY = my
		s.dragMu.Unlock()
		s.paint()
		return 0
	case regionWmMouseMv:
		s.dragMu.Lock()
		isDrag := s.dragging
		if isDrag {
			s.curX = mx
			s.curY = my
		}
		s.dragMu.Unlock()
		if isDrag {
			s.paint()
		}
		return 0
	case regionWmLBtnUp:
		s.dragMu.Lock()
		x0, y0, x1, y1 := s.startX, s.startY, mx, my
		s.dragging = false
		s.dragMu.Unlock()
		s.finishDrag(x0, y0, x1, y1)
		return 0
	case regionWmRButton, pblWmDestroy:
		s.fireCancel()
		s.signalStop()
		return 0
	case regionWmKeyDown:
		if int(wParam) == regionVkEscape {
			s.fireCancel()
			s.signalStop()
			return 0
		}
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

func (s *regionSelectionWindows) finishDrag(x0, y0, x1, y1 int32) {
	x, y, w, h := normalizeRegionRect(int(x0), int(y0), int(x1), int(y1))
	if regionDragTooSmall(w, h) {
		// Treat tiny drags as a cancel (likely accidental click).
		s.fireCancel()
		s.signalStop()
		return
	}
	pngBytes, capW, capH, err := s.cropToPNG(x, y, w, h)
	if err != nil {
		log.Printf("[region] crop failed: %v", err)
		s.fireCancel()
		s.signalStop()
		return
	}
	log.Printf("[region] captured %dx%d, %d PNG bytes", capW, capH, len(pngBytes))
	cb := s.onCapture
	if cb != nil {
		cb(pngBytes, capW, capH)
	}
	s.signalStop()
}

func (s *regionSelectionWindows) cropToPNG(x, y, w, h int) ([]byte, int, int, error) {
	if x < 0 {
		w += x
		x = 0
	}
	if y < 0 {
		h += y
		y = 0
	}
	if x+w > s.screenW {
		w = s.screenW - x
	}
	if y+h > s.screenH {
		h = s.screenH - y
	}
	if w <= 0 || h <= 0 {
		return nil, 0, 0, fmt.Errorf("crop rect empty after clamp")
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for row := 0; row < h; row++ {
		srcOff := ((y + row) * s.screenW * 4) + x*4
		dstOff := row * w * 4
		for col := 0; col < w; col++ {
			b := s.screenshot[srcOff+col*4+0]
			g := s.screenshot[srcOff+col*4+1]
			r := s.screenshot[srcOff+col*4+2]
			img.Pix[dstOff+col*4+0] = r
			img.Pix[dstOff+col*4+1] = g
			img.Pix[dstOff+col*4+2] = b
			img.Pix[dstOff+col*4+3] = 0xFF
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), w, h, nil
}

// paint redraws the overlay: a translucent dim covering the whole
// virtual screen, with a "hole" cut for the active selection rect and
// a hairline outline around it.
func (s *regionSelectionWindows) paint() {
	if s.hwnd == 0 {
		return
	}
	w := s.screenW
	h := s.screenH

	screenDC, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, screenDC)
	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	defer procDeleteDC.Call(memDC)

	bi := pblBitmapInfo{
		Header: pblBitmapInfoHeader{
			BiSize:        uint32(unsafe.Sizeof(pblBitmapInfoHeader{})),
			BiWidth:       int32(w),
			BiHeight:      -int32(h),
			BiPlanes:      1,
			BiBitCount:    32,
			BiCompression: 0,
		},
	}
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(
		memDC,
		uintptr(unsafe.Pointer(&bi)),
		0,
		uintptr(unsafe.Pointer(&bits)),
		0, 0,
	)
	if dib == 0 {
		return
	}
	// Restore the DC's default bitmap before deleting the DIB; DeleteObject
	// won't free a selected bitmap (see present() in pebble_overlay_windows.go).
	oldBmp, _, _ := procSelectObject.Call(memDC, dib)
	defer func() {
		procSelectObject.Call(memDC, oldBmp)
		procDeleteObjectGdi.Call(dib)
	}()

	pixels := unsafe.Slice((*uint32)(bits), w*h)

	// Default dim — premultiplied ARGB at α=110/255 ≈ 43% (semi-transparent
	// dark gray). Premultiplied: RGB = origRGB * α / 255. Origin gray ~30.
	const dimA = 110
	const dimRgb = 30
	dimPremul := uint32(dimA)<<24 | uint32(dimRgb*dimA/255)<<16 | uint32(dimRgb*dimA/255)<<8 | uint32(dimRgb*dimA/255)
	for i := range pixels {
		pixels[i] = dimPremul
	}

	// Selection rect — alpha=0 (fully transparent → user sees underlying
	// screen), with a vermilion hairline outline at α=255.
	s.dragMu.Lock()
	dragging := s.dragging
	x0, y0, x1, y1 := s.startX, s.startY, s.curX, s.curY
	s.dragMu.Unlock()
	if dragging {
		if x1 < x0 {
			x0, x1 = x1, x0
		}
		if y1 < y0 {
			y0, y1 = y1, y0
		}
		// Clamp.
		if x0 < 0 {
			x0 = 0
		}
		if y0 < 0 {
			y0 = 0
		}
		if int(x1) > w {
			x1 = int32(w)
		}
		if int(y1) > h {
			y1 = int32(h)
		}
		// Clear the rect interior.
		for row := int(y0); row < int(y1); row++ {
			rowOff := row * w
			for col := int(x0); col < int(x1); col++ {
				pixels[rowOff+col] = 0 // alpha=0, RGB=0
			}
		}
		// Vermilion outline, 2-pixel thick.
		const outlineA = 255
		outline := uint32(outlineA)<<24 |
			uint32(pebbleAccentR)<<16 |
			uint32(pebbleAccentG)<<8 |
			uint32(pebbleAccentB)
		for thick := int32(0); thick < 2; thick++ {
			tx0 := x0 + thick
			ty0 := y0 + thick
			tx1 := x1 - thick - 1
			ty1 := y1 - thick - 1
			if tx0 >= tx1 || ty0 >= ty1 {
				break
			}
			for col := int(tx0); col <= int(tx1); col++ {
				if int(ty0) >= 0 && int(ty0) < h {
					pixels[int(ty0)*w+col] = outline
				}
				if int(ty1) >= 0 && int(ty1) < h {
					pixels[int(ty1)*w+col] = outline
				}
			}
			for row := int(ty0); row <= int(ty1); row++ {
				if int(tx0) >= 0 && int(tx0) < w {
					pixels[row*w+int(tx0)] = outline
				}
				if int(tx1) >= 0 && int(tx1) < w {
					pixels[row*w+int(tx1)] = outline
				}
			}
		}
	}

	const acSrcOver = 0x00
	const acSrcAlpha = 0x01
	blend := pblBlendFunction{
		BlendOp:             acSrcOver,
		BlendFlags:          0,
		SourceConstantAlpha: 255,
		AlphaFormat:         acSrcAlpha,
	}
	winPt := pblPoint{X: s.originX, Y: s.originY}
	winSz := pblSize{CX: int32(w), CY: int32(h)}
	srcPt := pblPoint{X: 0, Y: 0}
	procUpdateLayeredWindow.Call(
		s.hwnd,
		screenDC,
		uintptr(unsafe.Pointer(&winPt)),
		uintptr(unsafe.Pointer(&winSz)),
		memDC,
		uintptr(unsafe.Pointer(&srcPt)),
		0,
		uintptr(unsafe.Pointer(&blend)),
		pblUlwAlpha,
	)
}

func (s *regionSelectionWindows) signalStop() {
	s.mu.Lock()
	if s.stopCh != nil {
		select {
		case <-s.stopCh:
		default:
			close(s.stopCh)
		}
	}
	s.mu.Unlock()
	go s.cleanup(true)
}

func (s *regionSelectionWindows) fireCancel() {
	cb := s.onCancel
	if cb != nil {
		cb()
	}
}

func (s *regionSelectionWindows) cleanup(waitDone bool) {
	if waitDone {
		<-s.doneCh
	}
	s.active.Store(false)
	s.mu.Lock()
	s.screenshot = nil
	s.onCapture = nil
	s.onCancel = nil
	s.mu.Unlock()
}

// Suppress unused-import lints (color used implicitly via image.NRGBA).
var _ = color.NRGBA{}
