//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// Win32 text-rendering syscalls.
var (
	procCreateFontW  = pebbleGdi32.NewProc("CreateFontW")
	procSetTextColor = pebbleGdi32.NewProc("SetTextColor")
	procSetBkMode    = pebbleGdi32.NewProc("SetBkMode")
	procDrawTextW    = pebbleUser32.NewProc("DrawTextW")
)

// CreateFont weight constants.
const (
	fwNormal = 400
	fwMedium = 500
	fwBold   = 700
)

// SetBkMode constants.
const (
	bkModeTransparent = 1
)

// DrawText format flags (subset).
const (
	dtLeft        = 0x00000000
	dtWordBreak   = 0x00000010
	dtSingleLine  = 0x00000020
	dtNoClip      = 0x00000100
	dtEndEllipsis = 0x00008000
	dtEditControl = 0x00002000
)

// CreateFont quality presets.
const (
	defaultQuality     = 0
	antialiasedQuality = 4
	cleartypeQuality   = 5
)

// CreateFont charset.
const ansiCharset = 0

// rect mirrors Win32 RECT for DrawText.
type pblRect struct {
	Left, Top, Right, Bottom int32
}

// colorRef builds a Win32 COLORREF (0x00BBGGRR) from RGB components.
func colorRef(r, g, b uint8) uint32 {
	return uint32(r) | uint32(g)<<8 | uint32(b)<<16
}

// drawBubbleText renders the riso "JARVIS" eyebrow + state-specific body
// line into the bubble area. Called from paint() after drawBubble has
// painted the rounded card background at alpha=255 — text writes opaque
// RGB onto those pixels, which is correct for pre-multiplied ARGB at α=255.
//
// Two fonts: a 10 px mono uppercase eyebrow ("JARVIS") in the accent colour,
// and a 13 px sans body line in ink colour. Antialiased quality for clean
// edges on the bubble background.
func (s *pebbleServiceWindows) drawBubbleText(memDC uintptr, state PebbleState) {
	// Dynamic body text wins when set (e.g. the live LLM response during
	// speaking). Falls back to per-state placeholders so listening still
	// invites the user, and speaking stays meaningful before the response
	// arrives.
	dynText, _ := s.bubbleText.Load().(string)
	var bodyText string
	switch state {
	case PebbleListening:
		if dynText != "" {
			bodyText = dynText
		} else {
			bodyText = "listening — go ahead."
		}
	case PebbleSpeaking:
		if dynText != "" {
			bodyText = dynText
		} else {
			bodyText = "speaking…"
		}
	default:
		return
	}

	// Negative height in CreateFontW means "character height in pixels"
	// rather than cell height — gives more predictable sizing across DPIs.
	// Cast through int32 vars at runtime so the negative bit pattern
	// doesn't trip Go's constant overflow check on uintptr conversion.
	eyebrowHeight := int32(-10)
	bodyHeight := int32(-13)
	weightMedium := int32(fwMedium)
	weightNormal := int32(fwNormal)

	// Eyebrow font — uppercase mono, medium weight.
	eyebrowFace, _ := syscall.UTF16PtrFromString("JetBrains Mono")
	eyebrowFont, _, _ := procCreateFontW.Call(
		uintptr(eyebrowHeight),
		0, 0, 0,
		uintptr(weightMedium),
		0, 0, 0,
		uintptr(ansiCharset),
		0, 0,
		uintptr(antialiasedQuality),
		0,
		uintptr(unsafe.Pointer(eyebrowFace)),
	)
	defer procDeleteObjectGdi.Call(eyebrowFont)

	// Body font — Inter Tight if installed, else Segoe UI Variable / Segoe UI.
	bodyFace, _ := syscall.UTF16PtrFromString("Inter Tight")
	bodyFont, _, _ := procCreateFontW.Call(
		uintptr(bodyHeight),
		0, 0, 0,
		uintptr(weightNormal),
		0, 0, 0,
		uintptr(ansiCharset),
		0, 0,
		uintptr(antialiasedQuality),
		0,
		uintptr(unsafe.Pointer(bodyFace)),
	)
	defer procDeleteObjectGdi.Call(bodyFont)

	// Transparent text background — preserves the bubble fill underneath.
	procSetBkMode.Call(memDC, uintptr(bkModeTransparent))

	// Per-state colours. Speaking has dark bg → light text; listening has
	// paper bg → ink text + vermilion eyebrow.
	var bodyCol, eyebrowCol uint32
	if state == PebbleSpeaking {
		// Dark card: paper-tone text + paper eyebrow (so the JARVIS label
		// reads clearly against the ink background).
		bodyCol = colorRef(pebblePaperR, pebblePaperG, pebblePaperB)
		eyebrowCol = colorRef(pebblePaperR, pebblePaperG, pebblePaperB)
	} else {
		bodyCol = colorRef(pebbleInkR, pebbleInkG, pebbleInkB)
		eyebrowCol = colorRef(pebbleAccentR, pebbleAccentG, pebbleAccentB)
	}

	// Eyebrow row.
	procSelectObject.Call(memDC, eyebrowFont)
	procSetTextColor.Call(memDC, uintptr(eyebrowCol))
	nullTerm := int32(-1) // DrawText sentinel for null-terminated string
	eyebrowStr, _ := syscall.UTF16PtrFromString("JARVIS")
	eyebrowRect := pblRect{Left: 26, Top: 62, Right: 326, Bottom: 80}
	procDrawTextW.Call(
		memDC,
		uintptr(unsafe.Pointer(eyebrowStr)),
		uintptr(nullTerm),
		uintptr(unsafe.Pointer(&eyebrowRect)),
		uintptr(uint32(dtLeft|dtSingleLine|dtNoClip)),
	)

	// Body row. Bubble runs from y=50 to y=200; eyebrow ends at 80.
	// Reserve 84..192 for body so longer responses wrap up to ~6 lines
	// at 13 px line-height before getting clipped. End-ellipsis trims the
	// tail when even that runs out, so we never blow past the bubble edge.
	procSelectObject.Call(memDC, bodyFont)
	procSetTextColor.Call(memDC, uintptr(bodyCol))
	bodyStr, _ := syscall.UTF16PtrFromString(bodyText)
	bodyRect := pblRect{Left: 26, Top: 84, Right: 326, Bottom: 192}
	procDrawTextW.Call(
		memDC,
		uintptr(unsafe.Pointer(bodyStr)),
		uintptr(nullTerm),
		uintptr(unsafe.Pointer(&bodyRect)),
		uintptr(uint32(dtLeft|dtWordBreak|dtEndEllipsis|dtEditControl)),
	)
}
