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

	// Phase B — bubble dimensions and offset. The bubble is a paper card
	// that appears to the LEFT of the disc when the sub-pebble is expanded.
	// Stacks vertically with: agent name eyebrow, task line, elapsed,
	// optional result. Width is generous enough to read a sentence-length
	// task; height tall enough for a 3-line clamp on the result.
	subPebbleBubbleW       = 230
	subPebbleBubbleH       = 130
	subPebbleBubbleOffset  = 14 // gap between disc edge and bubble's right edge
	subPebbleBubbleAnchorY = 20 // top of bubble relative to disc's y axis (-20 = bubble starts 20 px above disc center)

	// "open full" button — Phase B+ click target inside the bubble that
	// spawns a native window with the full task result. Anchored to the
	// bubble's bottom-right.
	subPebbleButtonW      = 92
	subPebbleButtonH      = 20
	subPebbleButtonInsetR = 10 // gap from bubble right edge to button right edge
	subPebbleButtonInsetB = 8  // gap from bubble bottom to button bottom
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
	id    string
	color atomic.Value // SubPebbleColor — atomic so Failed can recolor on the fly
	state atomic.Value // PebbleState
	label atomic.Value // string  — agent name (always set at spawn; used as bubble header)
	task  atomic.Value // string  — current task line (set lazily by daemon on expand)
	result   atomic.Value // string  — result preview for completed/failed (set on expand)
	elapsedS atomic.Int64 // last-known elapsed seconds for the bubble counter
	expanded atomic.Bool  // bubble visibility
	lastHit  atomic.Int32 // last WM_NCHITTEST resolution (subHitDisc/Button/None)

	// Slot is the logical row on the rail. Mutable so close-induced reflow
	// (Phase C2) can shift the index; paint reads it each frame so the
	// target position updates automatically.
	slot atomic.Int32

	// Animated current position — eases toward the slot's target each frame
	// with a 0.18 follow factor (matches the main pebble's cursor follow).
	// Seeded from the cursor at spawn time so new sub-pebbles "fly out"
	// from where the user summoned them rather than popping in cold.
	// Live render + hit-test both read these atomics so clicks work mid-
	// animation. Stored as int32 micro-degrees (×100) to keep atomic without
	// boxing through atomic.Value — a int32 is plenty for screen coords.
	curX atomic.Int32 // window top-left X (px)
	curY atomic.Int32 // window top-left Y (px)

	// Multi-monitor anchor (C3) — right edge of the monitor this sub-pebble
	// was spawned on. Stable for the entry's lifetime so a user dragging
	// the cursor to another monitor doesn't relocate existing sub-pebbles.
	monitorRight atomic.Int32

	hwnd    uintptr
	stopCh  chan struct{}
	doneCh  chan struct{}
	frameTick uint64
}

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
	// Register HWND → entry so the shared WndProc can find this entry when
	// the OS delivers WM_NCHITTEST / WM_LBUTTONUP for this window.
	subPebbleByHwnd.Store(hwnd, entry)
	defer func() {
		subPebbleByHwnd.Delete(hwnd)
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

func absDelta(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

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
			bx0, by0, bx1, by1 := subPebbleBubbleRect()
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
	defer procDeleteObjectGdi.Call(dib)
	procSelectObject.Call(memDC, dib)

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
		repairSubPebbleBubbleAlpha(pixels)
	}

	const acSrcOver = 0x00
	const acSrcAlpha = 0x01
	blend := pblBlendFunction{
		BlendOp:             acSrcOver,
		BlendFlags:          0,
		SourceConstantAlpha: 255,
		AlphaFormat:         acSrcAlpha,
	}
	// C1 — ease the animated position toward the slot target each frame.
	// 0.18 follow factor matches the main pebble's cursor lag for a
	// consistent visual language. When curX/Y has converged, this becomes
	// a no-op so we're not paying for math we don't need.
	tx, ty := s.slotPosition(entry)
	cx := float64(entry.curX.Load())
	cy := float64(entry.curY.Load())
	const followFactor = 0.18
	cx += (float64(tx) - cx) * followFactor
	cy += (float64(ty) - cy) * followFactor
	// Snap to target once close enough so we don't render fractional pixel
	// jitter forever.
	if absDelta(cx-float64(tx)) < 0.5 && absDelta(cy-float64(ty)) < 0.5 {
		cx, cy = float64(tx), float64(ty)
	}
	entry.curX.Store(int32(cx))
	entry.curY.Store(int32(cy))
	winPt := pblPoint{X: int32(cx), Y: int32(cy)}
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
