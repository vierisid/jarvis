//go:build windows

package main

import "math"

// Brand Book III "Monochrome Lab" — mirrors ui/src/ambient/pebble.css.
// The pebble is the glass "drop": a translucent lens that breathes in one
// state hue at a time. (No backdrop blur in a software buffer — the glass is
// a translucent white body + a colored radial core + a soft glow + a hairline.)
const (
	pebbleInkR, pebbleInkG, pebbleInkB       uint8 = 0x13, 0x16, 0x1A // --ink
	pebbleInk3R, pebbleInk3G, pebbleInk3B    uint8 = 0x67, 0x70, 0x77 // --ink3
	pebbleRuleR, pebbleRuleG, pebbleRuleB    uint8 = 0xE2, 0xE7, 0xEC // --rule
	pebblePaperR, pebblePaperG, pebblePaperB uint8 = 0xFF, 0xFF, 0xFF // --raise (bubble bg)
	pebbleFaintR, pebbleFaintG, pebbleFaintB uint8 = 0x9A, 0xA2, 0xAB // --faint

	// state hues — the only chroma in the system
	pebbleListenR, pebbleListenG, pebbleListenB    uint8 = 0xE6, 0x3B, 0x2E // --listen
	pebbleSpeakR, pebbleSpeakG, pebbleSpeakB       uint8 = 0x2D, 0x78, 0xFF // --speak
	pebbleSpeakTxR, pebbleSpeakTxG, pebbleSpeakTxB uint8 = 0x1E, 0x5F, 0xD8 // --speak-tx (AA blue text)
	pebbleHoldR, pebbleHoldG, pebbleHoldB          uint8 = 0xEA, 0xA4, 0x0E // --hold
	pebbleOkR, pebbleOkG, pebbleOkB                uint8 = 0x2F, 0xA4, 0x5E // --ok

	// legacy aliases consumed by the halo / eye glyph — now the brand red.
	pebbleAccentR, pebbleAccentG, pebbleAccentB uint8 = pebbleListenR, pebbleListenG, pebbleListenB
	pebbleWarmR, pebbleWarmG, pebbleWarmB       uint8 = pebbleHoldR, pebbleHoldG, pebbleHoldB

	pebbleDiscR  = 13.0 // ~26 px drop, matches the web cursor pebble
	pebbleSharpR = 5.0  // the one sharp corner (web: border-radius … 6px)
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
// premultiplied pixels.
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

// fillCircle paints an AA disc, composited over the buffer.
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

// strokeCircle paints a hairline ring around a disc.
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

// fillRadial paints a soft radial gradient: alpha innerA at the centre, fading
// to 0 at radius r (eased). The colored core + outer glow of the glass drop.
func fillRadial(pixels []uint32, cx, cy, r float64, innerA uint8, rr, gg, bb uint8) {
	if innerA == 0 || r <= 0 {
		return
	}
	x0 := int(math.Floor(cx - r))
	y0 := int(math.Floor(cy - r))
	x1 := int(math.Ceil(cx + r))
	y1 := int(math.Ceil(cy + r))
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
	for py := y0; py < y1; py++ {
		for px := x0; px < x1; px++ {
			dx := float64(px) + 0.5 - cx
			dy := float64(py) + 0.5 - cy
			d := math.Sqrt(dx*dx + dy*dy)
			if d >= r {
				continue
			}
			t := 1 - d/r
			t = t * t // ease — concentrate light at the centre
			a := uint8(float64(innerA) * t)
			if a == 0 {
				continue
			}
			pixels[py*pebbleWindowW+px] = blendOver(pixels[py*pebbleWindowW+px], premultiply(a, rr, gg, bb))
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

// breathe returns a 0..1 sine over `frames` at 60fps, for state pulses.
func (s *pebbleServiceWindows) breathe(frames int) float64 {
	if frames <= 0 {
		return 1
	}
	ph := float64(s.frameTick%uint64(frames)) / float64(frames)
	return 0.5 + 0.5*math.Sin(ph*2*math.Pi)
}

// dropCoverage returns 0..1 AA coverage for pixel (px,py) inside the brand
// "drop": a rounded square with three 50% corners and one sharp corner,
// rotated 45° — i.e. a circle with one corner pulled to a point. Mirrors
// ui/src/ambient/pebble.css (border-radius:50% 50% 50% 6px; rotate(45deg)).
func dropCoverage(px, py, cx, cy, r, sharpR float64) float64 {
	const c = 0.70710678 // cos/sin 45°
	dx := px - cx
	dy := py - cy
	// screen → element-local frame (inverse of the CSS 45° rotation)
	u := dx*c + dy*c
	v := -dx*c + dy*c
	// per-corner radius: the bottom-left local corner is the sharp one.
	rad := r
	if u < 0 && v > 0 {
		rad = sharpR
	}
	qx := math.Abs(u) - r + rad
	qy := math.Abs(v) - r + rad
	mx := math.Max(qx, 0)
	my := math.Max(qy, 0)
	d := math.Min(math.Max(qx, qy), 0) + math.Sqrt(mx*mx+my*my) - rad
	if d <= -0.5 {
		return 1
	}
	if d >= 0.5 {
		return 0
	}
	return 0.5 - d
}

// fillDrop fills the drop shape with a colour (reverse-premultiplied AA).
func fillDrop(pixels []uint32, cx, cy, r, sharpR float64, col uint32) {
	ext := r*1.5 + 2
	x0 := clampInt(int(math.Floor(cx-ext)), 0, pebbleWindowW)
	y0 := clampInt(int(math.Floor(cy-ext)), 0, pebbleWindowH)
	x1 := clampInt(int(math.Ceil(cx+ext)), 0, pebbleWindowW)
	y1 := clampInt(int(math.Ceil(cy+ext)), 0, pebbleWindowH)
	colA := uint8(col >> 24)
	for py := y0; py < y1; py++ {
		for px := x0; px < x1; px++ {
			a := dropCoverage(float64(px)+0.5, float64(py)+0.5, cx, cy, r, sharpR)
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

// strokeDrop paints a hairline along the drop outline.
func strokeDrop(pixels []uint32, cx, cy, r, sharpR, thickness float64, col uint32) {
	ext := r*1.5 + 2
	x0 := clampInt(int(math.Floor(cx-ext)), 0, pebbleWindowW)
	y0 := clampInt(int(math.Floor(cy-ext)), 0, pebbleWindowH)
	x1 := clampInt(int(math.Ceil(cx+ext)), 0, pebbleWindowW)
	y1 := clampInt(int(math.Ceil(cy+ext)), 0, pebbleWindowH)
	colA := uint8(col >> 24)
	for py := y0; py < y1; py++ {
		for px := x0; px < x1; px++ {
			outer := dropCoverage(float64(px)+0.5, float64(py)+0.5, cx, cy, r, sharpR)
			inner := dropCoverage(float64(px)+0.5, float64(py)+0.5, cx, cy, r-thickness, math.Max(sharpR-thickness, 0.5))
			a := outer - inner
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

// fillDropRadial paints a radial colour fade clipped to the drop shape (the
// glowing core that reads through the glass, tip included).
func fillDropRadial(pixels []uint32, cx, cy, r, sharpR, radialR float64, innerA uint8, rr, gg, bb uint8) {
	if innerA == 0 {
		return
	}
	ext := r*1.5 + 2
	x0 := clampInt(int(math.Floor(cx-ext)), 0, pebbleWindowW)
	y0 := clampInt(int(math.Floor(cy-ext)), 0, pebbleWindowH)
	x1 := clampInt(int(math.Ceil(cx+ext)), 0, pebbleWindowW)
	y1 := clampInt(int(math.Ceil(cy+ext)), 0, pebbleWindowH)
	for py := y0; py < y1; py++ {
		for px := x0; px < x1; px++ {
			cov := dropCoverage(float64(px)+0.5, float64(py)+0.5, cx, cy, r, sharpR)
			if cov <= 0 {
				continue
			}
			dx := float64(px) + 0.5 - cx
			dy := float64(py) + 0.5 - cy
			d := math.Sqrt(dx*dx + dy*dy)
			t := 1.0
			if d < radialR {
				t = 1 - d/radialR
				t = t * t
			} else {
				t = 0
			}
			a := uint8(float64(innerA) * t * cov)
			if a == 0 {
				continue
			}
			pixels[py*pebbleWindowW+px] = blendOver(pixels[py*pebbleWindowW+px], premultiply(a, rr, gg, bb))
		}
	}
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// drawDrop paints the glass drop with a colored radial core + soft glow.
// coreAlpha / glowAlpha are 0..1; pass coreAlpha 0 for clear glass.
func (s *pebbleServiceWindows) drawDrop(pixels []uint32, cr, cg, cb uint8, coreAlpha, glowAlpha float64) {
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)

	// 1) outer glow — soft colored halo behind the lens.
	if glowAlpha > 0 {
		fillRadial(pixels, cx, cy+1, pebbleDiscR*2.1, uint8(glowAlpha*150), cr, cg, cb)
	}
	// 2) drop shadow — neutral, offset down.
	fillDrop(pixels, cx, cy+2, pebbleDiscR, pebbleSharpR, premultiply(40, pebbleInkR, pebbleInkG, pebbleInkB))
	// 3) glass body — translucent white.
	fillDrop(pixels, cx, cy, pebbleDiscR, pebbleSharpR, premultiply(120, 255, 255, 255))
	// 4) colored core — radial, clipped to the drop so the light reads through the glass.
	if coreAlpha > 0 {
		fillDropRadial(pixels, cx, cy, pebbleDiscR, pebbleSharpR, pebbleDiscR*1.05, uint8(coreAlpha*255), cr, cg, cb)
	}
	// 5) inner shine — top-left highlight, the glass cue.
	fillRadial(pixels, cx-pebbleDiscR*0.32, cy-pebbleDiscR*0.34, pebbleDiscR*0.7, 150, 255, 255, 255)
	// 6) hairline border along the drop outline.
	strokeDrop(pixels, cx, cy, pebbleDiscR, pebbleSharpR, 1.0, premultiply(90, pebbleInkR, pebbleInkG, pebbleInkB))
}

// drawState dispatches to the per-state renderer.
func (s *pebbleServiceWindows) drawState(pixels []uint32, state PebbleState, bubbleY1 int32) {
	switch state {
	case PebbleListening:
		// Just the red drop — no bubble; the user is talking, not reading.
		s.drawDrop(pixels, pebbleListenR, pebbleListenG, pebbleListenB, 0.55+0.45*s.breathe(84), 0.5)
	case PebbleSpeaking:
		// Just the blue drop — no transcript bubble. Voice-first: while JARVIS
		// talks you listen, you don't read a caption at the cursor. (Long
		// answers are still readable via the dashboard / "open full" panel.)
		s.drawDrop(pixels, pebbleSpeakR, pebbleSpeakG, pebbleSpeakB, 0.6+0.4*s.breathe(96), 0.5)
	case PebbleThinking:
		s.drawThinking(pixels)
	case PebbleWorking:
		s.drawDrop(pixels, pebbleSpeakR, pebbleSpeakG, pebbleSpeakB, 0.45+0.35*s.breathe(144), 0.35)
	case PebbleAsking:
		s.drawAsking(pixels)
	case PebbleDone:
		s.drawDrop(pixels, pebbleOkR, pebbleOkG, pebbleOkB, 0.9, 0.55)
	case PebbleMuted:
		s.drawMuted(pixels)
	default:
		s.drawIdle(pixels)
	}
}

// drawIdle — clear glass with a faint neutral presence that breathes.
func (s *pebbleServiceWindows) drawIdle(pixels []uint32) {
	s.drawDrop(pixels, pebbleInk3R, pebbleInk3G, pebbleInk3B, 0.18+0.16*s.breathe(240), 0)
}

// drawThinking — clear glass + a white dot orbiting the rim (processing).
func (s *pebbleServiceWindows) drawThinking(pixels []uint32) {
	s.drawDrop(pixels, pebbleInk3R, pebbleInk3G, pebbleInk3B, 0.16, 0)
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	ph := float64(s.frameTick%84) / 84.0
	ang := ph * 2 * math.Pi
	ox := cx + math.Cos(ang)*pebbleDiscR*0.62
	oy := cy + math.Sin(ang)*pebbleDiscR*0.62
	fillCircle(pixels, ox, oy, 2.0, premultiply(235, 255, 255, 255))
}

// drawAsking — amber core + an expanding fading ring (the attention pulse).
func (s *pebbleServiceWindows) drawAsking(pixels []uint32) {
	s.drawDrop(pixels, pebbleHoldR, pebbleHoldG, pebbleHoldB, 0.55+0.35*s.breathe(120), 0.4)
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	ph := float64(s.frameTick%120) / 120.0
	ringR := pebbleDiscR + ph*9
	ringA := uint8((1 - ph) * 120)
	strokeCircle(pixels, cx, cy, ringR, 1.2, premultiply(ringA, pebbleHoldR, pebbleHoldG, pebbleHoldB))
}

// drawMuted — quiet gray glass with a diagonal slash (mic off).
func (s *pebbleServiceWindows) drawMuted(pixels []uint32) {
	s.drawDrop(pixels, pebbleFaintR, pebbleFaintG, pebbleFaintB, 0.22, 0)
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	strokeLine(pixels,
		cx-pebbleDiscR*0.6, cy+pebbleDiscR*0.6,
		cx+pebbleDiscR*0.6, cy-pebbleDiscR*0.6,
		1.0, premultiply(210, pebbleInk3R, pebbleInk3G, pebbleInk3B))
}

// drawBubble — light glass card that drops below the pebble while listening
// and speaking. Card height is dynamic (bubbleY1 from the wrapped text).
func (s *pebbleServiceWindows) drawBubble(pixels []uint32, dark bool, bubbleY1 float64) {
	_ = dark // both states now use the light glass card
	const (
		bubbleX0 = float64(pebbleBubbleX0)
		bubbleY0 = float64(pebbleBubbleY0)
		bubbleX1 = float64(pebbleBubbleX1)
		cornerR  = 12.0
		shadow   = 6.0
	)
	if bubbleY1 < bubbleY0+10 {
		bubbleY1 = bubbleY0 + float64(pebbleBubbleY1Min-pebbleBubbleY0)
	}

	// Soft shadow underneath.
	fillRoundedRect(pixels,
		bubbleX0+shadow, bubbleY0+shadow,
		bubbleX1+shadow, bubbleY1+shadow,
		cornerR,
		premultiply(28, pebbleInkR, pebbleInkG, pebbleInkB),
	)
	// Card fill — raise white.
	fillRoundedRect(pixels, bubbleX0, bubbleY0, bubbleX1, bubbleY1, cornerR,
		premultiply(252, pebblePaperR, pebblePaperG, pebblePaperB))
	// Hairline border.
	strokeRoundedRect(pixels, bubbleX0, bubbleY0, bubbleX1, bubbleY1, cornerR, 1.0,
		premultiply(255, pebbleRuleR, pebbleRuleG, pebbleRuleB))
}

// fillRoundedRect — filled rounded rectangle, edge AA, composited.
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

// roundedRectAA returns 0..1 coverage for (x,y) inside a rounded rect.
func roundedRectAA(x, y, x0, y0, x1, y1, r float64) float64 {
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
	if d <= -0.5 {
		return 1
	}
	if d >= 0.5 {
		return 0
	}
	return 0.5 - d
}

// drawControllingHalo — a brief red outward halo when the pebble is pointing
// (reaching out to click), so the motion reads as intentional control.
func (s *pebbleServiceWindows) drawControllingHalo(pixels []uint32) {
	if !s.pointing.Load() {
		return
	}
	cx := float64(pebbleAnchorX)
	cy := float64(pebbleAnchorY)
	const cycleFrames = 75
	phase := float64(s.frameTick%cycleFrames) / float64(cycleFrames)
	v := phase * 2
	if v > 1 {
		v = 2 - v
	}
	alpha := uint8(77 + 76*v)
	strokeCircle(pixels, cx, cy, 16.5, 1.0, premultiply(alpha, pebbleAccentR, pebbleAccentG, pebbleAccentB))
	strokeCircle(pixels, cx, cy, 19.5, 1.0, premultiply(alpha/2, pebbleAccentR, pebbleAccentG, pebbleAccentB))
}

// drawEyeGlyph — a small awareness indicator beside the drop:
//
//	eyeActive && !blinded → pulsing red eye → "I just saw"
//	blinded               → muted ink-3 eye with a strike-through
//	neither               → no glyph
func (s *pebbleServiceWindows) drawEyeGlyph(pixels []uint32) {
	blinded := s.blinded.Load()
	eye := s.eyeActive.Load()
	if !eye && !blinded {
		return
	}

	ex := float64(pebbleAnchorX) + 16.0
	ey := float64(pebbleAnchorY) - 12.0
	const lensRX = 4.5
	const lensRY = 2.6
	const irisR = 1.4

	var r, g, b uint8
	if blinded {
		r, g, b = pebbleInk3R, pebbleInk3G, pebbleInk3B
	} else {
		r, g, b = pebbleAccentR, pebbleAccentG, pebbleAccentB
	}

	strokeCircle(pixels, ex, ey, lensRX, 1.0, premultiply(220, r, g, b))

	irisAlpha := uint8(220)
	if eye && !blinded {
		const cycleFrames = 75
		phase := float64(s.frameTick%cycleFrames) / float64(cycleFrames)
		v := phase * 2
		if v > 1 {
			v = 2 - v
		}
		irisAlpha = uint8(178 + 77*v)
	}
	fillCircle(pixels, ex, ey, irisR, premultiply(irisAlpha, r, g, b))

	if blinded {
		x0 := ex - lensRX - 1.5
		y0 := ey + lensRY + 1.5
		x1 := ex + lensRX + 1.5
		y1 := ey - lensRY - 1.5
		strokeLine(pixels, x0, y0, x1, y1, 1.0, premultiply(255, pebbleAccentR, pebbleAccentG, pebbleAccentB))
	}
}

// strokeLine paints a 1-px line between two points.
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
// the speaking bubble when SetAnswerOverflow was called with a non-empty id.
const (
	pebbleAnswerBtnW      = 108
	pebbleAnswerBtnH      = 22
	pebbleAnswerBtnInsetR = 10
	pebbleAnswerBtnInsetB = 8
	pebbleAnswerBtnXLeft  = pebbleBubbleX1 - pebbleAnswerBtnInsetR - pebbleAnswerBtnW
	pebbleAnswerBtnXRight = pebbleBubbleX1 - pebbleAnswerBtnInsetR
)

func pebbleAnswerBtnTop(bubbleY1 int32) int32 {
	return bubbleY1 - pebbleAnswerBtnInsetB - pebbleAnswerBtnH
}

// drawAnswerOverflowButton — a tinted pill anchored at the bubble's
// bottom-right. Only drawn when overflow is set.
func (s *pebbleServiceWindows) drawAnswerOverflowButton(pixels []uint32, dark bool, bubbleY1 int32) {
	_ = dark
	answerID, _ := s.answerOverflowID.Load().(string)
	if answerID == "" {
		return
	}
	btnY0 := pebbleAnswerBtnTop(bubbleY1)
	btnY1 := btnY0 + pebbleAnswerBtnH
	const radius = 8.0

	// Ink-tinted fill so the button reads as interactive on the light card.
	fillRoundedRect(pixels,
		float64(pebbleAnswerBtnXLeft), float64(btnY0),
		float64(pebbleAnswerBtnXRight), float64(btnY1),
		radius,
		premultiply(255, pebbleInkR, pebbleInkG, pebbleInkB),
	)
	strokeRoundedRect(pixels,
		float64(pebbleAnswerBtnXLeft), float64(btnY0),
		float64(pebbleAnswerBtnXRight), float64(btnY1),
		radius, 1.0,
		premultiply(255, pebbleInkR, pebbleInkG, pebbleInkB),
	)
}
