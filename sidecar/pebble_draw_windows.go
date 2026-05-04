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

// drawState dispatches to the per-state renderer.
func (s *pebbleServiceWindows) drawState(pixels []uint32, state PebbleState) {
	switch state {
	case PebbleListening, PebbleSpeaking:
		s.drawListeningOrSpeaking(pixels, state == PebbleSpeaking)
		s.drawBubble(pixels, state == PebbleSpeaking)
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
// border + hard offset shadow. Text rendering lands in W2-T15.
func (s *pebbleServiceWindows) drawBubble(pixels []uint32, dark bool) {
	// Bubble bounds: starts ~22 px below the pebble anchor, extends
	// across most of the window width, ~150 px tall — fits the riso
	// thread layout (header + body + actions + hint).
	const (
		bubbleX0 = 12.0
		bubbleY0 = 50.0
		bubbleX1 = 340.0
		bubbleY1 = 200.0
		cornerR  = 6.0
		shadow   = 4.0 // riso 4×4 hard offset shadow
	)

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

// drawWorking — paper pill with a pulsing amber dot.
func (s *pebbleServiceWindows) drawWorking(pixels []uint32) {
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	pillW := 18.0
	pillH := 7.0
	const shadowOffset = 2.0

	fillRoundedRect(pixels, cx-pillW+shadowOffset, cy-pillH+shadowOffset,
		cx+pillW+shadowOffset, cy+pillH+shadowOffset, pillH,
		premultiply(26, pebbleInkR, pebbleInkG, pebbleInkB))

	fillRoundedRect(pixels, cx-pillW, cy-pillH, cx+pillW, cy+pillH, pillH,
		premultiply(255, pebblePaperR, pebblePaperG, pebblePaperB))

	strokeRoundedRect(pixels, cx-pillW, cy-pillH, cx+pillW, cy+pillH, pillH, 1.0,
		premultiply(255, pebbleRuleR, pebbleRuleG, pebbleRuleB))

	// Amber dot pulses scale.
	phase := float64(s.frameTick%96) / 96.0
	pulse := 0.85 + 0.15*math.Sin(phase*2*math.Pi)
	dotR := 2.5 * pulse
	fillCircle(pixels, cx-pillW+5, cy, dotR,
		premultiply(255, pebbleWarmR, pebbleWarmG, pebbleWarmB))
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
