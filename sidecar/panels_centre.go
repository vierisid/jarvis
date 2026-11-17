package main

// A small window in the middle of the screen.
//
// The first thing a new person sees is a card that says the product is
// installed and where it lives (the notch's day one). It has to be where they
// are looking, which is the middle of the display they work on, not wherever
// the system happens to put a new window.

// platformPrimaryScreenSize is the size of the display a person works on,
// where the system can tell that apart from all its displays together. Nil
// where it cannot: then all of them together are taken as one.
var platformPrimaryScreenSize func() (w, h int)

// panelCentred is the top left corner that puts a window of that size in the
// middle of a screen of that size. A little above the middle, where the eye
// rests. Never off the screen: a window larger than the screen starts at its
// corner.
func panelCentred(screenW, screenH, w, h int) (x, y int) {
	x, y = (screenW-w)/2, (screenH-h)*2/5
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	return x, y
}
