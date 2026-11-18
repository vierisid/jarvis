package main

// The ink of a look: the line a person draws round a thing.
//
// It is a marker, not a pen: one soft colour, the same strength where the line
// crosses itself as anywhere else, and nothing darker inside it. So the sheet
// keeps, for every pixel, the most any piece of the line has covered it, and
// the colour is laid on from that.
//
// The sheet is drawn into a window that lets every click through and dims
// nothing. Only the pixels a new piece of line touched are painted again.
//
// No platform calls: tested on every platform.

import (
	"bytes"
	"image"
	"image/png"
	"math"

	"golang.org/x/image/draw"
)

// The marker's colour (the notch's citron) and how strong it is at its middle.
const (
	notchInkR, notchInkG, notchInkB = 0xD6, 0xFF, 0x5C
	// Strong enough to be seen on a white window, where citron is pale, and
	// weak enough that the words under it can still be read. (At 0.46 a line
	// on white was hard to find.)
	notchInkStrength = 0.62
	// Half the marker's width, at a display scale of 100%.
	notchInkRadius = 6.0
)

// notchInk is a sheet as large as the part of the screen it covers.
type notchInk struct {
	w, h  int
	cover []uint8
}

func newNotchInk(w, h int) *notchInk {
	if w < 0 {
		w = 0
	}
	if h < 0 {
		h = 0
	}
	return &notchInk{w: w, h: h, cover: make([]uint8, w*h)}
}

// stroke lays down the piece of line from a to b, r pixels to each side, and
// reports the rectangle of the sheet it touched (empty when it missed it).
func (k *notchInk) stroke(ax, ay, bx, by, r float64) lookRect {
	x0 := int(math.Floor(math.Min(ax, bx) - r - 1))
	y0 := int(math.Floor(math.Min(ay, by) - r - 1))
	x1 := int(math.Ceil(math.Max(ax, bx) + r + 1))
	y1 := int(math.Ceil(math.Max(ay, by) + r + 1))
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, k.w), min(y1, k.h)
	if x1 <= x0 || y1 <= y0 {
		return lookRect{}
	}
	dx, dy := bx-ax, by-ay
	length2 := dx*dx + dy*dy
	for y := y0; y < y1; y++ {
		py := float64(y) + 0.5
		row := y * k.w
		for x := x0; x < x1; x++ {
			px := float64(x) + 0.5
			// How far this pixel is from the piece of line.
			t := 0.0
			if length2 > 0 {
				t = ((px-ax)*dx + (py-ay)*dy) / length2
				t = math.Max(0, math.Min(1, t))
			}
			ex, ey := px-(ax+t*dx), py-(ay+t*dy)
			d := math.Sqrt(ex*ex + ey*ey)
			// Full inside the marker, fading over the last pixel of its edge.
			c := r + 0.5 - d
			if c <= 0 {
				continue
			}
			if c > 1 {
				c = 1
			}
			if v := uint8(c*255 + 0.5); v > k.cover[row+x] {
				k.cover[row+x] = v
			}
		}
	}
	return lookRect{x0, y0, x1 - x0, y1 - y0}
}

// paint writes one rectangle of the sheet as pixels a layered window shows:
// 0xAARRGGBB with the colour already multiplied by its own strength.
func (k *notchInk) paint(pixels []uint32, r lookRect) {
	if len(pixels) < k.w*k.h {
		return
	}
	x0, y0 := max(r.X, 0), max(r.Y, 0)
	x1, y1 := min(r.X+r.W, k.w), min(r.Y+r.H, k.h)
	for y := y0; y < y1; y++ {
		row := y * k.w
		for x := x0; x < x1; x++ {
			pixels[row+x] = notchInkPixel(k.cover[row+x])
		}
	}
}

// notchInkPixel is the marker's colour over one pixel that is covered so much.
func notchInkPixel(cover uint8) uint32 {
	if cover == 0 {
		return 0
	}
	a := float64(cover) / 255 * notchInkStrength
	return uint32(a*255+0.5)<<24 | uint32(a*notchInkR+0.5)<<16 | uint32(a*notchInkG+0.5)<<8 | uint32(a*notchInkB+0.5)
}

// clear wipes the whole sheet.
func (k *notchInk) clear() {
	for i := range k.cover {
		k.cover[i] = 0
	}
}

// lookUnion is the smallest rectangle that holds both. An empty one counts
// for nothing.
func lookUnion(a, b lookRect) lookRect {
	if a.empty() {
		return b
	}
	if b.empty() {
		return a
	}
	x0, y0 := min(a.X, b.X), min(a.Y, b.Y)
	x1, y1 := max(a.X+a.W, b.X+b.W), max(a.Y+a.H, b.Y+b.H)
	return lookRect{x0, y0, x1 - x0, y1 - y0}
}

// The tag's colours: the notch's own black, and its ink.
const (
	notchTagFill = 0xFF111214
	notchTagInk  = 0x00EEF1F4
)

// notchTagPill fills a w by h sheet with the tag's shape: a dark rounded
// plate, solid inside and soft along its edge, clear outside.
func notchTagPill(pixels []uint32, w, h int, radius float64) {
	if w <= 0 || h <= 0 || len(pixels) < w*h {
		return
	}
	radius = math.Min(radius, math.Min(float64(w), float64(h))/2)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			// How far outside the plate's straight core this pixel is.
			ox := math.Max(math.Max(radius-px, px-(float64(w)-radius)), 0)
			oy := math.Max(math.Max(radius-py, py-(float64(h)-radius)), 0)
			c := radius + 0.5 - math.Sqrt(ox*ox+oy*oy)
			switch {
			case c <= 0:
				pixels[y*w+x] = 0
			case c >= 1:
				pixels[y*w+x] = notchTagFill
			default:
				a := uint32(c*255 + 0.5)
				pixels[y*w+x] = a<<24 | (0x11*a/255)<<16 | (0x12*a/255)<<8 | (0x14 * a / 255)
			}
		}
	}
}

// notchTagPlace is where the tag goes: above what was circled, on its left
// edge; under it when there is no room above; and always inside the screen.
func notchTagPlace(bounds lookRect, w, h int, screen lookRect, gap int) (x, y int) {
	x, y = bounds.X, bounds.Y-h-gap
	if y < screen.Y {
		y = bounds.Y + bounds.H + gap
	}
	if y+h > screen.Y+screen.H {
		y = screen.Y + screen.H - h
	}
	if x+w > screen.X+screen.W {
		x = screen.X + screen.W - w
	}
	return max(x, screen.X), max(y, screen.Y)
}

// lookShot is a copy of a display: its pixels as Windows keeps them (blue,
// green, red and a fourth byte, row after row from the top) and where its top
// left corner is on the screen.
type lookShot struct {
	pixels []byte
	w, h   int
	x, y   int
}

// Cut gives a part of the copy as a PNG. The part is in screen pixels; what
// of it lies outside the copy is left out. Nil when nothing is left.
func (s *lookShot) Cut(part lookRect) []byte { return s.CutSmall(part, 0) }

// CutSmall is Cut with the picture made smaller when its longest side would
// be more than most pixels: then its longest side is exactly most. most 0:
// as it is.
//
// It is made smaller in two steps. First by a whole number, where every
// pixel is the mean of a square of the copy: quick, and small writing blurs
// and does not break up. Then the rest of the way, which is less than a
// half, by weighing the pixels next to each other. It used to stop after the
// first step, and a whole number is a coarse measure: a window 1920 wide was
// halved to 960 where 1568 was asked for, and its menus were read at six
// pixels a letter (the hardening audit, 17 November 2026).
func (s *lookShot) CutSmall(part lookRect, most int) []byte {
	if s == nil || len(s.pixels) < s.w*s.h*4 {
		return nil
	}
	x0, y0 := max(part.X-s.x, 0), max(part.Y-s.y, 0)
	x1, y1 := min(part.X+part.W-s.x, s.w), min(part.Y+part.H-s.y, s.h)
	if x1 <= x0 || y1 <= y0 {
		return nil
	}
	by := 1
	if most > 0 {
		// The largest whole number that still leaves it at least as large as asked.
		by = max(x1-x0, y1-y0) / most
	}
	by = max(by, 1)
	width, height := (x1-x0)/by, (y1-y0)/by
	if width <= 0 || height <= 0 {
		return nil
	}
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		dst := img.Pix[y*img.Stride:]
		for x := 0; x < width; x++ {
			var b, g, r int
			for dy := 0; dy < by; dy++ {
				row := ((y0+y*by+dy)*s.w + x0 + x*by) * 4
				for dx := 0; dx < by; dx++ {
					b += int(s.pixels[row+dx*4])
					g += int(s.pixels[row+dx*4+1])
					r += int(s.pixels[row+dx*4+2])
				}
			}
			n := by * by
			dst[x*4], dst[x*4+1], dst[x*4+2], dst[x*4+3] = uint8(r/n), uint8(g/n), uint8(b/n), 0xFF
		}
	}
	if longest := max(width, height); most > 0 && longest > most {
		w2, h2 := max(width*most/longest, 1), max(height*most/longest, 1)
		small := image.NewNRGBA(image.Rect(0, 0, w2, h2))
		draw.BiLinear.Scale(small, small.Bounds(), img, img.Bounds(), draw.Src, nil)
		img = small
	}
	var out bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&out, img); err != nil {
		return nil
	}
	return out.Bytes()
}

// ---------------------------------------------------------------------------
// The hand: Jarvis's own pointer
// ---------------------------------------------------------------------------
//
// When Jarvis shows where something is, it does not only light the thing up.
// Its own pointer leaves the notch, travels to the thing and lands on it, and
// then the ring is drawn. The pointer is the prototype's: the notch's citron
// arrow with a dark edge, the same shape, a little larger than the system's.
// The owner asked for it on 16 November 2026: "it should be a cursor that
// comes out of the notch and points at there, and then it creates the
// highlight."

const (
	// The arrow's box, at a display scale of 100%. The prototype's is 20, in a
	// small window; on a whole display that is too easy to lose.
	notchHandBoxPx = 28.0
	// The edge round it, in the units of the shape's own 24 by 24 box.
	notchHandEdge = 1.3
	// The shadow under it: how far down, how wide, how dark.
	notchHandShadowDown = 2.0
	notchHandShadowWide = 3.5
	notchHandShadowDark = 0.30
	// Its edge and its fill: the notch's black and its citron.
	notchHandEdgeR, notchHandEdgeG, notchHandEdgeB = 0x13, 0x16, 0x1A
)

// The arrow, in a 24 by 24 box: the path of the prototype's pointer
// ("M4 2.5 11.2 21l2.5-7.3 7.3-2.5z"). The first point is its tip.
var notchHandShape = [4][2]float64{{4, 2.5}, {11.2, 21}, {13.7, 13.7}, {21, 11.2}}

// notchHand is the pointer's picture, as a layered window shows it, with
// where its tip is in that picture.
type notchHand struct {
	pixels     []uint32
	w, h       int
	tipX, tipY float64
}

// handDistance is how far a point of the shape's box is from the arrow's
// outline, and whether it is inside the arrow.
func handDistance(px, py float64) (distance float64, inside bool) {
	distance = math.Inf(1)
	n := len(notchHandShape)
	for i := 0; i < n; i++ {
		a, b := notchHandShape[i], notchHandShape[(i+1)%n]
		dx, dy := b[0]-a[0], b[1]-a[1]
		t := 0.0
		if l2 := dx*dx + dy*dy; l2 > 0 {
			t = math.Max(0, math.Min(1, ((px-a[0])*dx+(py-a[1])*dy)/l2))
		}
		ex, ey := px-(a[0]+t*dx), py-(a[1]+t*dy)
		distance = math.Min(distance, math.Sqrt(ex*ex+ey*ey))
		// A ray to the right crosses this side: counted for "inside".
		if (a[1] > py) != (b[1] > py) && px < a[0]+(py-a[1])/(b[1]-a[1])*dx {
			inside = !inside
		}
	}
	return distance, inside
}

// newNotchHand draws the pointer for a display of that scale.
func newNotchHand(scale float64) *notchHand {
	if scale <= 0 {
		scale = 1
	}
	unit := notchHandBoxPx * scale / 24
	pad := math.Ceil((notchHandShadowWide + notchHandShadowDown) * scale)
	side := int(math.Ceil(notchHandBoxPx*scale + 2*pad))
	hand := &notchHand{pixels: make([]uint32, side*side), w: side, h: side, tipX: pad + notchHandShape[0][0]*unit, tipY: pad + notchHandShape[0][1]*unit}
	const sub = 4
	half := notchHandEdge / 2
	for y := 0; y < side; y++ {
		for x := 0; x < side; x++ {
			var a, r, g, b float64
			for sy := 0; sy < sub; sy++ {
				for sx := 0; sx < sub; sx++ {
					// This sample, in the shape's own box.
					ux := (float64(x) + (float64(sx)+0.5)/sub - pad) / unit
					uy := (float64(y) + (float64(sy)+0.5)/sub - pad) / unit
					d, in := handDistance(ux, uy)
					switch {
					case d <= half:
						a, r, g, b = a+1, r+notchHandEdgeR, g+notchHandEdgeG, b+notchHandEdgeB
					case in:
						a, r, g, b = a+1, r+notchInkR, g+notchInkG, b+notchInkB
					default:
						// Outside the arrow: its shadow, a little below it.
						sd, sin := handDistance(ux, uy-notchHandShadowDown*scale/unit)
						out := 0.0
						if !sin && sd > half {
							out = (sd - half) * unit / (notchHandShadowWide * scale)
						}
						if out < 1 {
							a += notchHandShadowDark * (1 - out) * (1 - out)
						}
					}
				}
			}
			n := float64(sub * sub)
			a, r, g, b = a/n, r/n, g/n, b/n
			if a <= 0 {
				continue
			}
			// Colour already multiplied by its strength, as a layered window wants it.
			hand.pixels[y*side+x] = uint32(a*255+0.5)<<24 | uint32(r+0.5)<<16 | uint32(g+0.5)<<8 | uint32(b+0.5)
		}
	}
	return hand
}

// frame draws the pointer into dst (as large as the pointer's own picture) at
// a part of its size and of its strength: it grows and comes into sight as it
// leaves the notch. It grows from its tip, so the tip stays on its path.
func (h *notchHand) frame(dst []uint32, size, strength float64) {
	if len(dst) < h.w*h.h {
		return
	}
	if size >= 0.999 && strength >= 0.999 {
		copy(dst, h.pixels)
		return
	}
	size = math.Max(size, 0.05)
	strength = math.Max(0, math.Min(1, strength))
	at := func(x, y int) (a, r, g, b float64) {
		if x < 0 || y < 0 || x >= h.w || y >= h.h {
			return 0, 0, 0, 0
		}
		p := h.pixels[y*h.w+x]
		return float64(p >> 24), float64(p >> 16 & 0xFF), float64(p >> 8 & 0xFF), float64(p & 0xFF)
	}
	for y := 0; y < h.h; y++ {
		for x := 0; x < h.w; x++ {
			// Where this pixel comes from in the full-size picture.
			sx := h.tipX + (float64(x)+0.5-h.tipX)/size - 0.5
			sy := h.tipY + (float64(y)+0.5-h.tipY)/size - 0.5
			x0, y0 := int(math.Floor(sx)), int(math.Floor(sy))
			fx, fy := sx-float64(x0), sy-float64(y0)
			var a, r, g, b float64
			for _, c := range [4]struct {
				x, y int
				w    float64
			}{{x0, y0, (1 - fx) * (1 - fy)}, {x0 + 1, y0, fx * (1 - fy)}, {x0, y0 + 1, (1 - fx) * fy}, {x0 + 1, y0 + 1, fx * fy}} {
				ca, cr, cg, cb := at(c.x, c.y)
				a, r, g, b = a+ca*c.w, r+cr*c.w, g+cg*c.w, b+cb*c.w
			}
			a, r, g, b = a*strength, r*strength, g*strength, b*strength
			if a < 0.5 {
				dst[y*h.w+x] = 0
				continue
			}
			dst[y*h.w+x] = uint32(a+0.5)<<24 | uint32(r+0.5)<<16 | uint32(g+0.5)<<8 | uint32(b+0.5)
		}
	}
}
