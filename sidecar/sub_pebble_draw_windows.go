//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

// bubbleHeightForEntry decides bubble height per-entry: tall when there's
// a real result/summary to display, compact when only the running
// placeholder is shown. Two-state heuristic — cheaper than full
// DT_CALCRECT but enough to stop ellipsizing summaries.
func bubbleHeightForEntry(entry *subPebbleEntry) int {
	result, _ := entry.result.Load().(string)
	// Show tall when result is present AND meaningful (not the
	// "summarizing…" placeholder which is < 20 chars).
	if len(result) > 20 {
		return subPebbleBubbleHTall
	}
	return subPebbleBubbleHCompact
}

// computed bubble rect inside the 360×220 layered window. Height varies
// per entry — pass the entry so we read its current state.
func subPebbleBubbleRect(entry *subPebbleEntry) (x0, y0, x1, y1 int) {
	x1 = subPebbleAnchorX - 9 /* disc radius */ - subPebbleBubbleOffset
	x0 = x1 - subPebbleBubbleW
	y0 = subPebbleAnchorY - subPebbleBubbleAnchorY
	y1 = y0 + bubbleHeightForEntry(entry)
	return
}

// drawSubPebbleBubble paints the paper-card background to the left of the
// disc when entry.expanded is true. Same riso treatment as the main pebble:
// hard offset shadow, paper fill, hairline tinted border matching the
// sub-pebble's color (so the connection between card and disc is visible).
func (s *subPebbleServiceWindows) drawSubPebbleBubble(pixels []uint32, color SubPebbleColor, entry *subPebbleEntry) {
	r, g, b := subPebbleRGB(color)
	x0, y0, x1, y1 := subPebbleBubbleRect(entry)
	const radius = 13.0
	const shadowOffset = 3.0

	// 1) Hard offset shadow.
	fillRoundedRect(pixels,
		float64(x0)+shadowOffset, float64(y0)+shadowOffset,
		float64(x1)+shadowOffset, float64(y1)+shadowOffset,
		radius,
		premultiply(28, pebbleInkR, pebbleInkG, pebbleInkB),
	)

	// 2) Paper fill.
	fillRoundedRect(pixels,
		float64(x0), float64(y0), float64(x1), float64(y1), radius,
		premultiply(255, pebblePaperR, pebblePaperG, pebblePaperB),
	)

	// 3) Tinted hairline border.
	strokeRoundedRect(pixels,
		float64(x0), float64(y0), float64(x1), float64(y1), radius, 1.0,
		premultiply(178, r, g, b),
	)

	// 4) "Open full" button — paper pill with hairline tinted border.
	//    Only drawn when the bubble is expanded (which it always is when
	//    drawSubPebbleBubble is called, but keep explicit for clarity).
	bxR0 := x1 - subPebbleButtonInsetR - subPebbleButtonW
	byR0 := y1 - subPebbleButtonInsetB - subPebbleButtonH
	bxR1 := bxR0 + subPebbleButtonW
	byR1 := byR0 + subPebbleButtonH
	const btnRadius = 7.0
	// Soft fill — very light tint of the agent color so the button reads
	// as part of the bubble but obviously interactive.
	fillRoundedRect(pixels,
		float64(bxR0), float64(byR0), float64(bxR1), float64(byR1), btnRadius,
		premultiply(28, r, g, b),
	)
	strokeRoundedRect(pixels,
		float64(bxR0), float64(byR0), float64(bxR1), float64(byR1), btnRadius, 1.0,
		premultiply(178, r, g, b),
	)
	_ = entry
}

// drawSubPebbleBubbleText writes the agent name (eyebrow), task line, and
// result/elapsed footer into the bubble area via GDI DrawText. Called after
// drawSubPebbleBubble so the glyphs sit on the opaque paper fill.
//
// Layout (relative to the bubble rect):
//
//	y = top + 14    : eyebrow line — "AGENT NAME · 12s" in mono caps, tinted
//	y = top + 36    : task body — 2-line clamp, Inter Tight ink
//	y = top + 78    : result line — 2-line clamp, smaller, muted ink (only when present)
func (s *subPebbleServiceWindows) drawSubPebbleBubbleText(memDC uintptr, entry *subPebbleEntry) {
	bx0, by0, bx1, by1 := subPebbleBubbleRect(entry)
	_ = by1

	agent, _ := entry.label.Load().(string)
	if agent == "" {
		agent = "agent"
	}
	task, _ := entry.task.Load().(string)
	result, _ := entry.result.Load().(string)
	elapsed := int(entry.elapsedS.Load())
	color, _ := entry.color.Load().(SubPebbleColor)
	tr, tg, tb := subPebbleRGB(color)

	procSetBkMode.Call(memDC, uintptr(bkModeTransparent))

	nullTerm := int32(-1)
	// Eyebrow — mono uppercase, tinted to the sub-pebble's color.
	eyebrowFace, _ := syscall.UTF16PtrFromString("Spline Sans Mono")
	eyebrowHeight := int32(-12)
	weightMedium := int32(fwMedium)
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

	// Task body font — Familjen Grotesk, enlarged so the bubble reads at a glance.
	bodyFont := makeMdFont(int32(-15), int32(fwNormal), "Familjen Grotesk")
	defer procDeleteObjectGdi.Call(bodyFont)

	// Footer font (smaller body, muted color).
	footerHeight := int32(-11)
	weightNormal := int32(fwNormal)
	footerFont, _, _ := procCreateFontW.Call(
		uintptr(footerHeight),
		0, 0, 0,
		uintptr(weightNormal),
		0, 0, 0,
		uintptr(ansiCharset),
		0, 0,
		uintptr(antialiasedQuality),
		0,
		uintptr(unsafe.Pointer(eyebrowFace)), // mono for elapsed/result so digits align
	)
	defer procDeleteObjectGdi.Call(footerFont)

	// ── Eyebrow ──────────────────────────────────────────────
	// Capture the DC's original font and restore it before the deferred
	// DeleteObject calls run — a font still selected into the DC can't be
	// deleted, which leaked one HFONT per frame and crashed the overlay.
	prevObj, _, _ := procSelectObject.Call(memDC, eyebrowFont)
	defer procSelectObject.Call(memDC, prevObj)
	procSetTextColor.Call(memDC, uintptr(colorRef(tr, tg, tb)))
	eyebrowText := fmt.Sprintf("%s · %s", agent, formatSubPebbleElapsed(elapsed))
	eyebrowStr, _ := syscall.UTF16PtrFromString(eyebrowText)
	eyebrowRect := pblRect{
		Left:   int32(bx0 + subPebbleBubbleInnerPad),
		Top:    int32(by0 + 14),
		Right:  int32(bx1 - subPebbleBubbleInnerPad),
		Bottom: int32(by0 + 34),
	}
	procDrawTextW.Call(memDC,
		uintptr(unsafe.Pointer(eyebrowStr)),
		uintptr(nullTerm),
		uintptr(unsafe.Pointer(&eyebrowRect)),
		uintptr(uint32(dtLeft|dtSingleLine|dtEndEllipsis)),
	)

	// ── Task body ────────────────────────────────────────────
	if task != "" {
		procSelectObject.Call(memDC, bodyFont)
		procSetTextColor.Call(memDC, uintptr(colorRef(pebbleInkR, pebbleInkG, pebbleInkB)))
		taskStr, _ := syscall.UTF16PtrFromString(task)
		taskRect := pblRect{
			Left:   int32(bx0 + subPebbleBubbleInnerPad),
			Top:    int32(by0 + 40),
			Right:  int32(bx1 - subPebbleBubbleInnerPad),
			Bottom: int32(by0 + 84), // ends above the compact-mode button row
		}
		procDrawTextW.Call(memDC,
			uintptr(unsafe.Pointer(taskStr)),
			uintptr(nullTerm),
			uintptr(unsafe.Pointer(&taskRect)),
			uintptr(uint32(dtLeft|dtWordBreak|dtEndEllipsis)),
		)
	}

	// ── Result preview (only when present) ───────────────────
	// Bottom of result text leaves room for the "open full" button row.
	if result != "" {
		procSelectObject.Call(memDC, footerFont)
		procSetTextColor.Call(memDC, uintptr(colorRef(pebbleInk3R, pebbleInk3G, pebbleInk3B)))
		resultStr, _ := syscall.UTF16PtrFromString(result)
		resultBottom := by1 - subPebbleButtonInsetB - subPebbleButtonH - 8
		resultRect := pblRect{
			Left:   int32(bx0 + subPebbleBubbleInnerPad),
			Top:    int32(by0 + 90),
			Right:  int32(bx1 - subPebbleBubbleInnerPad),
			Bottom: int32(resultBottom),
		}
		procDrawTextW.Call(memDC,
			uintptr(unsafe.Pointer(resultStr)),
			uintptr(nullTerm),
			uintptr(unsafe.Pointer(&resultRect)),
			uintptr(uint32(dtLeft|dtWordBreak|dtEndEllipsis)),
		)
	}

	// ── "Open full ↗" button label ───────────────────────────
	{
		procSelectObject.Call(memDC, footerFont)
		tr, tg, tb := subPebbleRGB(color)
		procSetTextColor.Call(memDC, uintptr(colorRef(tr, tg, tb)))
		btnText, _ := syscall.UTF16PtrFromString("open full ↗")
		bxR0 := bx1 - subPebbleButtonInsetR - subPebbleButtonW
		byR0 := by1 - subPebbleButtonInsetB - subPebbleButtonH
		btnRect := pblRect{
			Left:   int32(bxR0),
			Top:    int32(byR0),
			Right:  int32(bxR0 + subPebbleButtonW),
			Bottom: int32(byR0 + subPebbleButtonH),
		}
		const dtCenter = 0x00000001
		const dtVCenter = 0x00000004
		procDrawTextW.Call(memDC,
			uintptr(unsafe.Pointer(btnText)),
			uintptr(nullTerm),
			uintptr(unsafe.Pointer(&btnRect)),
			uintptr(uint32(dtCenter|dtVCenter|dtSingleLine)),
		)
	}
}

// repairSubPebbleBubbleAlpha clamps glyph alpha to 255 across the bubble's
// interior so DrawText's broken alpha doesn't leave see-through letters.
// Same trick as repairBubbleTextAlpha for the main pebble. Insets a couple
// of pixels past the bubble's corner radius so we don't clobber the
// rounded-corner transparent pixels.
func repairSubPebbleBubbleAlpha(pixels []uint32, entry *subPebbleEntry) {
	x0, y0, x1, y1 := subPebbleBubbleRect(entry)
	const cornerInset = 10
	for y := y0 + cornerInset; y < y1-cornerInset; y++ {
		if y < 0 || y >= pebbleWindowH {
			continue
		}
		for x := x0 + cornerInset; x < x1-cornerInset; x++ {
			if x < 0 || x >= pebbleWindowW {
				continue
			}
			p := pixels[y*pebbleWindowW+x]
			if (p>>24)&0xFF == 0xFF {
				continue
			}
			// Glyph pixel — preserve RGB, force alpha = 255.
			pixels[y*pebbleWindowW+x] = 0xFF000000 | (p & 0x00FFFFFF)
		}
	}
}
