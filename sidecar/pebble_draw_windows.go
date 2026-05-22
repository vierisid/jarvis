//go:build windows

package main

import "math"

// Riso colours — mirror docs/mockups/ambient-ux/06-pebble-os.html.
const (
	pebblePaperR, pebblePaperG, pebblePaperB uint8 = 0xF5, 0xF2, 0xEB // --paper #F5F2EB
	pebbleInkR, pebbleInkG, pebbleInkB       uint8 = 0x1A, 0x1A, 0x1A // --ink #1A1A1A
	pebbleInk3R, pebbleInk3G, pebbleInk3B    uint8 = 0x6A, 0x67, 0x60 // --ink-3 #6A6760
	pebbleRuleR, pebbleRuleG, pebbleRuleB    uint8 = 0xCB, 0xC3, 0xB2 // --rule #CBC3B2
	pebbleAccentR, pebbleAccentG, pebbleAccentB uint8 = 0xC2, 0x3A, 0x2A // --accent #C23A2A
	pebbleWarmR, pebbleWarmG, pebbleWarmB    uint8 = 0x8A, 0x6A, 0x1F // --warn #8A6A1F
)

// premultiply produces a pre-multiplied ARGB pixel suitable for
// UpdateLayeredWindow's ULW_ALPHA blend (each colour channel scaled by alpha).
func premultiply(a uint8, r, g, b uint8) uint32 {
	ar := uint32(uint16(r) * uint16(a) / 255)
	ag := uint32(uint16(g) * uint16(a) / 255)
	ab := uint32(uint16(b) * uint16(a) / 255)
	return uint32(a)<<24 | ar<<16 | ag<<8 | ab
}

// blendOver does standard "src over dst" alpha compositing on already-
// premultiplied pixels. Used to layer glyphs over the disc, the disc over
// the shadow, etc.
func blendOver(dst, src uint32) uint32 {
	srcA := src >> 24
	if srcA == 0 {
		return dst
	}
	if srcA == 255 {
		return src
	}
	dstA := dst >> 24
	dstR := (dst >> 16) & 0xFF
	dstG := (dst >> 8) & 0xFF
	dstB := dst & 0xFF
	srcR := (src >> 16) & 0xFF
	srcG := (src >> 8) & 0xFF
	srcB := src & 0xFF
	inv := 255 - srcA

	outA := srcA + (dstA*inv)/255
	outR := srcR + (dstR*inv)/255
	outG := srcG + (dstG*inv)/255
	outB := srcB + (dstB*inv)/255
	return outA<<24 | outR<<16 | outG<<8 | outB
}

// fillCircle paints a disc centred at (cx, cy) with radius r and the given
// colour. Edge AA over a 1-px band. Each pixel is composited with whatever's
// already in the buffer (so subsequent draws layer correctly).
func fillCircle(pixels []uint32, cx, cy, r float64, col uint32) {
	x0 := int(math.Floor(cx - r - 1))
	y0 := int(math.Floor(cy - r - 1))
	x1 := int(math.Ceil(cx + r + 1))
	y1 := int(math.Ceil(cy + r + 1))
	if x0 < 0 {
		x0 = 0
	}
	if y0 < 0 {
		y0 = 0
	}
	if x1 > pebbleWindowW {
		x1 = pebbleWindowW
	}
	if y1 > pebbleWindowH {
		y1 = pebbleWindowH
	}
	colA := uint8(col >> 24)
	for py := y0; py < y1; py++ {
		for px := x0; px < x1; px++ {
			dx := float64(px) + 0.5 - cx
			dy := float64(py) + 0.5 - cy
			d := math.Sqrt(dx*dx + dy*dy)
			a := edgeAA(d, r)
			if a <= 0 {
				continue
			}
			scaledAlpha := uint8(float64(colA) * a)
			if scaledAlpha == 0 {
				continue
			}
			r8 := uint8((col >> 16) & 0xFF)
			g8 := uint8((col >> 8) & 0xFF)
			b8 := uint8(col & 0xFF)
			// reverse premultiply (the original col is premultiplied with its
			// own alpha; rescale to the new partial alpha).
			if colA > 0 {
				r8 = uint8(uint16(r8) * uint16(scaledAlpha) / uint16(colA))
				g8 = uint8(uint16(g8) * uint16(scaledAlpha) / uint16(colA))
				b8 = uint8(uint16(b8) * uint16(scaledAlpha) / uint16(colA))
			}
			src := uint32(scaledAlpha)<<24 | uint32(r8)<<16 | uint32(g8)<<8 | uint32(b8)
			pixels[py*pebbleWindowW+px] = blendOver(pixels[py*pebbleWindowW+px], src)
		}
	}
}

// strokeCircle paints a hairline ring around a disc — useful for the
// hairline border that defines the riso pebble's edge.
func strokeCircle(pixels []uint32, cx, cy, r, thickness float64, col uint32) {
	x0 := int(math.Floor(cx - r - 1))
	y0 := int(math.Floor(cy - r - 1))
	x1 := int(math.Ceil(cx + r + 1))
	y1 := int(math.Ceil(cy + r + 1))
	if x0 < 0 {
		x0 = 0
	}
	if y0 < 0 {
		y0 = 0
	}
	if x1 > pebbleWindowW {
		x1 = pebbleWindowW
	}
	if y1 > pebbleWindowH {
		y1 = pebbleWindowH
	}
	colA := uint8(col >> 24)
	innerR := r - thickness
	for py := y0; py < y1; py++ {
		for px := x0; px < x1; px++ {
			dx := float64(px) + 0.5 - cx
			dy := float64(py) + 0.5 - cy
			d := math.Sqrt(dx*dx + dy*dy)
			outerAA := edgeAA(d, r)
			innerAA := edgeAA(d, innerR)
			a := outerAA - innerAA
			if a <= 0 {
				continue
			}
			scaled := uint8(float64(colA) * a)
			if scaled == 0 {
				continue
			}
			r8 := uint8((col >> 16) & 0xFF)
			g8 := uint8((col >> 8) & 0xFF)
			b8 := uint8(col & 0xFF)
			if colA > 0 {
				r8 = uint8(uint16(r8) * uint16(scaled) / uint16(colA))
				g8 = uint8(uint16(g8) * uint16(scaled) / uint16(colA))
				b8 = uint8(uint16(b8) * uint16(scaled) / uint16(colA))
			}
			src := uint32(scaled)<<24 | uint32(r8)<<16 | uint32(g8)<<8 | uint32(b8)
			pixels[py*pebbleWindowW+px] = blendOver(pixels[py*pebbleWindowW+px], src)
		}
	}
}

// edgeAA — full alpha until r-0.5, linear fade to 0 across 1 px.
func edgeAA(d, r float64) float64 {
	if d <= r-0.5 {
		return 1
	}
	if d >= r+0.5 {
		return 0
	}
	return r + 0.5 - d
}

// drawState dispatches to the per-state renderer. bubbleY1 is the
// auto-fitted bubble bottom (computed from the wrapped body text height
// in computeBubbleBottom); 0 means "no bubble this frame".
func (s *pebbleServiceWindows) drawState(pixels []uint32, state PebbleState, bubbleY1 int32) {
	switch state {
	case PebbleListening, PebbleSpeaking:
		s.drawListeningOrSpeaking(pixels, state == PebbleSpeaking)
		s.drawBubble(pixels, state == PebbleSpeaking, float64(bubbleY1))
	case PebbleThinking:
		s.drawThinking(pixels)
	case PebbleWorking:
		s.drawWorking(pixels)
	default:
		s.drawIdle(pixels)
	}
}

// drawBubble — paper card that drops below the pebble during listening
// and speaking. Riso aesthetic: rounded paper rect with hairline rule
// border + hard offset shadow. Card height is dynamic: bubbleY1 is
// computed from the actual wrapped body text so the card never wastes
// space below short responses.
func (s *pebbleServiceWindows) drawBubble(pixels []uint32, dark bool, bubbleY1 float64) {
	// Bubble bounds: top + width are fixed; bottom comes from the caller
	// (auto-fit). cornerR + shadow keep the riso aesthetic identical
	// regardless of card height.
	// Bubble bounds derived from the constants in pebble_text_windows.go
	// so width changes in one place propagate everywhere.
	const (
		bubbleX0 = float64(pebbleBubbleX0)
		bubbleY0 = float64(pebbleBubbleY0)
		bubbleX1 = float64(pebbleBubbleX1)
		cornerR  = 6.0
		shadow   = 4.0 // riso 4×4 hard offset shadow
	)
	if bubbleY1 < bubbleY0+10 {
		// Fallback for safety — should never happen since paint clamps
		// to pebbleBubbleY1Min, but keeps drawBubble robust on its own.
		bubbleY1 = bubbleY0 + float64(pebbleBubbleY1Min-pebbleBubbleY0)
	}

	bgR, bgG, bgB := pebblePaperR, pebblePaperG, pebblePaperB
	borderR, borderG, borderB := pebbleRuleR, pebbleRuleG, pebbleRuleB
	if dark {
		// Speaking variant: dark ink card (matches the speaking pebble).
		bgR, bgG, bgB = pebbleInkR, pebbleInkG, pebbleInkB
		borderR, borderG, borderB = pebbleInkR, pebbleInkG, pebbleInkB
	}

	// Hard offset shadow underneath.
	fillRoundedRect(pixels,
		bubbleX0+shadow, bubbleY0+shadow,
		bubbleX1+shadow, bubbleY1+shadow,
		cornerR,
		premultiply(31, pebbleInkR, pebbleInkG, pebbleInkB), // ~12% alpha
	)

	// Card fill.
	fillRoundedRect(pixels, bubbleX0, bubbleY0, bubbleX1, bubbleY1, cornerR,
		premultiply(255, bgR, bgG, bgB))

	// Hairline border.
	strokeRoundedRect(pixels, bubbleX0, bubbleY0, bubbleX1, bubbleY1, cornerR, 1.0,
		premultiply(255, borderR, borderG, borderB))
}

// drawIdle — the riso "tiny companion": hard offset shadow, paper-tone disc,
// hairline ink-3 border, small ink-3 centre dot. Subtle breathing pulse on
// the dot's opacity for life.
func (s *pebbleServiceWindows) drawIdle(pixels []uint32) {
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	const discR = 8.0    // ~16 px diameter (slightly bigger so border + dot fit nicely)
	const dotR = 2.0     // small centre dot
	const shadowOffset = 2.0

	// 1) Hard offset shadow — disc shape, ink at 10% alpha, 2 px down-right.
	fillCircle(pixels, cx+shadowOffset, cy+shadowOffset, discR,
		premultiply(26, pebbleInkR, pebbleInkG, pebbleInkB)) // ~10% of 255 = 26

	// 2) Paper-tone disc fill.
	fillCircle(pixels, cx, cy, discR,
		premultiply(255, pebblePaperR, pebblePaperG, pebblePaperB))

	// 3) Hairline border (1 px ring at the edge, --rule colour).
	strokeCircle(pixels, cx, cy, discR, 1.0,
		premultiply(255, pebbleRuleR, pebbleRuleG, pebbleRuleB))

	// 4) Centre dot — ink-3, breathing opacity (4 s cycle, 50%–100%).
	phase := float64(s.frameTick%240) / 240.0
	breathe := 0.5 + 0.5*math.Sin(phase*2*math.Pi)
	dotAlpha := uint8(128 + 127*breathe)
	fillCircle(pixels, cx, cy, dotR,
		premultiply(dotAlpha, pebbleInk3R, pebbleInk3G, pebbleInk3B))
}

// drawListeningOrSpeaking — wider pill with 4 animated waveform bars.
// Listening uses paper bg with vermilion bars + accent border.
// Speaking uses ink bg with paper bars.
func (s *pebbleServiceWindows) drawListeningOrSpeaking(pixels []uint32, speaking bool) {
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	pillW := 36.0 // half-width
	pillH := 9.0  // half-height
	const shadowOffset = 2.0

	bgR, bgG, bgB := pebblePaperR, pebblePaperG, pebblePaperB
	borderR, borderG, borderB := pebbleAccentR, pebbleAccentG, pebbleAccentB
	barR, barG, barB := pebbleAccentR, pebbleAccentG, pebbleAccentB
	if speaking {
		bgR, bgG, bgB = pebbleInkR, pebbleInkG, pebbleInkB
		borderR, borderG, borderB = pebbleInkR, pebbleInkG, pebbleInkB
		barR, barG, barB = pebblePaperR, pebblePaperG, pebblePaperB
	}

	// Hard offset shadow (pill-shaped, approximated as filled rounded rect).
	fillRoundedRect(pixels, cx-pillW+shadowOffset, cy-pillH+shadowOffset,
		cx+pillW+shadowOffset, cy+pillH+shadowOffset, pillH,
		premultiply(26, pebbleInkR, pebbleInkG, pebbleInkB))

	// Background pill.
	fillRoundedRect(pixels, cx-pillW, cy-pillH, cx+pillW, cy+pillH, pillH,
		premultiply(255, bgR, bgG, bgB))

	// Hairline border (slightly thicker for active states).
	strokeRoundedRect(pixels, cx-pillW, cy-pillH, cx+pillW, cy+pillH, pillH, 1.0,
		premultiply(255, borderR, borderG, borderB))

	// 4 wave bars centred — heights phased so they undulate.
	const barCount = 4
	const barW = 2.0
	const barGap = 2.5
	totalW := barCount*barW + (barCount-1)*barGap
	startX := cx - totalW/2
	for i := 0; i < barCount; i++ {
		bx := startX + float64(i)*(barW+barGap)
		// Phase offset 0.09 s per bar matches the riso CSS animation-delay.
		phase := float64(s.frameTick%57)/57.0 + float64(i)*0.18
		v := 0.5 + 0.5*math.Sin(phase*2*math.Pi)
		barH := 2.5 + v*5.5 // 2.5..8 px tall
		fillRoundedRect(pixels, bx, cy-barH/2, bx+barW, cy+barH/2, barW/2,
			premultiply(255, barR, barG, barB))
	}
}

// drawThinking — narrower pill with 3 bouncing ink-3 dots.
func (s *pebbleServiceWindows) drawThinking(pixels []uint32) {
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	pillW := 14.0
	pillH := 6.0
	const shadowOffset = 2.0

	fillRoundedRect(pixels, cx-pillW+shadowOffset, cy-pillH+shadowOffset,
		cx+pillW+shadowOffset, cy+pillH+shadowOffset, pillH,
		premultiply(26, pebbleInkR, pebbleInkG, pebbleInkB))

	fillRoundedRect(pixels, cx-pillW, cy-pillH, cx+pillW, cy+pillH, pillH,
		premultiply(255, pebblePaperR, pebblePaperG, pebblePaperB))

	strokeRoundedRect(pixels, cx-pillW, cy-pillH, cx+pillW, cy+pillH, pillH, 1.0,
		premultiply(255, pebbleRuleR, pebbleRuleG, pebbleRuleB))

	const dotCount = 3
	const dotR = 1.4
	const dotGap = 4.0
	totalW := (dotCount-1) * dotGap
	startX := cx - float64(totalW)/2
	for i := 0; i < dotCount; i++ {
		phase := float64(s.frameTick%78)/78.0 + float64(i)*0.15
		bounce := math.Sin(phase * 2 * math.Pi)
		// Bounce mostly down (positive y), opacity peaks on bounce.
		alpha := uint8(89 + 165*math.Max(0, bounce)) // 35%–100%
		fillCircle(pixels, startX+float64(i)*dotGap, cy-bounce*1.5, dotR,
			premultiply(alpha, pebbleInk3R, pebbleInk3G, pebbleInk3B))
	}
}

// drawWorking — wider amber-bordered pill with a sweeping progress
// bar travelling left-to-right and back. T26 makes JARVIS-driven
// actions visually distinct from listening / thinking states; the
// sweep reads as "I'm doing something autonomously" at a glance.
func (s *pebbleServiceWindows) drawWorking(pixels []uint32) {
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	pillW := 24.0
	pillH := 8.0
	const shadowOffset = 2.0

	// Hard offset shadow.
	fillRoundedRect(pixels, cx-pillW+shadowOffset, cy-pillH+shadowOffset,
		cx+pillW+shadowOffset, cy+pillH+shadowOffset, pillH,
		premultiply(31, pebbleInkR, pebbleInkG, pebbleInkB))

	// Paper fill.
	fillRoundedRect(pixels, cx-pillW, cy-pillH, cx+pillW, cy+pillH, pillH,
		premultiply(255, pebblePaperR, pebblePaperG, pebblePaperB))

	// Amber-tinted hairline border — distinct from the paper-coloured
	// rule that listening / thinking use, so the user knows at a glance
	// that this isn't a normal voice cycle.
	strokeRoundedRect(pixels, cx-pillW, cy-pillH, cx+pillW, cy+pillH, pillH, 1.0,
		premultiply(255, pebbleWarmR, pebbleWarmG, pebbleWarmB))

	// Sweeping bar — travels left↔right inside the pill on a sine.
	// Period ≈ 1.6 s @ 60 fps so each sweep is leisurely but readable.
	phase := float64(s.frameTick%96) / 96.0
	t := math.Sin(phase * 2 * math.Pi) // -1..1
	sweepCenter := cx + t*(pillW-7)
	const sweepHalfW = 4.0
	const sweepHalfH = 3.0
	// Solid amber rounded rect for the sweep head.
	fillRoundedRect(pixels,
		sweepCenter-sweepHalfW, cy-sweepHalfH,
		sweepCenter+sweepHalfW, cy+sweepHalfH,
		sweepHalfH,
		premultiply(255, pebbleWarmR, pebbleWarmG, pebbleWarmB))
	// Trailing fade on the side opposite to motion direction. dT/dphase
	// gives the velocity sign — positive = moving right, fade to the left.
	vel := math.Cos(phase * 2 * math.Pi)
	for i := 1; i <= 3; i++ {
		offset := float64(i) * 4.0
		alpha := uint8(120 - i*30)
		var x float64
		if vel > 0 {
			x = sweepCenter - offset
		} else {
			x = sweepCenter + offset
		}
		fillCircle(pixels, x, cy, 1.6,
			premultiply(alpha, pebbleWarmR, pebbleWarmG, pebbleWarmB))
	}
}

// fillRoundedRect — filled rounded rectangle from (x0,y0) to (x1,y1) with
// corner radius r. Edge AA. Composited over whatever's in the buffer.
func fillRoundedRect(pixels []uint32, x0, y0, x1, y1, r float64, col uint32) {
	colA := uint8(col >> 24)
	if colA == 0 {
		return
	}
	ix0 := int(math.Floor(x0 - 1))
	iy0 := int(math.Floor(y0 - 1))
	ix1 := int(math.Ceil(x1 + 1))
	iy1 := int(math.Ceil(y1 + 1))
	if ix0 < 0 {
		ix0 = 0
	}
	if iy0 < 0 {
		iy0 = 0
	}
	if ix1 > pebbleWindowW {
		ix1 = pebbleWindowW
	}
	if iy1 > pebbleWindowH {
		iy1 = pebbleWindowH
	}
	r8 := uint8((col >> 16) & 0xFF)
	g8 := uint8((col >> 8) & 0xFF)
	b8 := uint8(col & 0xFF)
	for py := iy0; py < iy1; py++ {
		fy := float64(py) + 0.5
		for px := ix0; px < ix1; px++ {
			fx := float64(px) + 0.5
			a := roundedRectAA(fx, fy, x0, y0, x1, y1, r)
			if a <= 0 {
				continue
			}
			scaled := uint8(float64(colA) * a)
			if scaled == 0 {
				continue
			}
			rr := r8
			gg := g8
			bb := b8
			if colA > 0 {
				rr = uint8(uint16(r8) * uint16(scaled) / uint16(colA))
				gg = uint8(uint16(g8) * uint16(scaled) / uint16(colA))
				bb = uint8(uint16(b8) * uint16(scaled) / uint16(colA))
			}
			src := uint32(scaled)<<24 | uint32(rr)<<16 | uint32(gg)<<8 | uint32(bb)
			pixels[py*pebbleWindowW+px] = blendOver(pixels[py*pebbleWindowW+px], src)
		}
	}
}

// strokeRoundedRect — hairline outline of a rounded rectangle.
func strokeRoundedRect(pixels []uint32, x0, y0, x1, y1, r, thickness float64, col uint32) {
	colA := uint8(col >> 24)
	if colA == 0 {
		return
	}
	ix0 := int(math.Floor(x0 - 1))
	iy0 := int(math.Floor(y0 - 1))
	ix1 := int(math.Ceil(x1 + 1))
	iy1 := int(math.Ceil(y1 + 1))
	if ix0 < 0 {
		ix0 = 0
	}
	if iy0 < 0 {
		iy0 = 0
	}
	if ix1 > pebbleWindowW {
		ix1 = pebbleWindowW
	}
	if iy1 > pebbleWindowH {
		iy1 = pebbleWindowH
	}
	r8 := uint8((col >> 16) & 0xFF)
	g8 := uint8((col >> 8) & 0xFF)
	b8 := uint8(col & 0xFF)
	for py := iy0; py < iy1; py++ {
		fy := float64(py) + 0.5
		for px := ix0; px < ix1; px++ {
			fx := float64(px) + 0.5
			outerA := roundedRectAA(fx, fy, x0, y0, x1, y1, r)
			innerA := roundedRectAA(fx, fy, x0+thickness, y0+thickness, x1-thickness, y1-thickness, r-thickness)
			a := outerA - innerA
			if a <= 0 {
				continue
			}
			scaled := uint8(float64(colA) * a)
			if scaled == 0 {
				continue
			}
			rr := r8
			gg := g8
			bb := b8
			if colA > 0 {
				rr = uint8(uint16(r8) * uint16(scaled) / uint16(colA))
				gg = uint8(uint16(g8) * uint16(scaled) / uint16(colA))
				bb = uint8(uint16(b8) * uint16(scaled) / uint16(colA))
			}
			src := uint32(scaled)<<24 | uint32(rr)<<16 | uint32(gg)<<8 | uint32(bb)
			pixels[py*pebbleWindowW+px] = blendOver(pixels[py*pebbleWindowW+px], src)
		}
	}
}

// roundedRectAA returns 0..1 alpha coverage for the pixel at (x, y) inside
// a rounded rectangle from (x0,y0) to (x1,y1) with corner radius r.
func roundedRectAA(x, y, x0, y0, x1, y1, r float64) float64 {
	// signed distance to the rounded rect (negative inside, positive outside)
	hw := (x1 - x0) / 2
	hh := (y1 - y0) / 2
	cx := (x0 + x1) / 2
	cy := (y0 + y1) / 2
	dx := math.Abs(x-cx) - (hw - r)
	dy := math.Abs(y-cy) - (hh - r)
	dxClamped := math.Max(dx, 0)
	dyClamped := math.Max(dy, 0)
	outside := math.Sqrt(dxClamped*dxClamped + dyClamped*dyClamped)
	inside := math.Min(math.Max(dx, dy), 0)
	d := outside + inside - r
	// Convert signed distance to alpha (1 inside, 0 outside, AA over 1 px).
	if d <= -0.5 {
		return 1
	}
	if d >= 0.5 {
		return 0
	}
	return 0.5 - d
}

// drawControllingHalo (W6-T4) — when the pebble is in "pointing" mode
// (PointAt is active during desktop_click animations), paint a brief
// vermilion outward halo around the disc so the user reads the motion
// as "JARVIS reaching out to click" rather than ambient cursor follow.
// Pulses for the duration of the point.
func (s *pebbleServiceWindows) drawControllingHalo(pixels []uint32) {
	if !s.pointing.Load() {
		return
	}
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	// 1.2s cycle, 30%–60% alpha — never fully solid so the disc itself
	// stays the focal point.
	const cycleFrames = 75
	phase := float64(s.frameTick%cycleFrames) / float64(cycleFrames)
	v := phase * 2
	if v > 1 {
		v = 2 - v
	}
	alpha := uint8(77 + 76*v)
	// Two-ring halo at radii 11 and 14 — gives the "broadcasting"
	// double-ring feel without a big visual footprint.
	strokeCircle(pixels, cx, cy, 11.5, 1.0, premultiply(alpha, pebbleAccentR, pebbleAccentG, pebbleAccentB))
	strokeCircle(pixels, cx, cy, 14.0, 1.0, premultiply(alpha/2, pebbleAccentR, pebbleAccentG, pebbleAccentB))
}

// drawEyeGlyph (W6-T1/T2) — paints a small ambient indicator next to the
// pebble disc that says whether JARVIS can currently see the screen.
//
//   eyeActive && !blinded → pulsing accent (vermilion) eye → "I just saw"
//   blinded               → muted ink-3 eye with a struck-through line
//   neither               → no glyph
//
// Geometry: ~8 px wide oval lens with a 2 px iris dot. Positioned to the
// upper-right of the disc anchor so the bubble (which drops below) never
// overlaps. All drawn into the same DIB the rest of the pebble renders to.
func (s *pebbleServiceWindows) drawEyeGlyph(pixels []uint32) {
	blinded := s.blinded.Load()
	eye := s.eyeActive.Load()
	if !eye && !blinded {
		return
	}

	// Anchor: ~12 px above the disc, 14 px right of disc center.
	ex := float64(pebbleAnchorX) + 14.0
	ey := float64(pebbleAnchorY) - 10.0
	const lensRX = 4.5 // horizontal radius
	const lensRY = 2.6 // vertical radius (oval is wider than tall)
	const irisR = 1.4

	// Pick color: blinded = ink-3 (muted), active = accent (vermilion).
	var r, g, b uint8
	if blinded {
		r, g, b = pebbleInk3R, pebbleInk3G, pebbleInk3B
	} else {
		r, g, b = pebbleAccentR, pebbleAccentG, pebbleAccentB
	}

	// 1) Lens outline — approximated as an oval via two arcs of strokeCircle
	//    at slightly different radii (simple but readable at this size).
	//    Stroke at ex,ey with the larger radius for the body.
	strokeCircle(pixels, ex, ey, lensRX, 1.0, premultiply(220, r, g, b))

	// 2) Iris dot — solid circle in the center. When eyeActive, pulse
	//    its alpha for a subtle "just saw" beacon.
	irisAlpha := uint8(220)
	if eye && !blinded {
		// 1.2 s cycle, 70%–100% alpha.
		const cycleFrames = 75
		phase := float64(s.frameTick%cycleFrames) / float64(cycleFrames)
		v := phase * 2
		if v > 1 {
			v = 2 - v
		}
		irisAlpha = uint8(178 + 77*v)
	}
	fillCircle(pixels, ex, ey, irisR, premultiply(irisAlpha, r, g, b))

	// 3) Strike-through (only when blinded) — a thin diagonal line over
	//    the lens. Sample pixels along the diagonal and write a 1-px
	//    accent line so the user knows awareness is OFF.
	if blinded {
		// Diagonal from (ex-lensRX-1, ey+lensRY+1) to (ex+lensRX+1, ey-lensRY-1).
		x0 := ex - lensRX - 1.5
		y0 := ey + lensRY + 1.5
		x1 := ex + lensRX + 1.5
		y1 := ey - lensRY - 1.5
		strokeLine(pixels, x0, y0, x1, y1, 1.0, premultiply(255, pebbleAccentR, pebbleAccentG, pebbleAccentB))
	}
}

// strokeLine paints a 1-px-thick line between two points using a simple
// pixel-by-pixel rasterizer. Good enough for the eye glyph's strike-through
// at this scale — full AA isn't worth the complexity for one diagonal.
func strokeLine(pixels []uint32, x0, y0, x1, y1, _ float64, col uint32) {
	dx := x1 - x0
	dy := y1 - y0
	steps := int(maxAbs(dx, dy)) + 1
	if steps < 2 {
		return
	}
	for i := 0; i <= steps; i++ {
		t := float64(i) / float64(steps)
		px := int(x0 + dx*t + 0.5)
		py := int(y0 + dy*t + 0.5)
		if px < 0 || px >= pebbleWindowW || py < 0 || py >= pebbleWindowH {
			continue
		}
		pixels[py*pebbleWindowW+px] = blendOver(pixels[py*pebbleWindowW+px], col)
	}
}

func maxAbs(a, b float64) float64 {
	if a < 0 {
		a = -a
	}
	if b < 0 {
		b = -b
	}
	if a > b {
		return a
	}
	return b
}

// Open-full button (long-answer overflow) — sits in the bottom-right of
// the speaking bubble when SetAnswerOverflow was called with a non-empty
// id. WndProc reads these constants to compute the hit-test area.
const (
	pebbleAnswerBtnW       = 108
	pebbleAnswerBtnH       = 22
	pebbleAnswerBtnInsetR  = 10
	pebbleAnswerBtnInsetB  = 8
	pebbleAnswerBtnXLeft   = pebbleBubbleX1 - pebbleAnswerBtnInsetR - pebbleAnswerBtnW
	pebbleAnswerBtnXRight  = pebbleBubbleX1 - pebbleAnswerBtnInsetR
)

// pebbleAnswerBtnTop computes the button top Y given the current bubble
// bottom (which is dynamic via computeBubbleBottom). Same math used by
// paint and WndProc so they always agree.
func pebbleAnswerBtnTop(bubbleY1 int32) int32 {
	return bubbleY1 - pebbleAnswerBtnInsetB - pebbleAnswerBtnH
}

// drawAnswerOverflowButton — paper / dark pill with a tinted hairline
// border, anchored at the bubble's bottom-right. Only called when overflow
// is set. dark mirrors the speaking state (so the pill blends).
func (s *pebbleServiceWindows) drawAnswerOverflowButton(pixels []uint32, dark bool, bubbleY1 int32) {
	answerID, _ := s.answerOverflowID.Load().(string)
	if answerID == "" {
		return
	}
	btnY0 := pebbleAnswerBtnTop(bubbleY1)
	btnY1 := btnY0 + pebbleAnswerBtnH
	const radius = 5.0

	// Subtle accent-tinted fill so the button reads as interactive.
	tintR, tintG, tintB := pebbleAccentR, pebbleAccentG, pebbleAccentB
	fillAlpha := uint8(36)
	borderAlpha := uint8(220)
	if dark {
		// Speaking variant: dark card needs a lighter tint that reads on ink.
		tintR, tintG, tintB = pebblePaperR, pebblePaperG, pebblePaperB
		fillAlpha = 32
		borderAlpha = 200
	}
	fillRoundedRect(pixels,
		float64(pebbleAnswerBtnXLeft), float64(btnY0),
		float64(pebbleAnswerBtnXRight), float64(btnY1),
		radius,
		premultiply(fillAlpha, tintR, tintG, tintB),
	)
	strokeRoundedRect(pixels,
		float64(pebbleAnswerBtnXLeft), float64(btnY0),
		float64(pebbleAnswerBtnXRight), float64(btnY1),
		radius, 1.0,
		premultiply(borderAlpha, tintR, tintG, tintB),
	)
}
