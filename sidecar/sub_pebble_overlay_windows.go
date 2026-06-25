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
	"math"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// ─────────────────────────── Right-rail layout ──────────────────────────────

// Layout geometry, the colour palette, and formatting helpers live in the
// cross-platform sub_pebble_core.go. Only the disc anchor — which depends on
// the Windows layered-window size (pebbleWindowW / pebbleAnchorY) — is defined
// here.
const (
	// Disc anchor within the 360×220 window. Right-aligned so the window can
	// extend leftward for the bubble without re-positioning the window itself.
	subPebbleAnchorX = pebbleWindowW - subPebbleRightMargin
	subPebbleAnchorY = pebbleAnchorY
)

// ─────────────────────────── Service ────────────────────────────────────────

// subPebbleEntry and the shared per-overlay run loop (eased fly-out, frame
// ticker, lifecycle) live in sub_pebble_runtime.go. This file implements the
// subPebblePlatform contract (window, message pump, paint, slot geometry).

// Global HWND → entry registry. The WndProc is a free function that the OS
// calls back into; this map lets it find the entry that owns the message.
// Sync.Map handles the tiny amount of concurrency from spawn / close races.
var subPebbleByHwnd sync.Map // hwnd uintptr -> *subPebbleEntry

// Click callback fired when the user clicks a sub-pebble disc. Set by the
// sidecar's RPC layer (registered in client.go) so the daemon hears about it.
var subPebbleClickCallback atomic.Value // func(id string)

// Open-full callback fired when the user clicks the "open full" button
// inside the bubble. Daemon spawns a panel with the full task result.
var subPebbleOpenFullCallback atomic.Value // func(id string)

// Hit-area sentinel stored on each entry so WM_LBUTTONUP can route the
// click to the right callback based on what WM_NCHITTEST resolved to.
const (
	subHitNone   int32 = 0
	subHitDisc   int32 = 1
	subHitButton int32 = 2
)

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
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
	entry.slot.Store(int32(spec.Slot))
	entry.color.Store(spec.Color)
	entry.state.Store(spec.State)
	entry.label.Store(spec.Label)
	entry.task.Store("")
	entry.result.Store("")
	// C3 — anchor to whatever monitor the cursor is on so multi-monitor
	// setups feel right (each sub-pebble stays on its spawn monitor).
	monRight, monLeft := monitorRightUnderCursor()
	entry.monitorRight.Store(int32(monRight))
	// C1 — seed the animated position from the current cursor location
	// so the new sub-pebble "flies out" toward its slot. paint() eases
	// from this start point to the slot target each frame.
	cx, cy, errC := platformGetCursorPos()
	if errC != nil {
		// Cursor unreachable — start at the slot directly. No fly-out, but
		// the disc still appears in place.
		wx, wy := s.slotPosition(entry)
		entry.curX.Store(int32(wx))
		entry.curY.Store(int32(wy))
	} else {
		// Window top-left such that disc anchor lands at cursor.
		entry.curX.Store(int32(cx - subPebbleAnchorX))
		entry.curY.Store(int32(cy - subPebbleAnchorY))
	}
	_ = monLeft
	s.items[spec.ID] = entry
	s.mu.Unlock()

	go runSubPebbleOverlay(entry, s)
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

// SetColor recolors an existing sub-pebble. Used so the daemon can swap a
// task to vermilion when it fails (since color is otherwise stable across
// lifecycle to support muscle-memory recall).
func (s *subPebbleServiceWindows) SetColor(id string, color SubPebbleColor) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("sub-pebble %q not found", id)
	}
	entry.color.Store(color)
	return nil
}

// SetExpanded toggles the click-to-inspect bubble. When expanded, the next
// paint cycle draws a paper card to the left of the disc with the supplied
// content. agent/task/result/elapsed can all be empty.
func (s *subPebbleServiceWindows) SetExpanded(id string, expanded bool, agent, task, result string, elapsedS int) error {
	s.mu.Lock()
	entry, ok := s.items[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("sub-pebble %q not found", id)
	}
	if agent != "" {
		entry.label.Store(agent)
	}
	if task != "" {
		entry.task.Store(task)
	}
	entry.result.Store(result)
	entry.elapsedS.Store(int64(elapsedS))
	entry.expanded.Store(expanded)
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
	// C2 — slot reflow. Every remaining sub-pebble whose slot was below
	// (visually further down) the closed one shifts up by one. Each
	// entry's paint loop already eases curY toward the new slot target,
	// so the visual reflow happens automatically over the next ~10 frames.
	if ok {
		closedSlot := entry.slot.Load()
		for _, other := range s.items {
			if other.slot.Load() > closedSlot {
				other.slot.Add(-1)
			}
		}
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

// OnClick registers the global callback fired when the user clicks a
// sub-pebble disc. The WndProc reads this via subPebbleClickCallback.
func (s *subPebbleServiceWindows) OnClick(callback func(id string)) {
	subPebbleClickCallback.Store(callback)
}

func (s *subPebbleServiceWindows) OnOpenFull(callback func(id string)) {
	subPebbleOpenFullCallback.Store(callback)
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

// ─────────────────────────── Platform adapter ───────────────────────────────
//
// The per-overlay loop (eased fly-out, ticker, lifecycle) lives in
// runSubPebbleOverlay (sub_pebble_runtime.go); Spawn launches it with this
// service as the subPebblePlatform. The methods below are the Win32 primitives
// it drives: createOverlayWindow / pumpMessages / paint / slotPosition /
// destroyOverlay.

// destroyOverlay unregisters the entry's window from the hit-test registry and
// destroys it. Called by the shared runtime when the overlay's loop exits.
func (s *subPebbleServiceWindows) destroyOverlay(entry *subPebbleEntry) {
	if entry.hwnd != 0 {
		subPebbleByHwnd.Delete(entry.hwnd)
		procDestroyWindow.Call(entry.hwnd)
		entry.hwnd = 0
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

// monitorRightUnderCursor returns the right edge X (and left edge X) of the
// monitor that contains the current cursor position. Used at sub-pebble
// spawn time so multi-monitor setups anchor the sub-pebble to whichever
// display the user was looking at, not always the primary. Falls back to
// the primary monitor on any error.
func monitorRightUnderCursor() (right, left int) {
	cx, cy, err := platformGetCursorPos()
	if err != nil {
		if r, _, ok := subPebbleScreenBounds(); ok {
			return r, 0
		}
		return 1920, 0
	}
	rect, ok := monitorRectFromPoint(cx, cy)
	if !ok {
		if r, _, ok := subPebbleScreenBounds(); ok {
			return r, 0
		}
		return 1920, 0
	}
	return rect.Right, rect.Left
}

// Win32 RECT for monitor info.
type monRect struct {
	Left, Top, Right, Bottom int
}

// procMonitorFromPoint + procGetMonitorInfoW from user32.
var (
	procMonitorFromPoint = pebbleUser32.NewProc("MonitorFromPoint")
	procGetMonitorInfoW  = pebbleUser32.NewProc("GetMonitorInfoW")
)

// MonitorFromPoint returns the monitor handle for the monitor containing
// the given point. dwFlags = MONITOR_DEFAULTTONEAREST = 2 — returns the
// nearest monitor when the point is between displays.
func monitorRectFromPoint(x, y int) (monRect, bool) {
	type point struct{ X, Y int32 }
	pt := point{X: int32(x), Y: int32(y)}
	const monitorDefaultToNearest = 2
	// MonitorFromPoint takes the POINT struct by value, packed into a
	// uintptr (8 bytes on x64 — both int32s fit).
	pPacked := uintptr(uint32(pt.X)) | (uintptr(uint32(pt.Y)) << 32)
	hMon, _, _ := procMonitorFromPoint.Call(pPacked, monitorDefaultToNearest)
	if hMon == 0 {
		return monRect{}, false
	}
	// MONITORINFO struct layout: cbSize, rcMonitor (Left,Top,Right,Bottom int32), rcWork, dwFlags.
	type monInfo struct {
		CbSize    uint32
		RcMonitor [4]int32
		RcWork    [4]int32
		DwFlags   uint32
	}
	mi := monInfo{}
	mi.CbSize = uint32(unsafe.Sizeof(mi))
	ok, _, _ := procGetMonitorInfoW.Call(hMon, uintptr(unsafe.Pointer(&mi)))
	if ok == 0 {
		return monRect{}, false
	}
	return monRect{
		Left:   int(mi.RcMonitor[0]),
		Top:    int(mi.RcMonitor[1]),
		Right:  int(mi.RcMonitor[2]),
		Bottom: int(mi.RcMonitor[3]),
	}, true
}

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

func (s *subPebbleServiceWindows) createOverlayWindow(entry *subPebbleEntry) error {
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

	// Phase B: drop WS_EX_TRANSPARENT so the window can catch clicks. The
	// WndProc returns HTTRANSPARENT for non-disc pixels so the rest of the
	// 360×220 frame still passes mouse events through to whatever's behind.
	exStyle := uintptr(pblWsExLayered | pblWsExTopmost | pblWsExNoActivate | pblWsExToolWindow)
	style := uintptr(pblWsPopup | pblWsVisible)

	// Initial window position — seeded from the entry's curX/curY which
	// is either at the cursor (fly-out spawn) or already at the slot
	// (fallback when cursor lookup failed). Paint loop eases toward the
	// slot target each frame from here.
	winX := int(entry.curX.Load())
	winY := int(entry.curY.Load())

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
		return fmt.Errorf("CreateWindowExW failed: %v", err)
	}

	const swpNoMove = 0x0002
	const swpNoSize = 0x0001
	const swpNoActivate = 0x0010
	const swpShowWindow = 0x0040
	procSetWindowPos.Call(hwnd, pblHwndTopmost, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)

	entry.hwnd = hwnd
	// Register HWND → entry so the shared WndProc can find this entry when the
	// OS delivers WM_NCHITTEST / WM_LBUTTONUP for this window.
	subPebbleByHwnd.Store(hwnd, entry)
	return nil
}

// slotPosition computes the top-left of a 360×220 layered window so that
// the disc (anchored at subPebbleAnchorX, subPebbleAnchorY within the
// window) lands at the right edge of the entry's spawn monitor at the
// correct vertical slot.
func (s *subPebbleServiceWindows) slotPosition(entry *subPebbleEntry) (int, int) {
	right := int(entry.monitorRight.Load())
	if right <= 0 {
		// Fallback: primary monitor right edge.
		if r, _, ok := subPebbleScreenBounds(); ok {
			right = r
		} else {
			right = 1920
		}
	}
	slot := int(entry.slot.Load())
	winX := right - subPebbleAnchorX - subPebbleRightMargin
	winY := subPebbleTopMargin + slot*subPebbleSlotSpacing - subPebbleAnchorY
	return winX, winY
}

const (
	wmNcHitTest   = 0x0084
	wmLButtonUp   = 0x0202
	htTransparent = ^uintptr(0) // -1 — tells the OS to pass the click to the window underneath
	htClient      = 1
)

// hitRadiusPx is the click hit-area radius around the disc center. Slightly
// larger than the visible disc (9 px) so users don't have to land dead-on.
const hitRadiusPx = 16

func subPebbleWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case wmNcHitTest:
		entryAny, ok := subPebbleByHwnd.Load(hwnd)
		if !ok {
			return htTransparent
		}
		entry := entryAny.(*subPebbleEntry)
		sx := int(int16(lParam & 0xFFFF))
		sy := int(int16((lParam >> 16) & 0xFFFF))
		winX, winY := liveWindowPosition(entry)
		localX := sx - winX
		localY := sy - winY

		// Bubble interactive zones (only when expanded):
		//   1. "open full" button — a small rect in the bubble's bottom-right
		//   2. anywhere else inside the bubble — generic HTCLIENT so the
		//      cursor stays grabbed (otherwise the bubble closes when the
		//      cursor leaves the disc on its way to the button).
		if entry.expanded.Load() {
			bx0, by0, bx1, by1 := subPebbleBubbleRect(entry)
			// Button is anchored to the bubble's bottom-right with a small inset.
			bxR0 := bx1 - subPebbleButtonInsetR - subPebbleButtonW
			byR0 := by1 - subPebbleButtonInsetB - subPebbleButtonH
			bxR1 := bxR0 + subPebbleButtonW
			byR1 := byR0 + subPebbleButtonH
			if localX >= bxR0 && localX <= bxR1 && localY >= byR0 && localY <= byR1 {
				entry.lastHit.Store(subHitButton)
				return htClient
			}
			if localX >= bx0 && localX <= bx1 && localY >= by0 && localY <= by1 {
				entry.lastHit.Store(subHitNone) // inside bubble but not on button — swallow click w/o action
				return htClient
			}
		}

		// Disc area.
		dx := localX - subPebbleAnchorX
		dy := localY - subPebbleAnchorY
		if dx*dx+dy*dy <= hitRadiusPx*hitRadiusPx {
			entry.lastHit.Store(subHitDisc)
			return htClient
		}
		entry.lastHit.Store(subHitNone)
		return htTransparent

	case wmLButtonUp:
		entryAny, ok := subPebbleByHwnd.Load(hwnd)
		if !ok {
			return 0
		}
		entry := entryAny.(*subPebbleEntry)
		hit := entry.lastHit.Load()
		entry.lastHit.Store(subHitNone)
		switch hit {
		case subHitDisc:
			if cbAny := subPebbleClickCallback.Load(); cbAny != nil {
				if cb, ok := cbAny.(func(string)); ok && cb != nil {
					go cb(entry.id)
				}
			}
		case subHitButton:
			if cbAny := subPebbleOpenFullCallback.Load(); cbAny != nil {
				if cb, ok := cbAny.(func(string)); ok && cb != nil {
					go cb(entry.id)
				}
			}
		}
		return 0

	case pblWmDestroy:
		// Don't PostQuitMessage here — each sub-pebble shares the
		// process-wide message loop with every other overlay.
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

// liveWindowPosition returns the LIVE rendered window top-left (curX,curY),
// not the slot target. WndProc uses this so hit-testing tracks the disc as
// it animates from cursor to slot (Phase C1). slot is read via atomic so
// it's safe from the message thread.
func liveWindowPosition(entry *subPebbleEntry) (int, int) {
	return int(entry.curX.Load()), int(entry.curY.Load())
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
	// Restore the DC's default bitmap before deleting the DIB — DeleteObject
	// fails on a selected bitmap and DeleteDC won't free it, so otherwise the
	// DIB + pixel buffer leak every frame. (See present() in
	// pebble_overlay_windows.go for the full rationale.)
	oldBmp, _, _ := procSelectObject.Call(memDC, dib)
	defer func() {
		procSelectObject.Call(memDC, oldBmp)
		procDeleteObjectGdi.Call(dib)
	}()

	pixels := unsafe.Slice((*uint32)(bits), pebbleWindowW*pebbleWindowH)
	for i := range pixels {
		pixels[i] = 0
	}

	state, _ := entry.state.Load().(PebbleState)
	color, _ := entry.color.Load().(SubPebbleColor)
	entry.frameTick++
	if entry.expanded.Load() {
		s.drawSubPebbleBubble(pixels, color, entry)
	}
	s.drawSubPebble(pixels, color, state, entry.frameTick)
	// Bubble text overlay — GDI DrawText, run after the bubble fill so
	// the glyphs sit on opaque (alpha=255) pixels. Alpha repair clamps
	// glyph alpha to 255 to match the bubble body (same trick the main
	// pebble uses).
	if entry.expanded.Load() {
		s.drawSubPebbleBubbleText(memDC, entry)
		repairSubPebbleBubbleAlpha(pixels, entry)
	}

	const acSrcOver = 0x00
	const acSrcAlpha = 0x01
	blend := pblBlendFunction{
		BlendOp:             acSrcOver,
		BlendFlags:          0,
		SourceConstantAlpha: 255,
		AlphaFormat:         acSrcAlpha,
	}
	// Position is eased toward the slot target by the shared runtime
	// (subPebbleEaseToSlot in sub_pebble_runtime.go) before each paint; here we
	// just render at the current animated position.
	winPt := pblPoint{X: entry.curX.Load(), Y: entry.curY.Load()}
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
	// Finished tasks turn green (the brand "ok" hue), mirroring the main
	// pebble's done state. Failures are recolored vermilion by the daemon.
	if state == PebbleDone {
		r, g, b = pebbleOkR, pebbleOkG, pebbleOkB
	}
	cx := float64(subPebbleAnchorX)
	cy := float64(subPebbleAnchorY)
	const dR = 11.5 // mini drop radius (grew from 9 — too small flying out)
	const sR = 4.5  // its sharp corner

	// Core intensity + glow per state, mirroring the main pebble:
	//   active (working/thinking/speaking/…) — pulse + an orbiting spinner dot
	//   done                                  — steady bright green, no motion
	//   idle                                  — dim glass
	core := 0.42
	glow := 0.0
	spinning := false
	switch state {
	case PebbleIdle:
		core = 0.40
	case PebbleDone:
		core = 0.92
		glow = 0.55
	default:
		const cycleFrames = 75
		phase := float64(tick%cycleFrames) / float64(cycleFrames)
		v := phase * 2
		if v > 1 {
			v = 2 - v
		}
		core = 0.6 + 0.4*v
		glow = 0.45
		spinning = true
	}

	// 1) glow
	if glow > 0 {
		fillRadial(pixels, cx, cy+1, dR*2.0, uint8(glow*150), r, g, b)
	}
	// 2) drop shadow
	fillDrop(pixels, cx, cy+2, dR, sR, premultiply(34, pebbleInkR, pebbleInkG, pebbleInkB))
	// 3) glass body
	fillDrop(pixels, cx, cy, dR, sR, premultiply(120, 255, 255, 255))
	// 4) colored core (clipped to the drop, tip included)
	fillDropRadial(pixels, cx, cy, dR, sR, dR, uint8(core*255), r, g, b)
	// 5) inner shine
	fillRadial(pixels, cx-dR*0.32, cy-dR*0.34, dR*0.7, 140, 255, 255, 255)
	// 6) hairline border
	strokeDrop(pixels, cx, cy, dR, sR, 1.0, premultiply(85, pebbleInkR, pebbleInkG, pebbleInkB))
	// 7) working spinner — a white dot orbiting the rim (same cue as the main
	//    pebble's thinking ring) so "still working" reads at a glance.
	if spinning {
		const spinFrames = 66
		ang := float64(tick%spinFrames) / float64(spinFrames) * 2 * math.Pi
		ox := cx + math.Cos(ang)*dR*0.66
		oy := cy + math.Sin(ang)*dR*0.66
		fillCircle(pixels, ox, oy, 1.9, premultiply(235, 255, 255, 255))
	}
}
