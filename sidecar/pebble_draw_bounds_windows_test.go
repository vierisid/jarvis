//go:build windows

package main

import "testing"

// TestMainPebbleDrawStaysInsideCrop guards the invariant the compact layered
// window relies on: present() clears and uploads only the top-left
// mainPebbleWindowW × mainPebbleWindowH crop of the 460-px-stride backing
// buffer, so no main-pebble draw path may ever touch a pixel outside that
// crop. Anything painted below row mainPebbleWindowH would land in rows that
// are never cleared; anything right of column mainPebbleWindowW would be
// silently cropped by UpdateLayeredWindow. Both fail here instead.
//
// Renders every state, under every halo/eye/blinded overlay combination,
// across 240 consecutive frame ticks — the longest animation cycle (idle's
// 240-frame breathe); consecutive ticks 0..239 also cover every phase of the
// shorter 75/84/96/120/144-frame cycles.
func TestMainPebbleDrawStaysInsideCrop(t *testing.T) {
	states := []PebbleState{
		PebbleIdle, PebbleListening, PebbleThinking, PebbleSpeaking,
		PebbleWorking, PebbleAsking, PebbleDone, PebbleMuted,
	}
	overlays := []struct {
		name                   string
		pointing, eye, blinded bool
	}{
		{"plain", false, false, false},
		{"pointing", true, false, false},
		{"eye", false, true, false},
		{"pointing+eye+blinded", true, true, true},
	}
	const ticks = 240

	pixels := make([]uint32, pebbleWindowW*pebbleWindowH)
	for _, ov := range overlays {
		for _, state := range states {
			s := &pebbleServiceWindows{}
			s.pointing.Store(ov.pointing)
			s.eyeActive.Store(ov.eye)
			s.blinded.Store(ov.blinded)
			// Clear only the crop rows each frame, exactly like present().
			// The draw helpers never write a transparent pixel over a painted
			// one, so a single out-of-crop write on any tick survives until
			// the scan below.
			for tick := uint64(0); tick < ticks; tick++ {
				for i := range pixels[:pebbleWindowW*mainPebbleWindowH] {
					pixels[i] = 0
				}
				s.frameTick = tick
				s.drawState(pixels, state, 0)
				s.drawControllingHalo(pixels)
				s.drawEyeGlyph(pixels)
			}
			if x, y, stray := strayPixelOutsideCrop(pixels); stray {
				t.Fatalf("state %q overlay %q painted outside the %dx%d crop at (%d,%d) — widen mainPebbleWindowW/H or shrink the visual",
					state, ov.name, mainPebbleWindowW, mainPebbleWindowH, x, y)
			}
		}
	}
}

func strayPixelOutsideCrop(pixels []uint32) (int, int, bool) {
	for y := 0; y < pebbleWindowH; y++ {
		for x := 0; x < pebbleWindowW; x++ {
			if x < mainPebbleWindowW && y < mainPebbleWindowH {
				continue
			}
			if pixels[y*pebbleWindowW+x] != 0 {
				return x, y, true
			}
		}
	}
	return 0, 0, false
}
