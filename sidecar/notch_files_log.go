package main

import (
	"log"
	"runtime"
	"time"
)

func goosName() string { return runtime.GOOS }

// What is written down about a look at the files: how much, never what.
// What is written down about a file that was asked for: where, its kind and
// size, or why it was not handed over. Never its name.
func logNotchFile(place, kind string, size int, why string) {
	if why != "" {
		log.Printf("[notch] a file was asked for and not handed over (%s): %s", place, why)
		return
	}
	log.Printf("[notch] a file was handed over to be read: %s, %s, %d bytes", place, kind, size)
}

func logNotchFiles(places, things int, took time.Duration) {
	log.Printf("[notch] looked at the files: %d place(s), %d thing(s) at the top of them, in %d ms", places, things, took.Milliseconds())
}
