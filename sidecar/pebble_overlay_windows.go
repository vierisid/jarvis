//go:build windows

package main

// Native pebble overlay — Windows.
//
// W2-T10 SKELETON. This file establishes the structure (window class,
// goroutine ownership, state machine, cursor poll) but the GDI+ drawing
// path is intentionally minimal in this first cut so we can verify:
//   1. Layered window appears with TRUE per-pixel alpha (no white box)
//   2. Window is genuinely click-through and always-on-top
//   3. Cursor follow + eased physics work via SetWindowPos
//
// Once those three are confirmed visually, the next pass adds full GDI+
// shape rendering (rounded paper pill, hairline border, hard offset
// shadow, state-specific glyphs) and the bubble.

import (
	"fmt"
	"log"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// alias so the inline math is readable
var sqrt = math.Sqrt

// ─────────────────────────── Win32 syscalls ────────────────────────────────

var (
	pebbleKernel32 = syscall.NewLazyDLL("kernel32.dll")
	pebbleGdi32    = syscall.NewLazyDLL("gdi32.dll")
	pebbleUser32   = syscall.NewLazyDLL("user32.dll")
	pebbleMsimg32  = syscall.NewLazyDLL("msimg32.dll")

	procGetModuleHandleW    = pebbleKernel32.NewProc("GetModuleHandleW")
	procRegisterClassExW    = pebbleUser32.NewProc("RegisterClassExW")
	procCreateWindowExW     = pebbleUser32.NewProc("CreateWindowExW")
	procDestroyWindow       = pebbleUser32.NewProc("DestroyWindow")
	procDefWindowProcW      = pebbleUser32.NewProc("DefWindowProcW")
	procPeekMessageW        = pebbleUser32.NewProc("PeekMessageW")
	procTranslateMessage    = pebbleUser32.NewProc("TranslateMessage")
	procDispatchMessageW    = pebbleUser32.NewProc("DispatchMessageW")
	procPostQuitMessage     = pebbleUser32.NewProc("PostQuitMessage")
	procGetDC               = pebbleUser32.NewProc("GetDC")
	procReleaseDC           = pebbleUser32.NewProc("ReleaseDC")
	procUpdateLayeredWindow = pebbleUser32.NewProc("UpdateLayeredWindow")

	procCreateCompatibleDC = pebbleGdi32.NewProc("CreateCompatibleDC")
	procDeleteDC           = pebbleGdi32.NewProc("DeleteDC")
	procCreateDIBSection   = pebbleGdi32.NewProc("CreateDIBSection")
	procSelectObject       = pebbleGdi32.NewProc("SelectObject")
	procDeleteObjectGdi    = pebbleGdi32.NewProc("DeleteObject")
	procBitBlt             = pebbleGdi32.NewProc("BitBlt")
	_                      = pebbleMsimg32 // keep referenced
)

// Window styles
const (
	pblWsPopup         = 0x80000000
	pblWsVisible       = 0x10000000
	pblWsExLayered     = 0x00080000
	pblWsExTransparent = 0x00000020
	pblWsExTopmost     = 0x00000008
	pblWsExNoActivate  = 0x08000000
	pblWsExToolWindow  = 0x00000080
	pblUlwAlpha        = 0x00000002
	pblWmDestroy       = 0x0002
	pblPmRemove        = 0x0001
)

// HWND_TOPMOST = -1.
const pblHwndTopmost = ^uintptr(0)

// WNDCLASSEX layout (32 fields packed; we only fill what we need).
type pblWndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type pblPoint struct {
	X int32
	Y int32
}

type pblSize struct {
	CX int32
	CY int32
}

type pblBlendFunction struct {
	BlendOp             byte
	BlendFlags          byte
	SourceConstantAlpha byte
	AlphaFormat         byte
}

type pblBitmapInfoHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type pblBitmapInfo struct {
	Header pblBitmapInfoHeader
	// Colors[1] omitted — not used for 32-bit DIB
}

// ─────────────────────────── Service ────────────────────────────────────────

type pebbleServiceWindows struct {
	mu         sync.Mutex
	state      atomic.Value // PebbleState
	bubbleText atomic.Value // string — body line; "" means use default per-state copy
	spec       PebbleSpec
	hwnd       uintptr
	stopCh     chan struct{}
	doneCh     chan struct{}
	spawned    atomic.Bool

	// T8 — element pointing. While `pointing` is true and now < pointUntilMs,
	// paint() overrides the cursor-follow target with (pointX, pointY) so the
	// pebble eases to a fixed screen coordinate. Previous state + bubble text
	// are stashed and restored when the duration elapses.
	// W6-T1 — eye glyph activates when awareness/OCR is firing. Daemon
	// toggles via pebble.set_eye; sidecar paints a small accent eye next
	// to the pebble while true. Auto-clears after the daemon's timeout.
	eyeActive atomic.Bool

	// W6-T2 — blinded means awareness is hard-paused. Pebble dims and
	// shows a struck-through eye. Toggled via pebble.set_blinded.
	blinded atomic.Bool

	pointing     atomic.Bool
	pointX       atomic.Int32
	pointY       atomic.Int32
	pointUntilMs atomic.Int64
	prevState    atomic.Value // PebbleState
	prevText     atomic.Value // string

	// Eased rendered position — matches the mock's 0.18 follow factor.
	// `current` chases `target = cursor + offset` each frame.
	curX float64
	curY float64

	// Last rendered window screen-position, stored as int32 atomics so the
	// message thread (WM_NCHITTEST) can read it without racing the paint
	// goroutine. paint() writes these every frame after the ease update.
	renderedX atomic.Int32
	renderedY atomic.Int32

	// frameTick increments each paint and feeds time-based animations
	// (idle breathing, listening/speaking waveform bars, thinking dot
	// bounce). Wraps around — only relative phase matters.
	frameTick uint64

	// hotkeyStop is the cleanup function returned by startHotkeyListener.
	// Called when the pebble is closed.
	hotkeyStop func()

	// paletteHotkeyStop is the cleanup function for the Ctrl+K palette
	// hotkey, when registered via PaletteHotkey.
	paletteHotkeyStop func()

	// paletteMouseHookStop is the cleanup function for the global
	// low-level mouse hook that fires the palette on Ctrl+MMB. Same
	// callback as the keyboard hotkey, just a different trigger.
	paletteMouseHookStop func()

	// summonCallback is invoked each time the user fires the summon
	// hotkey. Set via OnSummon(); the daemon drives state transitions
	// from there.
	summonCallback func()

	// W6-T2 — click tracking on the disc. WM_LBUTTONDOWN records the
	// timestamp; WM_LBUTTONUP compares to decide short-click (summon)
	// vs long-press (blind toggle). Atomic so the message thread doesn't
	// race the paint goroutine.
	clickDownMs    atomic.Int64
	cursorOnDisc   atomic.Bool // set by WM_NCHITTEST so paint can pause cursor follow

	// paletteCallback is invoked each time the user fires the palette
	// hotkey (Ctrl+K). Set via OnPalette(); the daemon spawns/dismisses
	// the palette panel from there.
	paletteCallback func()
}

// NewPebbleService returns the Windows-native pebble service. Stores a
// package-level pointer so the shared WndProc can resolve the service
// without per-message lookup (only one main pebble per process).
func NewPebbleService() PebbleService {
	s := &pebbleServiceWindows{}
	s.state.Store(PebbleIdle)
	s.bubbleText.Store("")
	pebbleServiceInstance = s
	return s
}

// OnBlindToggle registers a callback invoked when the user long-presses
// the pebble disc. The daemon listens for this via a SidecarEvent emitted
// from client.go and flips awareness.enabled in config.
func (s *pebbleServiceWindows) OnBlindToggle(callback func()) {
	pebbleBlindToggleCallback.Store(callback)
}

func (s *pebbleServiceWindows) Spawn(spec PebbleSpec) error {
	if !s.spawned.CompareAndSwap(false, true) {
		return nil // already spawned — idempotent
	}
	s.mu.Lock()
	s.spec = spec
	if s.spec.CursorOffsetX == 0 && s.spec.CursorOffsetY == 0 {
		// Comfortable companion distance — far enough that the cursor
		// never sits on the visible pebble disc (which is ~22 px wide
		// in the placeholder). Matches the riso mock spacing.
		s.spec.CursorOffsetX = 28
		s.spec.CursorOffsetY = 32
	}
	// Seed the eased position at cursor + offset so the pebble doesn't
	// fly across the screen on first frame.
	if cx, cy, err := platformGetCursorPos(); err == nil {
		s.curX = float64(cx + s.spec.CursorOffsetX)
		s.curY = float64(cy + s.spec.CursorOffsetY)
	}
	s.stopCh = make(chan struct{})
	s.doneCh = make(chan struct{})
	s.mu.Unlock()

	go s.run()
	log.Printf("[pebble] spawned (offset %d,%d, hotkey=%q)", s.spec.CursorOffsetX, s.spec.CursorOffsetY, s.spec.SummonHotkey)

	// Register the global summon hotkey — fires the user-supplied callback
	// (set via OnSummon). The daemon decides what to do next.
	if s.spec.SummonHotkey != "" {
		stop, err := startHotkeyListener(s.spec.SummonHotkey, func() {
			s.onSummonHotkey()
		})
		if err != nil {
			log.Printf("[pebble] hotkey '%s' not registered: %v", s.spec.SummonHotkey, err)
		} else {
			s.hotkeyStop = stop
			log.Printf("[pebble] summon hotkey '%s' registered", s.spec.SummonHotkey)
		}
	}

	// Register the palette hotkey (Ctrl+K) — fires OnPalette callback.
	// Independent of the summon hotkey; daemon spawns/dismisses the palette
	// panel at the cursor position.
	if s.spec.PaletteHotkey != "" {
		stop, err := startHotkeyListener(s.spec.PaletteHotkey, func() {
			s.onPaletteHotkey()
		})
		if err != nil {
			log.Printf("[pebble] palette hotkey '%s' not registered: %v", s.spec.PaletteHotkey, err)
		} else {
			s.paletteHotkeyStop = stop
			log.Printf("[pebble] palette hotkey '%s' registered", s.spec.PaletteHotkey)
		}
	}

	// W4 — Ctrl+Middle-click as a mouse-only palette trigger so the user
	// can fire the palette one-handed without lifting fingers off the
	// mouse. Plain MMB still flows through; we only swallow the click
	// when Ctrl is held. Off when PaletteHotkey is empty (so callers can
	// opt out of the global mouse hook entirely).
	if s.spec.PaletteHotkey != "" {
		stop, err := startMouseHookCtrlMButton(func() {
			s.onPaletteHotkey()
		})
		if err != nil {
			log.Printf("[pebble] Ctrl+MMB hook not installed: %v", err)
		} else {
			s.paletteMouseHookStop = stop
			log.Printf("[pebble] Ctrl+MMB palette trigger installed")
		}
	}
	return nil
}

// onSummonHotkey fires the user-supplied summon callback. The pebble is
// purely visual now — state changes flow exclusively from the daemon via
// SetState() so the brain stays the source of truth (wake-word, LLM
// lifecycle, manual hotkey all funnel through the same path).
func (s *pebbleServiceWindows) onSummonHotkey() {
	cb := s.summonCallback
	if cb != nil {
		go cb()
	}
}

func (s *pebbleServiceWindows) OnSummon(callback func()) {
	s.summonCallback = callback
}

// onPaletteHotkey fires the user-supplied palette callback. Like the summon
// callback, this runs on whatever goroutine the hotkey listener used; the
// daemon owns the open/close lifecycle of the palette panel itself.
func (s *pebbleServiceWindows) onPaletteHotkey() {
	cb := s.paletteCallback
	if cb == nil {
		log.Printf("[pebble] palette hotkey fired but no callback registered yet — dropping")
		return
	}
	log.Printf("[pebble] palette hotkey fired — invoking callback")
	go cb()
}

func (s *pebbleServiceWindows) OnPalette(callback func()) {
	s.paletteCallback = callback
}

func (s *pebbleServiceWindows) SetState(state PebbleState) error {
	if !s.spawned.Load() {
		return fmt.Errorf("pebble not spawned")
	}
	s.state.Store(state)
	return nil
}

func (s *pebbleServiceWindows) SetText(text string) error {
	s.bubbleText.Store(text)
	return nil
}

func (s *pebbleServiceWindows) SetEye(active bool) error {
	s.eyeActive.Store(active)
	return nil
}

func (s *pebbleServiceWindows) SetBlinded(blinded bool) error {
	s.blinded.Store(blinded)
	return nil
}

// PointAt animates the pebble to (x, y) and shows `label` in the bubble
// for `durationMs` milliseconds. Eased physics in paint() handle the
// actual movement; this just sets the override target + restoration
// state. Calling PointAt while a previous point is still active resets
// the timer and target — multiple points in a row "walk" through them.
func (s *pebbleServiceWindows) PointAt(x, y int, label string, durationMs int) error {
	if !s.spawned.Load() {
		return fmt.Errorf("pebble not spawned")
	}
	if durationMs <= 0 {
		durationMs = 3000
	}
	// Snapshot the pre-point state ONLY if we're not already pointing.
	// Re-entrant points (LLM emitted multiple tags) shouldn't keep
	// re-snapshotting an intermediate "speaking + label" state as the
	// thing to restore later.
	if s.pointing.CompareAndSwap(false, true) {
		ps, _ := s.state.Load().(PebbleState)
		pt, _ := s.bubbleText.Load().(string)
		s.prevState.Store(ps)
		s.prevText.Store(pt)
	}
	s.pointX.Store(int32(x))
	s.pointY.Store(int32(y))
	s.pointUntilMs.Store(time.Now().Add(time.Duration(durationMs) * time.Millisecond).UnixMilli())
	// Force the bubble to show with the label as body text. Listening
	// state has the paper card variant which reads cleanly against any
	// desktop and matches the riso "calling attention" feel.
	s.state.Store(PebbleListening)
	s.bubbleText.Store(label)
	return nil
}

func (s *pebbleServiceWindows) Close() error {
	if !s.spawned.CompareAndSwap(true, false) {
		return nil
	}
	if s.hotkeyStop != nil {
		s.hotkeyStop()
		s.hotkeyStop = nil
	}
	if s.paletteHotkeyStop != nil {
		s.paletteHotkeyStop()
		s.paletteHotkeyStop = nil
	}
	if s.paletteMouseHookStop != nil {
		s.paletteMouseHookStop()
		s.paletteMouseHookStop = nil
	}
	close(s.stopCh)
	<-s.doneCh
	log.Printf("[pebble] closed")
	return nil
}

// ─────────────────────────── Run loop ───────────────────────────────────────

// run owns the layered window. Locked to its own OS thread because Win32
// layered windows + GDI+ contexts are thread-affine.
func (s *pebbleServiceWindows) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(s.doneCh)

	hwnd, err := s.createWindow()
	if err != nil {
		log.Printf("[pebble] createWindow failed: %v", err)
		return
	}
	s.hwnd = hwnd
	defer func() {
		procDestroyWindow.Call(hwnd)
		s.hwnd = 0
	}()

	// Initial paint so the window has *some* alpha buffer registered with
	// the OS compositor (UpdateLayeredWindow is the only way to "show" a
	// layered window with per-pixel alpha).
	if err := s.paint(hwnd); err != nil {
		log.Printf("[pebble] initial paint: %v", err)
	}

	frame := time.NewTicker(16 * time.Millisecond)
	defer frame.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-frame.C:
			s.pumpMessages()
			if err := s.paint(hwnd); err != nil {
				log.Printf("[pebble] paint: %v", err)
			}
		}
	}
}

// pumpMessages runs PeekMessage in a non-blocking loop so the layered window
// dispatches WM_DESTROY etc. without us blocking on GetMessage.
func (s *pebbleServiceWindows) pumpMessages() {
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

// Window size and anchor — the window is sized to fit the pebble pill PLUS
// a bubble that drops below it. Most pixels are alpha=0 (true transparent);
// only the pebble + bubble paint visible content. The pebble's centre is
// pinned at (pebbleAnchorX, pebbleAnchorY) within the window, and the
// window is positioned so that anchor lands at (cursor + offset).
const (
	pebbleWindowW = 360
	pebbleWindowH = 220
	pebbleAnchorX = 40
	pebbleAnchorY = 28
)

func (s *pebbleServiceWindows) createWindow() (uintptr, error) {
	className, _ := syscall.UTF16PtrFromString("JarvisPebbleOverlay")
	windowName, _ := syscall.UTF16PtrFromString("JARVIS")

	hInstance, _, _ := procGetModuleHandleW.Call(0)

	// Register the class once per process. A re-registration would fail
	// (ERROR_CLASS_ALREADY_EXISTS), which we ignore.
	wc := pblWndClassEx{
		Size:      uint32(unsafe.Sizeof(pblWndClassEx{})),
		Style:     0,
		WndProc:   syscall.NewCallback(pebbleWndProc),
		Instance:  hInstance,
		ClassName: className,
	}
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	// CreateWindowEx with all the layered/topmost/transparent flags upfront
	// — critical for the OS compositor to set up DComp properly. Setting
	// these flags AFTER creation (which is what the webview path tried) is
	// what caused the white-box issue.
	// W6-T2: drop WS_EX_TRANSPARENT so the window can catch clicks on the
	// disc (long-press = blind toggle). WM_NCHITTEST returns HTTRANSPARENT
	// for everything outside the disc + bubble so the rest of the 360×220
	// frame still passes mouse events through to whatever's behind.
	exStyle := uintptr(pblWsExLayered | pblWsExTopmost | pblWsExNoActivate | pblWsExToolWindow)
	style := uintptr(pblWsPopup | pblWsVisible)
	x := int32(0)
	y := int32(0)
	w := int32(pebbleWindowW)
	h := int32(pebbleWindowH)

	hwnd, _, err := procCreateWindowExW.Call(
		exStyle,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		style,
		uintptr(uint32(x)),
		uintptr(uint32(y)),
		uintptr(uint32(w)),
		uintptr(uint32(h)),
		0, 0,
		hInstance,
		0,
	)
	if hwnd == 0 {
		return 0, fmt.Errorf("CreateWindowExW failed: %v", err)
	}

	// Push to topmost group (HWND_TOPMOST) — already in EX style, but
	// SetWindowPos confirms ordering and is required for the OS to honour
	// the topmost flag when the window first appears.
	const swpNoMove = 0x0002
	const swpNoSize = 0x0001
	const swpNoActivate = 0x0010
	const swpShowWindow = 0x0040
	procSetWindowPos.Call(hwnd, pblHwndTopmost, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)

	return hwnd, nil
}

// pebbleWndProc handles WM_NCHITTEST (disc-only clicks) + WM_LBUTTONDOWN/UP
// (W6-T2 short-click summon vs long-press blind toggle) + WM_DESTROY.
// There's only ever one main pebble per process so the service pointer
// can be stored in a package-level var (pebbleServiceInstance) for the
// WndProc to consult.
const (
	pblWmNcHitTest     = 0x0084
	pblWmLButtonDown   = 0x0201
	pblWmLButtonUp     = 0x0202
	pblHtTransparent   = ^uintptr(0)
	pblHtClient        = 1
	pblLongPressMs     = 500
	pblDiscHitRadius   = 18
)

var pebbleServiceInstance *pebbleServiceWindows

func pebbleWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	svc := pebbleServiceInstance
	switch msg {
	case pblWmNcHitTest:
		if svc == nil {
			return pblHtTransparent
		}
		sx := int(int16(lParam & 0xFFFF))
		sy := int(int16((lParam >> 16) & 0xFFFF))
		winX := int(svc.renderedX.Load())
		winY := int(svc.renderedY.Load())
		localX := sx - winX
		localY := sy - winY
		dx := localX - pebbleAnchorX
		dy := localY - pebbleAnchorY
		if dx*dx+dy*dy <= pblDiscHitRadius*pblDiscHitRadius {
			svc.cursorOnDisc.Store(true)
			return pblHtClient
		}
		svc.cursorOnDisc.Store(false)
		return pblHtTransparent

	case pblWmLButtonDown:
		if svc != nil {
			svc.clickDownMs.Store(time.Now().UnixMilli())
		}
		return 0

	case pblWmLButtonUp:
		if svc == nil {
			return 0
		}
		down := svc.clickDownMs.Swap(0)
		if down == 0 {
			return 0
		}
		dur := time.Now().UnixMilli() - down
		if dur >= pblLongPressMs {
			// Long-press = blind toggle. Fire the dedicated callback.
			if cbAny := pebbleBlindToggleCallback.Load(); cbAny != nil {
				if cb, ok := cbAny.(func()); ok && cb != nil {
					go cb()
				}
			}
		} else {
			// Short click = summon (same as Ctrl+Space hotkey).
			svc.onSummonHotkey()
		}
		return 0

	case pblWmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

// pebbleBlindToggleCallback is fired on long-press. Set via OnBlindToggle()
// from client.go; the daemon listens for the resulting SidecarEvent and
// flips awareness.enabled in config + dispatches pebble.set_blinded.
var pebbleBlindToggleCallback atomic.Value // func()

// ─────────────────────────── Paint pipeline ─────────────────────────────────

// paint renders the current state into a 32-bit pre-multiplied ARGB DIB and
// hands it to UpdateLayeredWindow. UpdateLayeredWindow ALSO controls the
// window's screen position — we pass the eased pebble position.
//
// Eased physics: each frame, curX/curY interpolate toward (cursor + offset)
// at factor 0.18 — matches the mock's "lagging companion" feel.
//
// Riso rendering (idle for now, expanding to other states):
//   - Hard offset shadow — 2 px down-right, ink at 10% alpha, no blur
//   - Paper-tone fill with a 1 px hairline border
//   - State-specific glyph inside (idle: small ink-3 centre dot)
//   - Subtle breathing animation (opacity oscillation, 4 s cycle)
func (s *pebbleServiceWindows) paint(hwnd uintptr) error {
	cx, cy, err := platformGetCursorPos()
	if err != nil {
		return err
	}
	followFactor := 0.18
	tgtX := float64(cx + s.spec.CursorOffsetX)
	tgtY := float64(cy + s.spec.CursorOffsetY)
	// T8 — element-pointing override. While active, the pebble eases to
	// the fixed point instead of the cursor. We bump the follow factor
	// so the pebble snaps to the target in ~150 ms instead of the ~500 ms
	// the cursor-follow factor produces — gives the user more visible
	// "stay time" at the target before the duration expires.
	if s.pointing.Load() {
		if time.Now().UnixMilli() >= s.pointUntilMs.Load() {
			s.pointing.Store(false)
			if ps, ok := s.prevState.Load().(PebbleState); ok {
				s.state.Store(ps)
			}
			if pt, ok := s.prevText.Load().(string); ok {
				s.bubbleText.Store(pt)
			}
		} else {
			tgtX = float64(s.pointX.Load())
			tgtY = float64(s.pointY.Load())
			followFactor = 0.42
		}
	}
	// W6-T2 — freeze cursor follow when the user's cursor is on the disc
	// so they can actually click without the pebble running away. We
	// re-verify each frame using the live cursor position rather than
	// trusting WM_NCHITTEST alone: once the cursor leaves the window
	// entirely the OS stops sending hit-test messages, so a stale
	// cursorOnDisc=true would keep the pebble frozen indefinitely.
	{
		dxDisc := cx - int(s.curX)
		dyDisc := cy - int(s.curY)
		onDisc := dxDisc*dxDisc+dyDisc*dyDisc <= pblDiscHitRadius*pblDiscHitRadius
		s.cursorOnDisc.Store(onDisc)
		if onDisc {
			followFactor = 0
		}
	}
	s.curX += (tgtX - s.curX) * followFactor
	s.curY += (tgtY - s.curY) * followFactor
	s.frameTick++

	// Position the window so the pebble's anchor (where we draw the pebble
	// centre) lands at (s.curX, s.curY) — the eased cursor + offset.
	winX := int32(s.curX - pebbleAnchorX)
	winY := int32(s.curY - pebbleAnchorY)
	// Stash for the message thread (WM_NCHITTEST) so it can do disc-area
	// hit-test math without racing the paint goroutine.
	s.renderedX.Store(winX)
	s.renderedY.Store(winY)

	// Create memory DC + 32-bit DIB
	screenDC, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, screenDC)
	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	defer procDeleteDC.Call(memDC)

	bi := pblBitmapInfo{
		Header: pblBitmapInfoHeader{
			BiSize:        uint32(unsafe.Sizeof(pblBitmapInfoHeader{})),
			BiWidth:       pebbleWindowW,
			BiHeight:      -pebbleWindowH, // top-down
			BiPlanes:      1,
			BiBitCount:    32,
			BiCompression: 0,
		},
	}
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(
		memDC,
		uintptr(unsafe.Pointer(&bi)),
		0, // DIB_RGB_COLORS
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
	state, _ := s.state.Load().(PebbleState)
	// Auto-fit bubble height: measure the wrapped body text first (DT_CALCRECT
	// against the same memDC + body font we'll paint with) so the rounded card
	// is exactly tall enough to hold the response — no wasted black space for
	// short replies, but still capped so it can't overflow the layered window.
	bubbleY1 := s.computeBubbleBottom(memDC, state)
	s.drawState(pixels, state, bubbleY1)
	// GDI text rendering on top of the bubble's fully-opaque (alpha=255)
	// pixels. DrawText writes RGB *and corrupts* alpha on the glyph
	// pixels — repairBubbleTextAlpha clamps alpha back to 255 across the
	// text region so the bubble doesn't end up "see-through" wherever
	// glyphs were drawn.
	if state == PebbleListening || state == PebbleSpeaking {
		s.drawBubbleText(memDC, state, bubbleY1)
		repairBubbleTextAlpha(pixels, bubbleY1)
	}
	// W6-T4 — outward halo around disc when JARVIS is remotely controlling
	// (PointAt active). Drawn before the eye glyph so the glyph sits on
	// top of the halo, not under it.
	s.drawControllingHalo(pixels)
	// W6 — eye glyph (awareness firing + privacy-blinded indicators).
	// Drawn last so it sits on top of disc/pill regardless of state.
	s.drawEyeGlyph(pixels)

	// UpdateLayeredWindow — moves AND repaints the window in one call.
	// The blend function with AC_SRC_ALPHA tells the OS to honour the
	// per-pixel alpha in the DIB.
	const acSrcOver = 0x00
	const acSrcAlpha = 0x01
	blend := pblBlendFunction{
		BlendOp:             acSrcOver,
		BlendFlags:          0,
		SourceConstantAlpha: 255,
		AlphaFormat:         acSrcAlpha,
	}
	winPt := pblPoint{X: winX, Y: winY}
	winSz := pblSize{CX: pebbleWindowW, CY: pebbleWindowH}
	srcPt := pblPoint{X: 0, Y: 0}

	r, _, _ := procUpdateLayeredWindow.Call(
		hwnd,
		screenDC,
		uintptr(unsafe.Pointer(&winPt)),
		uintptr(unsafe.Pointer(&winSz)),
		memDC,
		uintptr(unsafe.Pointer(&srcPt)),
		0, // crKey (unused with ULW_ALPHA)
		uintptr(unsafe.Pointer(&blend)),
		pblUlwAlpha,
	)
	if r == 0 {
		return fmt.Errorf("UpdateLayeredWindow failed")
	}
	return nil
}
