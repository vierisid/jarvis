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
	dtCalcRect    = 0x00000400
	dtNoClip      = 0x00000100
	dtEndEllipsis = 0x00008000
	dtEditControl = 0x00002000
)

// Bubble layout constants — keep in sync with drawBubble in pebble_draw_windows.go.
// Bubble grew (W: 328→436, H cap: 200→440) so multi-paragraph answers fit
// without ellipsis; window also grew correspondingly in pebble_overlay_windows.go.
const (
	pebbleBubbleX0      = 12
	pebbleBubbleY0      = 50
	pebbleBubbleX1      = 448
	pebbleBubbleBodyX0  = 26  // body text left, with 14 px inner pad from the card
	pebbleBubbleBodyX1  = 434 // body text right, with 14 px inner pad
	pebbleBubbleBodyY0  = 84  // body text top, after the JARVIS eyebrow row
	pebbleBubbleBottomP = 12  // padding under the body text before the bubble border
	pebbleBubbleY1Min   = 108 // bubble bottom for a single short line — keeps the card from looking pinched
	pebbleBubbleY1Max   = 440 // window-imposed cap — keeps card inside the layered window
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

// resolveBodyText returns the body line for the bubble in this state, with
// dynamic text from SetText winning over the per-state placeholder.
func (s *pebbleServiceWindows) resolveBodyText(state PebbleState) string {
	dyn, _ := s.bubbleText.Load().(string)
	if dyn != "" && (state == PebbleListening || state == PebbleSpeaking) {
		return dyn
	}
	// Canonical placeholder copy lives in pebble_core.go.
	return defaultPebbleBodyText(state)
}

// makeBodyFont builds the body font (13 px Inter Tight, antialiased). The
// caller owns the returned HFONT and must DeleteObject it. Shared between
// measure (DT_CALCRECT) and paint passes so wrapping math is consistent.
func makeBodyFont() uintptr {
	bodyHeight := int32(-13)
	weightNormal := int32(fwNormal)
	bodyFace, _ := syscall.UTF16PtrFromString("Inter Tight")
	font, _, _ := procCreateFontW.Call(
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
	return font
}

// computeBubbleBottom measures how tall the bubble needs to be to fit the
// current body text (wrapped at the bubble's inner width). Result is clamped
// to [pebbleBubbleY1Min, pebbleBubbleY1Max] so single-line copy doesn't
// look pinched and long responses don't run past the layered window.
//
// Returns 0 when the bubble shouldn't be drawn at all (idle/thinking/working).
func (s *pebbleServiceWindows) computeBubbleBottom(memDC uintptr, state PebbleState) int32 {
	if state != PebbleListening && state != PebbleSpeaking {
		return 0
	}
	body := s.resolveBodyText(state)
	if body == "" {
		return pebbleBubbleY1Min
	}

	bodyFont := makeBodyFont()
	defer procDeleteObjectGdi.Call(bodyFont)

	prev, _, _ := procSelectObject.Call(memDC, bodyFont)
	defer procSelectObject.Call(memDC, prev)

	bodyStr, _ := syscall.UTF16PtrFromString(body)
	// DT_CALCRECT modifies the rect in place — Right stays fixed at the
	// bubble's inner width, Bottom comes back as the height required to
	// render the wrapped text without truncation.
	rect := pblRect{
		Left:   pebbleBubbleBodyX0,
		Top:    pebbleBubbleBodyY0,
		Right:  pebbleBubbleBodyX1,
		Bottom: pebbleBubbleBodyY0,
	}
	nullTerm := int32(-1)
	procDrawTextW.Call(
		memDC,
		uintptr(unsafe.Pointer(bodyStr)),
		uintptr(nullTerm),
		uintptr(unsafe.Pointer(&rect)),
		uintptr(uint32(dtLeft|dtWordBreak|dtCalcRect)),
	)

	bottom := rect.Bottom + int32(pebbleBubbleBottomP)
	if bottom < int32(pebbleBubbleY1Min) {
		bottom = int32(pebbleBubbleY1Min)
	}
	if bottom > int32(pebbleBubbleY1Max) {
		bottom = int32(pebbleBubbleY1Max)
	}
	return bottom
}

// drawBubbleText renders the riso "JARVIS" eyebrow + state-specific body
// line into the bubble area. Called from paint() after drawBubble has
// painted the rounded card background at alpha=255 — text writes opaque
// RGB onto those pixels, which is correct for pre-multiplied ARGB at α=255.
//
// bubbleY1 is the actual bubble bottom (computed via computeBubbleBottom)
// so the text rect tracks the auto-fitted card and ellipsis kicks in only
// when content would overflow the *capped* card.
func (s *pebbleServiceWindows) drawBubbleText(memDC uintptr, state PebbleState, bubbleY1 int32) {
	bodyText := s.resolveBodyText(state)
	if bodyText == "" {
		return
	}

	// Negative height in CreateFontW means "character height in pixels"
	// rather than cell height — gives more predictable sizing across DPIs.
	// Cast through int32 vars at runtime so the negative bit pattern
	// doesn't trip Go's constant overflow check on uintptr conversion.
	eyebrowHeight := int32(-10)
	weightMedium := int32(fwMedium)

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
	bodyFont := makeBodyFont()
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
	eyebrowRect := pblRect{Left: pebbleBubbleBodyX0, Top: 62, Right: pebbleBubbleBodyX1, Bottom: 80}
	procDrawTextW.Call(
		memDC,
		uintptr(unsafe.Pointer(eyebrowStr)),
		uintptr(nullTerm),
		uintptr(unsafe.Pointer(&eyebrowRect)),
		uintptr(uint32(dtLeft|dtSingleLine|dtNoClip)),
	)

	// Body row — fills from below the eyebrow down to the auto-fitted bubble
	// bottom (minus the bottom padding). End-ellipsis trims when content
	// would overflow the *capped* card; otherwise the bubble grew to fit.
	procSelectObject.Call(memDC, bodyFont)
	procSetTextColor.Call(memDC, uintptr(bodyCol))
	bodyStr, _ := syscall.UTF16PtrFromString(bodyText)
	bodyBottom := bubbleY1 - int32(pebbleBubbleBottomP)/2
	bodyRect := pblRect{
		Left:   pebbleBubbleBodyX0,
		Top:    pebbleBubbleBodyY0,
		Right:  pebbleBubbleBodyX1,
		Bottom: bodyBottom,
	}
	procDrawTextW.Call(
		memDC,
		uintptr(unsafe.Pointer(bodyStr)),
		uintptr(nullTerm),
		uintptr(unsafe.Pointer(&bodyRect)),
		uintptr(uint32(dtLeft|dtWordBreak|dtEndEllipsis|dtEditControl)),
	)
}

// repairBubbleTextAlpha clamps the alpha channel back to 255 across the
// bubble's text region. Win32 GDI DrawText into a 32-bit ARGB DIB
// corrupts the alpha byte on glyph pixels (and AA edges) — the bubble
// fill below set alpha=255, but DrawText leaves alpha=0 on the glyphs,
// so the text becomes transparent to the desktop under the layered
// window. We force alpha=255 across the bubble interior (well inside
// the rounded corners) to restore opacity. RGB is left untouched, so
// the glyph colour DrawText wrote stays correct.
//
// Trade-off: subpixel AA in the very edges of the text gets clobbered
// (alpha=255 means hard-edged glyphs), but text becomes visible — which
// is the bigger win.
func repairBubbleTextAlpha(pixels []uint32, bubbleY1 int32) {
	// Insets larger than the corner radius (6 px) so we don't accidentally
	// turn the transparent rounded-corner pixels opaque. Top inset starts
	// just above the eyebrow row (62) so the JARVIS label is repaired too.
	// Derive x1 from the bubble width: it used to be hardcoded to 332, which
	// (after the card grew to pebbleBubbleX1=448) left the right ~100 px of body
	// text — which lays out to pebbleBubbleBodyX1=434 — with alpha=0, i.e.
	// invisible. Span the full card interior instead.
	const (
		inset = 8                     // > corner radius (6)
		x0    = pebbleBubbleX0 + inset // 20
		x1    = pebbleBubbleX1 - inset // 440 — covers body text out to 434
		y0    = 56
	)
	y1 := int(bubbleY1) - 8
	if y1 <= y0 {
		return
	}
	if x1 > pebbleWindowW {
		return
	}
	for y := y0; y < y1; y++ {
		row := y * pebbleWindowW
		for x := x0; x < x1; x++ {
			pixels[row+x] |= 0xFF000000
		}
	}
}

// drawAnswerOverflowButtonText — "open full ↗" label centred inside the
// button. Tinted vermilion on the paper card, paper on the dark (speaking)
// card so it reads against both.
func (s *pebbleServiceWindows) drawAnswerOverflowButtonText(memDC uintptr, dark bool, bubbleY1 int32) {
	answerID, _ := s.answerOverflowID.Load().(string)
	if answerID == "" {
		return
	}
	procSetBkMode.Call(memDC, uintptr(bkModeTransparent))

	// JetBrains Mono for the label — small, uppercase-feel via tracking.
	face, _ := syscall.UTF16PtrFromString("JetBrains Mono")
	height := int32(-11)
	weight := int32(fwMedium)
	font, _, _ := procCreateFontW.Call(
		uintptr(height),
		0, 0, 0,
		uintptr(weight),
		0, 0, 0,
		uintptr(ansiCharset),
		0, 0,
		uintptr(antialiasedQuality),
		0,
		uintptr(unsafe.Pointer(face)),
	)
	defer procDeleteObjectGdi.Call(font)
	procSelectObject.Call(memDC, font)

	var col uint32
	if dark {
		col = colorRef(pebblePaperR, pebblePaperG, pebblePaperB)
	} else {
		col = colorRef(pebbleAccentR, pebbleAccentG, pebbleAccentB)
	}
	procSetTextColor.Call(memDC, uintptr(col))

	str, _ := syscall.UTF16PtrFromString("open full ↗")
	btnY0 := pebbleAnswerBtnTop(bubbleY1)
	r := pblRect{
		Left:   int32(pebbleAnswerBtnXLeft),
		Top:    btnY0,
		Right:  int32(pebbleAnswerBtnXRight),
		Bottom: btnY0 + pebbleAnswerBtnH,
	}
	const dtCenter = 0x00000001
	const dtVCenter = 0x00000004
	nullTerm := int32(-1)
	procDrawTextW.Call(memDC,
		uintptr(unsafe.Pointer(str)),
		uintptr(nullTerm),
		uintptr(unsafe.Pointer(&r)),
		uintptr(uint32(dtCenter|dtVCenter|dtSingleLine)),
	)
}
