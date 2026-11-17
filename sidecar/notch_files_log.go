package main

import (
	"log"
	"runtime"
	"time"
)

func goosName() string { return runtime.GOOS }

// What is written down about a look at the files: how much, never what.
func logNotchFiles(places, things int, took time.Duration) {
	log.Printf("[notch] looked at the files: %d place(s), %d thing(s) at the top of them, in %d ms", places, things, took.Milliseconds())
}
