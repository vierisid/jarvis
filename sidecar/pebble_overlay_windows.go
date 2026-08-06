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
	// Physics, state, pointing, render state, and lifecycle live in the shared
	// pebbleCore (sub_pebble-style). Embedded so existing field accesses
	// (s.state, s.curX, s.renderedX, s.cursorOnDisc, …) promote unchanged and
	// the shared runtime can drive them. Only the Win32 handles + callbacks are
	// platform-specific and stay here.
	pebbleCore

	hwnd uintptr

	// The main cursor pebble owns one reusable software surface for its whole
	// lifetime. Recreating a 32-bit DIB and memory DC on every 16 ms frame was
	// needlessly expensive and could make the hardware cursor feel sluggish on
	// some Windows machines. These handles are created on the overlay thread in
	// createWindow and released on that same thread in destroyWindow.
	renderDC        uintptr
	renderDIB       uintptr
	renderOldBitmap uintptr
	renderBits      unsafe.Pointer

	// hotkeyStop / paletteHotkeyStop / paletteMouseHookStop are cleanup
	// functions for the summon (Ctrl+Space) hotkey, the Ctrl+K palette hotkey,
	// and the Ctrl+MMB low-level mouse hook respectively. Called on Close.
	hotkeyStop           func()
	paletteHotkeyStop    func()
	paletteMouseHookStop func()

	// summonCallback / paletteCallback are invoked when the user fires the
	// summon / palette hotkeys; the daemon drives state transitions from there.
	// atomic.Value because OnSummon/OnPalette are re-assigned on every reconnect
	// (connectAndServe) while the hotkey-listener goroutine reads them — a plain
	// field is a data race. Matches the other pebble callbacks.
	summonCallback  atomic.Value // func()
	paletteCallback atomic.Value // func()
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

func (s *pebbleServiceWindows) OnAnswerOpen(callback func(answerID string)) {
	pebbleAnswerOpenCallback.Store(callback)
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

	go runPebbleLoop(&s.pebbleCore, s)
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
	if cb, ok := s.summonCallback.Load().(func()); ok && cb != nil {
		go cb()
	}
}

func (s *pebbleServiceWindows) OnSummon(callback func()) {
	s.summonCallback.Store(callback)
}

// onPaletteHotkey fires the user-supplied palette callback. Like the summon
// callback, this runs on whatever goroutine the hotkey listener used; the
// daemon owns the open/close lifecycle of the palette panel itself.
func (s *pebbleServiceWindows) onPaletteHotkey() {
	cb, ok := s.paletteCallback.Load().(func())
	if !ok || cb == nil {
		log.Printf("[pebble] palette hotkey fired but no callback registered yet — dropping")
		return
	}
	log.Printf("[pebble] palette hotkey fired — invoking callback")
	go cb()
}

func (s *pebbleServiceWindows) OnPalette(callback func()) {
	s.paletteCallback.Store(callback)
}

// SetState / SetText / SetEye / SetBlinded / SetAnswerOverflow / PointAt are
// platform-independent core mutators: they live on pebbleCore (pebble_runtime.go)
// and reach this service through the embedded core via method promotion, so
// they are not redefined here.

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

// ─────────────────────────── Platform adapter ───────────────────────────────
//
// The frame loop (cursor-follow ease, [POINT:..] override, frame ticker,
// lifecycle) lives in runPebbleLoop (pebble_runtime.go); Spawn launches it with
// this service as the pebblePlatform. The methods below are the Win32 primitives
// it drives: createWindow / pumpMessages / present / destroyWindow.

// destroyWindow tears down the layered window. The shared runtime
// (runPebbleLoop) calls it when the frame loop exits. Implements pebblePlatform.
func (s *pebbleServiceWindows) destroyWindow() {
	s.destroyRenderSurface()
	if s.hwnd != 0 {
		procDestroyWindow.Call(s.hwnd)
		s.hwnd = 0
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

// The backing-buffer dimensions remain large because the Windows drawing
// helpers are shared with sub-pebbles and the dormant bubble renderer. The
// main cursor pebble itself no longer paints a bubble, so its actual layered
// window is cropped to the visual's bounds. This prevents DWM from moving and
// blending a mostly-transparent 460x480 surface whenever the cursor moves.
const (
	pebbleWindowW = 460
	pebbleWindowH = 480

	// Includes the drop's 2.1x glow, the pointing halo, and the awareness eye
	// around the (40,28) anchor, with a few pixels of AA breathing room.
	mainPebbleWindowW = 72
	mainPebbleWindowH = 64
	// pebbleAnchorX / pebbleAnchorY are shared in pebble_core.go.
)

// createWindow creates the layered overlay window and stores its handle on the
// service. Implements pebblePlatform; called once by runPebbleLoop.
func (s *pebbleServiceWindows) createWindow() error {
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
	w := int32(mainPebbleWindowW)
	h := int32(mainPebbleWindowH)

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
		return fmt.Errorf("CreateWindowExW failed: %v", err)
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

	s.hwnd = hwnd
	if err := s.createRenderSurface(); err != nil {
		procDestroyWindow.Call(hwnd)
		s.hwnd = 0
		return err
	}
	return nil
}

// createRenderSurface allocates the main pebble's memory DC and DIB once.
// The DIB keeps the shared renderer's 460 px stride, but only the top
// mainPebbleWindowH rows are cleared, drawn, and presented for this overlay.
func (s *pebbleServiceWindows) createRenderSurface() error {
	screenDC, _, _ := procGetDC.Call(0)
	if screenDC == 0 {
		return fmt.Errorf("GetDC failed")
	}
	defer procReleaseDC.Call(0, screenDC)

	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	if memDC == 0 {
		return fmt.Errorf("CreateCompatibleDC failed")
	}

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
		0, // DIB_RGB_COLORS
		uintptr(unsafe.Pointer(&bits)),
		0, 0,
	)
	if dib == 0 || bits == nil {
		procDeleteDC.Call(memDC)
		return fmt.Errorf("CreateDIBSection failed")
	}

	oldBitmap, _, _ := procSelectObject.Call(memDC, dib)
	// SelectObject has two failure sentinels depending on object type:
	// NULL and HGDI_ERROR ((HGDIOBJ)-1). Never retain HGDI_ERROR as the
	// bitmap to restore during cleanup or the DIB/DC can leak.
	if oldBitmap == 0 || oldBitmap == ^uintptr(0) {
		procDeleteObjectGdi.Call(dib)
		procDeleteDC.Call(memDC)
		return fmt.Errorf("SelectObject failed")
	}
	s.renderDC = memDC
	s.renderDIB = dib
	s.renderOldBitmap = oldBitmap
	s.renderBits = bits
	return nil
}

func (s *pebbleServiceWindows) destroyRenderSurface() {
	if s.renderDC != 0 && s.renderOldBitmap != 0 {
		procSelectObject.Call(s.renderDC, s.renderOldBitmap)
	}
	if s.renderDIB != 0 {
		procDeleteObjectGdi.Call(s.renderDIB)
	}
	if s.renderDC != 0 {
		procDeleteDC.Call(s.renderDC)
	}
	s.renderDC = 0
	s.renderDIB = 0
	s.renderOldBitmap = 0
	s.renderBits = nil
}

// pebbleWndProc handles WM_NCHITTEST (disc-only clicks) + WM_LBUTTONDOWN/UP
// (W6-T2 short-click summon vs long-press blind toggle) + WM_DESTROY.
// There's only ever one main pebble per process so the service pointer
// can be stored in a package-level var (pebbleServiceInstance) for the
// WndProc to consult.
const (
	pblWmNcHitTest   = 0x0084
	pblWmLButtonDown = 0x0201
	pblWmLButtonUp   = 0x0202
	pblHtTransparent = ^uintptr(0)
	pblHtClient      = 1
	// Canonical values live in pebble_core.go (shared across platforms).
	pblLongPressMs   = pebbleLongPressMs
	pblDiscHitRadius = pebbleDiscHitRadius
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

		// Long-answer "open full ↗" button — only present while the
		// speaking/listening bubble is visible AND answerOverflowID is
		// non-empty. Check before disc so the button wins when it
		// overlaps the disc's bubble area.
		bubbleY1 := svc.lastBubbleY1.Load()
		if bubbleY1 > 0 {
			if answerID, _ := svc.answerOverflowID.Load().(string); answerID != "" {
				btnY0 := int(pebbleAnswerBtnTop(bubbleY1))
				btnY1 := btnY0 + pebbleAnswerBtnH
				if localX >= pebbleAnswerBtnXLeft && localX <= pebbleAnswerBtnXRight &&
					localY >= btnY0 && localY <= btnY1 {
					svc.cursorOnDisc.Store(false)
					svc.cursorOnAnswer.Store(true)
					return pblHtClient
				}
			}
		}
		svc.cursorOnAnswer.Store(false)

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
		// Answer-overflow button — fire the open-answer callback regardless
		// of click duration. The button is a separate target from the disc
		// so we route based on which area was last hit-tested.
		if svc.cursorOnAnswer.Load() {
			if answerID, _ := svc.answerOverflowID.Load().(string); answerID != "" {
				if cbAny := pebbleAnswerOpenCallback.Load(); cbAny != nil {
					if cb, ok := cbAny.(func(string)); ok && cb != nil {
						go cb(answerID)
					}
				}
			}
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

// pebbleAnswerOpenCallback fires when the user clicks the speaking-bubble
// "open full ↗" button. Passes the answer id stored via SetAnswerOverflow.
var pebbleAnswerOpenCallback atomic.Value // func(answerID string)

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
//
// present renders the current frame into a layered window at the core's
// already-eased position. Implements pebblePlatform; runPebbleLoop calls
// advanceFrame() (cursor-follow ease, pointing, disc-freeze, frame tick,
// window top-left) immediately before each present.
func (s *pebbleServiceWindows) present() error {
	// Window top-left was computed by the shared advanceFrame() and published
	// for the message thread; render reads it here.
	winX := s.renderedX.Load()
	winY := s.renderedY.Load()

	if s.renderDC == 0 || s.renderBits == nil {
		return fmt.Errorf("pebble render surface is not initialized")
	}

	// Acquire only the desktop DC needed by UpdateLayeredWindow. The memory DC
	// and DIB are persistent for the overlay's lifetime.
	screenDC, _, _ := procGetDC.Call(0)
	if screenDC == 0 {
		return fmt.Errorf("GetDC failed")
	}
	defer procReleaseDC.Call(0, screenDC)

	pixels := unsafe.Slice((*uint32)(s.renderBits), pebbleWindowW*pebbleWindowH)
	// The main renderer never paints below its compact layered-window crop.
	// Clear just those rows instead of all 220,800 backing pixels.
	for i := range pixels[:pebbleWindowW*mainPebbleWindowH] {
		pixels[i] = 0
	}
	state, _ := s.state.Load().(PebbleState)
	// No transcript bubble: the speaking state is just the blue drop (see
	// drawState). The pebble never paints a caption card at the cursor, so
	// there's no bubble height to measure and no glyph alpha to repair.
	s.drawState(pixels, state, 0)
	s.lastBubbleY1.Store(0)
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
	// Ethereal mode scales the whole-window opacity (on top of per-pixel alpha).
	ea := s.EtherealAlpha()
	if ea < 0 {
		ea = 0
	} else if ea > 1 {
		ea = 1
	}
	blend := pblBlendFunction{
		BlendOp:             acSrcOver,
		BlendFlags:          0,
		SourceConstantAlpha: byte(ea * 255),
		AlphaFormat:         acSrcAlpha,
	}
	winPt := pblPoint{X: winX, Y: winY}
	winSz := pblSize{CX: mainPebbleWindowW, CY: mainPebbleWindowH}
	srcPt := pblPoint{X: 0, Y: 0}

	r, _, _ := procUpdateLayeredWindow.Call(
		s.hwnd,
		screenDC,
		uintptr(unsafe.Pointer(&winPt)),
		uintptr(unsafe.Pointer(&winSz)),
		s.renderDC,
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
