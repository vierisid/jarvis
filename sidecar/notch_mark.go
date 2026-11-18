package main

import "time"

// The mark: before Jarvis says something about a thing in the window the
// person is in, a soft citron mark sweeps over that thing, the way a marker
// is drawn over a line of text. It is the prototype's `.jmark`: it begins a
// quarter of a second after it was asked for and takes a little over half a
// second to run from left to right. It stays while the line about it is on
// the notch, and is taken away with it.
//
// It is a picture laid over the screen, in a window of its own that takes no
// click and never has the keyboard. Nothing under it is touched or read.
//
// What is in this file is the part that is the same on every system and can
// be tested without a screen: how far the sweep has come, and which pixels
// of the picture it colours. The window is the platform's.

const (
	// How long after it was asked for the sweep begins, and how long it takes.
	notchMarkDelay = 250 * time.Millisecond
	notchMarkSweep = 550 * time.Millisecond
	// The least and the most a mark stays when nobody takes it away.
	notchMarkMinStay = time.Second
	notchMarkMaxStay = 30 * time.Second
	// The largest thing that is marked, in pixels of the screen: a line or a
	// few of text, a row, a field. A whole window washed in citron is not a mark.
	notchMarkMaxW = 2600
	notchMarkMaxH = 480
	// How strong the mark is, of 255: about a third. Between the prototype's
	// mark on a light page (.4) and on a dark one (.2).
	notchMarkStrength = 82
)

// notchMarkPixel is the mark's colour (citron, #D6FF5C) as a layered window
// takes it: every part already multiplied by its strength.
func notchMarkPixel() uint32 {
	a := uint32(notchMarkStrength)
	return a<<24 | (0xD6*a/255)<<16 | (0xFF*a/255)<<8 | (0x5C * a / 255)
}

// notchMarkUpTo says how many of a mark's w columns are swept once `gone` has
// passed since it was asked for: none during the delay, then quickly at first
// and slower toward the end, and all of them from then on.
func notchMarkUpTo(gone time.Duration, w int) int {
	if w <= 0 || gone <= notchMarkDelay {
		return 0
	}
	t := float64(gone-notchMarkDelay) / float64(notchMarkSweep)
	if t >= 1 {
		return w
	}
	eased := 1 - (1-t)*(1-t)*(1-t)
	n := int(eased * float64(w))
	if n < 0 {
		return 0
	}
	if n > w {
		return w
	}
	return n
}

// notchMarkFill colours the columns from `from` up to, not including, `to`
// of a picture of w by h pixels, with the picture's four corners rounded off
// by radius. What lies outside the rounded corners is left clear.
func notchMarkFill(pixels []uint32, w, h, from, to int, radius float64, colour uint32) {
	if w <= 0 || h <= 0 || len(pixels) < w*h {
		return
	}
	if from < 0 {
		from = 0
	}
	if to > w {
		to = w
	}
	r := radius
	if half := float64(w) / 2; r > half {
		r = half
	}
	if half := float64(h) / 2; r > half {
		r = half
	}
	if r < 0 {
		r = 0
	}
	for y := 0; y < h; y++ {
		for x := from; x < to; x++ {
			if notchMarkInside(x, y, w, h, r) {
				pixels[y*w+x] = colour
			}
		}
	}
}

// notchMarkInside says whether a pixel is inside a w by h rectangle whose
// corners are rounded off by r.
func notchMarkInside(x, y, w, h int, r float64) bool {
	px, py := float64(x)+0.5, float64(y)+0.5
	cx, cy := px, py
	if px < r {
		cx = r
	} else if px > float64(w)-r {
		cx = float64(w) - r
	}
	if py < r {
		cy = r
	} else if py > float64(h)-r {
		cy = float64(h) - r
	}
	dx, dy := px-cx, py-cy
	return dx*dx+dy*dy <= r*r
}

// notchMarkStay holds how long a mark was asked to stay to what one may.
func notchMarkStay(ms float64) time.Duration {
	stay := time.Duration(ms) * time.Millisecond
	if !(ms > 0) || stay < notchMarkMinStay {
		return notchMarkMinStay
	}
	if stay > notchMarkMaxStay {
		return notchMarkMaxStay
	}
	return stay
}

// notchMarkFits says whether a rectangle is a thing that can be marked inside
// a window: it has a size, it is not larger than a mark may be, and all of it
// lies inside that window.
func notchMarkFits(x, y, w, h, winX, winY, winW, winH int) bool {
	if w < 6 || h < 6 || w > notchMarkMaxW || h > notchMarkMaxH {
		return false
	}
	return x >= winX && y >= winY && x+w <= winX+winW && y+h <= winY+winH
}

// notchMarkSame says whether a window is still where it was when it was
// looked at: its four edges within a few pixels of where they were.
func notchMarkSame(x, y, w, h, wasX, wasY, wasW, wasH int) bool {
	near := func(a, b int) bool {
		d := a - b
		if d < 0 {
			d = -d
		}
		return d <= 3
	}
	return near(x, wasX) && near(y, wasY) && near(w, wasW) && near(h, wasH)
}
