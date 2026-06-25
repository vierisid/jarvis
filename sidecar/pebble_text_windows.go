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
	if dyn != "" && state == PebbleSpeaking {
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
	bodyFace, _ := syscall.UTF16PtrFromString("Familjen Grotesk")
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
	if state != PebbleSpeaking {
		return 0
	}
	body := s.resolveBodyText(state)
	if body == "" {
		return pebbleBubbleY1Min
	}

	// Measure the markdown layout (headings/lists/paragraphs) so the card
	// grows to fit the rendered blocks, not a single wrapped run.
	procSetBkMode.Call(memDC, uintptr(bkModeTransparent))
	fonts := newMdFonts()
	defer fonts.delete()
	blocks := parseMarkdownBlocks(body)
	bodyBottom := layoutMarkdown(memDC, fonts, blocks,
		pebbleBubbleBodyX0, pebbleBubbleBodyX1,
		pebbleBubbleBodyY0, int32(pebbleBubbleY1Max), false)

	bottom := bodyBottom + int32(pebbleBubbleBottomP)
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

	// Transparent text background — preserves the bubble fill underneath.
	procSetBkMode.Call(memDC, uintptr(bkModeTransparent))

	// Eyebrow row — uppercase mono "JARVIS" in speak-blue. Negative height in
	// CreateFontW means character height in px (predictable across DPIs).
	eyebrowFont := makeMdFont(int32(-11), int32(fwMedium), "Spline Sans Mono")
	defer procDeleteObjectGdi.Call(eyebrowFont)
	prevEyebrow, _, _ := procSelectObject.Call(memDC, eyebrowFont)
	procSetTextColor.Call(memDC, uintptr(colorRef(pebbleSpeakTxR, pebbleSpeakTxG, pebbleSpeakTxB)))
	nullTerm := int32(-1)
	eyebrowStr, _ := syscall.UTF16PtrFromString("JARVIS")
	eyebrowRect := pblRect{Left: pebbleBubbleBodyX0, Top: 62, Right: pebbleBubbleBodyX1, Bottom: 80}
	procDrawTextW.Call(
		memDC,
		uintptr(unsafe.Pointer(eyebrowStr)),
		uintptr(nullTerm),
		uintptr(unsafe.Pointer(&eyebrowRect)),
		uintptr(uint32(dtLeft|dtSingleLine|dtNoClip)),
	)
	procSelectObject.Call(memDC, prevEyebrow) // restore before delete (no leak)

	// Body — rendered markdown (headings, lists, code, paragraphs) from below
	// the eyebrow down to the auto-fitted card bottom. layoutMarkdown stops at
	// maxY so it never paints past the capped card; the daemon registers an
	// "open full" overflow button when the answer is too long to fit.
	fonts := newMdFonts()
	defer fonts.delete()
	blocks := parseMarkdownBlocks(bodyText)
	layoutMarkdown(memDC, fonts, blocks,
		pebbleBubbleBodyX0, pebbleBubbleBodyX1,
		pebbleBubbleBodyY0, bubbleY1-int32(pebbleBubbleBottomP), true)
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
		inset = 8                      // > corner radius (6)
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
	prevFont, _, _ := procSelectObject.Call(memDC, font)
	defer procSelectObject.Call(memDC, prevFont) // restore before delete (no GDI leak)

	// The overflow button is now an ink-filled pill in both states → white text.
	_ = dark
	col := colorRef(pebblePaperR, pebblePaperG, pebblePaperB)
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
