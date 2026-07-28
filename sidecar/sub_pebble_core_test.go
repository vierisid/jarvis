package main

import "testing"

func TestSubPebbleRGBDistinctPerColor(t *testing.T) {
	cases := map[SubPebbleColor][3]uint8{
		SubPebbleAmber:     {0xE5, 0xA9, 0x1E},
		SubPebbleSage:      {0x4A, 0x7C, 0x3F},
		SubPebbleViolet:    {0x6E, 0x53, 0x9C},
		SubPebbleVermilion: {0xE6, 0x3B, 0x2E},
		SubPebbleMustard:   {0xB7, 0x8A, 0x1E},
		SubPebbleTeal:      {0x2E, 0x7A, 0x82},
	}
	seen := map[[3]uint8]SubPebbleColor{}
	for color, want := range cases {
		r, g, b := subPebbleRGB(color)
		got := [3]uint8{r, g, b}
		if got != want {
			t.Errorf("subPebbleRGB(%q) = %v, want %v", color, got, want)
		}
		if other, dup := seen[got]; dup {
			t.Errorf("colors %q and %q share RGB %v", color, other, got)
		}
		seen[got] = color
	}
}

func TestSubPebbleRGBUnknownFallsBackToAmber(t *testing.T) {
	r, g, b := subPebbleRGB(SubPebbleColor("not-a-real-color"))
	ar, ag, ab := subPebbleRGB(SubPebbleAmber)
	if r != ar || g != ag || b != ab {
		t.Errorf("unknown color = (%d,%d,%d), want amber (%d,%d,%d)", r, g, b, ar, ag, ab)
	}
}

func TestFormatSubPebbleElapsed(t *testing.T) {
	cases := map[int]string{
		0:    "0s",
		5:    "5s",
		59:   "59s",
		60:   "1m00s",
		61:   "1m01s",
		125:  "2m05s",
		3599: "59m59s",
	}
	for secs, want := range cases {
		if got := formatSubPebbleElapsed(secs); got != want {
			t.Errorf("formatSubPebbleElapsed(%d) = %q, want %q", secs, got, want)
		}
	}
}
