//go:build windows

package main

// Native sub-pebble overlay — Windows.
//
// Phase A: one layered window per sub-pebble, anchored at a fixed slot on
// the right edge of the primary monitor. Reuses the main pebble's layered-
// window + GDI+ + UpdateLayeredWindow pipeline (see pebble_overlay_windows.go
// and pebble_draw_windows.go), differing in:
//   - position is static (no cursor follow)
//   - the disc is anchored on the RIGHT side of the same 360×220 window so
//     it lands at a controlled distance from the screen edge
//   - per-pebble color tint
//   - no bubble (Phase B)
//   - no hotkey
//   - many instances, addressed by ID
//
// Memory: each overlay holds its own DIB (~316 KB). 8 simultaneous
// sub-pebbles ≈ 2.5 MB — acceptable.

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// ─────────────────────────── Right-rail layout ──────────────────────────────

const (
	// subPebbleRightMargin is the distance from the disc's centre to the
	// right edge of the primary monitor. Tightens "this lives on the rail"
	// without clipping the disc against the bezel.
	subPebbleRightMargin = 22

	// subPebbleTopMargin / subPebbleSlotSpacing decide the vertical layout.
	// Slot 0 sits subPebbleTopMargin px from the top; subsequent slots
	// step down by subPebbleSlotSpacing.
	subPebbleTopMargin   = 96
	subPebbleSlotSpacing = 42

	// Disc anchor within the 360×220 window. Right-aligned so the window
	// can extend leftward for a future bubble without re-positioning the
	// window itself.
	subPebbleAnchorX = pebbleWindowW - subPebbleRightMargin
	subPebbleAnchorY = pebbleAnchorY
)

// ─────────────────────────── Color palette ──────────────────────────────────

// subPebbleRGB returns the (R,G,B) accent for a given palette colour. Each
// is hand-picked to look right against the paper-toned disc + ink border.
func subPebbleRGB(c SubPebbleColor) (r, g, b uint8) {
	switch c {
	case SubPebbleSage:
		return 0x4A, 0x7C, 0x3F
	case SubPebbleViolet:
		return 0x6E, 0x53, 0x9C
	case SubPebbleVermilion:
		return 0xC2, 0x3A, 0x2A
	case SubPebbleMustard:
		return 0xB7, 0x8A, 0x1E
	case SubPebbleTeal:
		return 0x2E, 0x7A, 0x82
	case SubPebbleAmber:
		fallthrough
	default:
		return 0xE5, 0xA9, 0x1E
	}
}

// ─────────────────────────── Service ────────────────────────────────────────

type subPebbleEntry struct {
	id      string
	color   SubPebbleColor
	state   atomic.Value // PebbleState
	label   atomic.Value // string
	slot    int
	hwnd    uintptr
	stopCh  chan struct{}
	doneCh  chan struct{}
	frameTick uint64
}

type subPebbleServiceWindows struct {
	mu    sync.Mutex
	items map[string]*subPebbleEntry
}

// NewSubPebbleService returns the Windows-native multi-overlay service.
func NewSubPebbleService() SubPebbleService {
	return &subPebbleServiceWindows{
		items: make(map[string]*subPebbleEntry),
	}
}

func (s *subPebbleServiceWindows) Spawn(spec SubPebbleSpec) error {
	if spec.ID == "" {
		return fmt.Errorf("sub_pebble.spawn: id is required")
	}
	s.mu.Lock()
	if _, exists := s.items[spec.ID]; exists {
		s.mu.Unlock()
		return nil // already spawned — idempotent
	}
	if spec.State == "" {
		spec.State = PebbleWorking
	}
	entry := &subPebbleEntry{
		id:     spec.ID,
		color:  spec.Color,
		slot:   spec.Slot,
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
	entry.state.Store(spec.State)
	entry.label.Store(spec.Label)
	s.items[spec.ID] = entry
	s.mu.Unlock()

	go s.runOverlay(entry)
	log.Printf("[sub-pebble] spawned id=%s color=%s slot=%d state=%s", spec.ID, spec.Color, spec.Slot, spec.State)
	return nil
}

func (s *subPebbleServiceWindows) SetState(id string, state PebbleState) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("sub-pebble %q not found", id)
	}
	entry.state.Store(state)
	return nil
}

func (s *subPebbleServiceWindows) SetLabel(id string, label string) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("sub-pebble %q not found", id)
	}
	entry.label.Store(label)
	return nil
}

func (s *subPebbleServiceWindows) Close(id string) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	if ok {
		delete(s.items, id)
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	close(entry.stopCh)
	<-entry.doneCh
	log.Printf("[sub-pebble] closed id=%s", id)
	return nil
}

func (s *subPebbleServiceWindows) CloseAll() error {
	s.mu.Lock()
	ids := make([]string, 0, len(s.items))
	for id := range s.items {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		_ = s.Close(id)
	}
	return nil
}

// ─────────────────────────── Per-overlay loop ───────────────────────────────

// runOverlay owns one layered window for one sub-pebble. Locked to its own
// OS thread because Win32 layered windows + GDI+ contexts are thread-affine.
func (s *subPebbleServiceWindows) runOverlay(entry *subPebbleEntry) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(entry.doneCh)

	hwnd, err := s.createOverlayWindow(entry)
	if err != nil {
		log.Printf("[sub-pebble] createWindow id=%s failed: %v", entry.id, err)
		return
	}
	entry.hwnd = hwnd
	defer func() {
		procDestroyWindow.Call(hwnd)
		entry.hwnd = 0
	}()

	if err := s.paint(entry); err != nil {
		log.Printf("[sub-pebble] initial paint id=%s: %v", entry.id, err)
	}

	frame := time.NewTicker(16 * time.Millisecond)
	defer frame.Stop()

	for {
		select {
		case <-entry.stopCh:
			return
		case <-frame.C:
			s.pumpMessages()
			if err := s.paint(entry); err != nil {
				log.Printf("[sub-pebble] paint id=%s: %v", entry.id, err)
			}
		}
	}
}

func (s *subPebbleServiceWindows) pumpMessages() {
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

// ─────────────────────────── Window creation ────────────────────────────────

// subPebbleScreenBounds returns the primary monitor's right edge + top.
// We anchor to the primary monitor so the rail is predictable across
// multi-monitor setups (the user can re-anchor later via a setting).
func subPebbleScreenBounds() (right, top int, ok bool) {
	// GetSystemMetrics(SM_CXSCREEN, SM_CYSCREEN) returns primary monitor
	// dims. (SM_CXVIRTUALSCREEN is the entire virtual canvas — too wide
	// when external monitors are attached.)
	const smCxScreen = 0
	const smCyScreen = 1
	w, _, _ := procGetSystemMetrics.Call(uintptr(smCxScreen))
	if w == 0 {
		return 0, 0, false
	}
	return int(int32(w)), 0, true
}

func (s *subPebbleServiceWindows) createOverlayWindow(entry *subPebbleEntry) (uintptr, error) {
	// Per-instance class isn't needed — Win32 allows N windows of the same
	// class. Use a sub-pebble-specific class so messages don't get confused
	// with the main pebble's class.
	className, _ := syscall.UTF16PtrFromString("JarvisSubPebbleOverlay")
	windowName, _ := syscall.UTF16PtrFromString("JARVIS sub-agent")

	hInstance, _, _ := procGetModuleHandleW.Call(0)

	wc := pblWndClassEx{
		Size:      uint32(unsafe.Sizeof(pblWndClassEx{})),
		Style:     0,
		WndProc:   syscall.NewCallback(subPebbleWndProc),
		Instance:  hInstance,
		ClassName: className,
	}
	// ERROR_CLASS_ALREADY_EXISTS is fine on re-registration.
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	exStyle := uintptr(pblWsExLayered | pblWsExTransparent | pblWsExTopmost | pblWsExNoActivate | pblWsExToolWindow)
	style := uintptr(pblWsPopup | pblWsVisible)

	// Initial window position — compute once at create time so the window
	// appears at the right slot immediately. Subsequent paints don't move
	// the window; the slot is fixed for the sub-pebble's lifetime (Phase A).
	winX, winY := s.slotPosition(entry.slot)

	hwnd, _, err := procCreateWindowExW.Call(
		exStyle,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		style,
		uintptr(uint32(int32(winX))),
		uintptr(uint32(int32(winY))),
		uintptr(uint32(pebbleWindowW)),
		uintptr(uint32(pebbleWindowH)),
		0, 0,
		hInstance,
		0,
	)
	if hwnd == 0 {
		return 0, fmt.Errorf("CreateWindowExW failed: %v", err)
	}

	const swpNoMove = 0x0002
	const swpNoSize = 0x0001
	const swpNoActivate = 0x0010
	const swpShowWindow = 0x0040
	procSetWindowPos.Call(hwnd, pblHwndTopmost, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)

	return hwnd, nil
}

// slotPosition computes the top-left of a 360×220 layered window so that
// the disc (anchored at subPebbleAnchorX, subPebbleAnchorY within the
// window) lands at the right edge of the primary monitor at the correct
// vertical slot.
func (s *subPebbleServiceWindows) slotPosition(slot int) (int, int) {
	right, _, ok := subPebbleScreenBounds()
	if !ok {
		// Fallback: anchor to a reasonable default.
		right = 1920
	}
	winX := right - subPebbleAnchorX - subPebbleRightMargin
	winY := subPebbleTopMargin + slot*subPebbleSlotSpacing - subPebbleAnchorY
	return winX, winY
}

func subPebbleWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	if msg == pblWmDestroy {
		// Don't PostQuitMessage here — each sub-pebble shares the
		// process-wide message loop with every other overlay. We just
		// let DefWindowProc handle it; the goroutine exits via its
		// stopCh, which is the source of truth for lifecycle.
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

// ─────────────────────────── Paint pipeline ─────────────────────────────────

// paint renders the sub-pebble's current state to a 32-bit ARGB DIB and
// hands it to UpdateLayeredWindow. Same blend setup as the main pebble.
func (s *subPebbleServiceWindows) paint(entry *subPebbleEntry) error {
	screenDC, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, screenDC)
	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	defer procDeleteDC.Call(memDC)

	bi := pblBitmapInfo{
		Header: pblBitmapInfoHeader{
			BiSize:        uint32(unsafe.Sizeof(pblBitmapInfoHeader{})),
			BiWidth:       pebbleWindowW,
			BiHeight:      -pebbleWindowH,
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
	defer procDeleteObjectGdi.Call(dib)
	procSelectObject.Call(memDC, dib)

	pixels := unsafe.Slice((*uint32)(bits), pebbleWindowW*pebbleWindowH)
	for i := range pixels {
		pixels[i] = 0
	}

	state, _ := entry.state.Load().(PebbleState)
	entry.frameTick++
	s.drawSubPebble(pixels, entry.color, state, entry.frameTick)

	const acSrcOver = 0x00
	const acSrcAlpha = 0x01
	blend := pblBlendFunction{
		BlendOp:             acSrcOver,
		BlendFlags:          0,
		SourceConstantAlpha: 255,
		AlphaFormat:         acSrcAlpha,
	}
	winPt := pblPoint{X: 0, Y: 0} // ignored when SWP_NOMOVE-style flag set
	// We still must pass winPt to UpdateLayeredWindow; values are honored
	// (ULW does NOT have a "no move" flag). Recompute from the slot so a
	// future "re-flow on close" can move the window by tweaking slot.
	wx, wy := s.slotPosition(entry.slot)
	winPt.X = int32(wx)
	winPt.Y = int32(wy)
	winSz := pblSize{CX: pebbleWindowW, CY: pebbleWindowH}
	srcPt := pblPoint{X: 0, Y: 0}

	r, _, _ := procUpdateLayeredWindow.Call(
		entry.hwnd,
		screenDC,
		uintptr(unsafe.Pointer(&winPt)),
		uintptr(unsafe.Pointer(&winSz)),
		memDC,
		uintptr(unsafe.Pointer(&srcPt)),
		0,
		uintptr(unsafe.Pointer(&blend)),
		pblUlwAlpha,
	)
	if r == 0 {
		return fmt.Errorf("UpdateLayeredWindow failed")
	}
	return nil
}

// drawSubPebble renders the colored disc at (subPebbleAnchorX, subPebbleAnchorY).
// State-driven visual:
//   - working / listening / thinking / speaking — pulsing colored disc
//   - idle — dim colored disc, no pulse
//   - the disc itself uses the color's tint as a thin ring + a soft fill;
//     a small center dot uses the saturated color so it reads as "this is X"
//     against any desktop.
func (s *subPebbleServiceWindows) drawSubPebble(pixels []uint32, color SubPebbleColor, state PebbleState, tick uint64) {
	r, g, b := subPebbleRGB(color)
	cx := float64(subPebbleAnchorX)
	cy := float64(subPebbleAnchorY)
	const discR = 9.0
	const dotR = 3.0
	const shadowOffset = 2.0

	// 1) Hard offset shadow — disc shape, ink at 10% alpha.
	fillCircle(pixels, cx+shadowOffset, cy+shadowOffset, discR,
		premultiply(28, pebbleInkR, pebbleInkG, pebbleInkB))

	// 2) Paper disc fill.
	fillCircle(pixels, cx, cy, discR,
		premultiply(255, pebblePaperR, pebblePaperG, pebblePaperB))

	// 3) Tinted hairline border — the color's saturated tone at 70% alpha
	//    so the ring reads as "this is the X agent" without competing
	//    with the centre dot.
	strokeCircle(pixels, cx, cy, discR, 1.0,
		premultiply(178, r, g, b))

	// 4) Centre dot — saturated color. Pulsing breath while active; flat
	//    50% alpha when idle.
	var alpha uint8 = 255
	switch state {
	case PebbleIdle:
		alpha = 110
	case PebbleWorking, PebbleListening, PebbleThinking, PebbleSpeaking:
		// 1.2s cycle, 60%–100% — faster than the main pebble's idle
		// breath so "actively working" reads at a glance.
		const cycleFrames = 75
		phase := float64(tick%cycleFrames) / float64(cycleFrames)
		// triangle wave from 0..1..0
		v := phase * 2
		if v > 1 {
			v = 2 - v
		}
		alpha = uint8(153 + 102*v)
	}
	fillCircle(pixels, cx, cy, dotR, premultiply(alpha, r, g, b))
}
