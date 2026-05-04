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

	procCreateCompatibleDC     = pebbleGdi32.NewProc("CreateCompatibleDC")
	procDeleteDC               = pebbleGdi32.NewProc("DeleteDC")
	procCreateDIBSection       = pebbleGdi32.NewProc("CreateDIBSection")
	procSelectObject           = pebbleGdi32.NewProc("SelectObject")
	procDeleteObjectGdi        = pebbleGdi32.NewProc("DeleteObject")
	procBitBlt                 = pebbleGdi32.NewProc("BitBlt")
	_                          = pebbleMsimg32 // keep referenced
)

// Window styles
const (
	pblWsPopup           = 0x80000000
	pblWsVisible         = 0x10000000
	pblWsExLayered       = 0x00080000
	pblWsExTransparent   = 0x00000020
	pblWsExTopmost       = 0x00000008
	pblWsExNoActivate    = 0x08000000
	pblWsExToolWindow    = 0x00000080
	pblUlwAlpha          = 0x00000002
	pblWmDestroy         = 0x0002
	pblPmRemove          = 0x0001
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
	mu      sync.Mutex
	state   atomic.Value // PebbleState
	spec    PebbleSpec
	hwnd    uintptr
	stopCh  chan struct{}
	doneCh  chan struct{}
	spawned atomic.Bool

	// Eased rendered position — matches the mock's 0.18 follow factor.
	// `current` chases `target = cursor + offset` each frame.
	curX float64
	curY float64

	// frameTick increments each paint and feeds time-based animations
	// (idle breathing, listening/speaking waveform bars, thinking dot
	// bounce). Wraps around — only relative phase matters.
	frameTick uint64

	// hotkeyStop is the cleanup function returned by startHotkeyListener.
	// Called when the pebble is closed.
	hotkeyStop func()

	// summonCallback is invoked each time the user fires the summon
	// hotkey. Set via OnSummon(); the daemon drives state transitions
	// from there.
	summonCallback func()
}

// NewPebbleService returns the Windows-native pebble service.
func NewPebbleService() PebbleService {
	s := &pebbleServiceWindows{}
	s.state.Store(PebbleIdle)
	return s
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

func (s *pebbleServiceWindows) SetState(state PebbleState) error {
	if !s.spawned.Load() {
		return fmt.Errorf("pebble not spawned")
	}
	s.state.Store(state)
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
	pebbleWindowW   = 360
	pebbleWindowH   = 220
	pebbleAnchorX   = 40
	pebbleAnchorY   = 28
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
	exStyle := uintptr(pblWsExLayered | pblWsExTransparent | pblWsExTopmost | pblWsExNoActivate | pblWsExToolWindow)
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

// pebbleWndProc — the only message we explicitly handle is WM_DESTROY (post
// quit so the message pump exits). Everything else goes to DefWindowProc.
func pebbleWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	if msg == pblWmDestroy {
		procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

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
	const followFactor = 0.18
	tgtX := float64(cx + s.spec.CursorOffsetX)
	tgtY := float64(cy + s.spec.CursorOffsetY)
	s.curX += (tgtX - s.curX) * followFactor
	s.curY += (tgtY - s.curY) * followFactor
	s.frameTick++

	// Position the window so the pebble's anchor (where we draw the pebble
	// centre) lands at (s.curX, s.curY) — the eased cursor + offset.
	winX := int32(s.curX - pebbleAnchorX)
	winY := int32(s.curY - pebbleAnchorY)

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
	s.drawState(pixels, state)
	// GDI text rendering on top of the bubble's fully-opaque (alpha=255)
	// pixels. DrawText writes RGB without touching alpha, so the result
	// remains pre-multiplied-ARGB-correct for UpdateLayeredWindow.
	if state == PebbleListening || state == PebbleSpeaking {
		s.drawBubbleText(memDC, state)
	}

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
