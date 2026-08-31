package main

import (
	"testing"
	"time"
)

func testDoubleClapDetector(t *testing.T) *DoubleClapDetector {
	t.Helper()
	d, err := NewDoubleClapDetector(DoubleClapDetectorOpts{
		PeakThreshold:  1000,
		ResetThreshold: 200,
		MinGap:         100 * time.Millisecond,
		MaxGap:         600 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestDoubleClapDetectorRecognizesTwoSeparatedPeaks(t *testing.T) {
	d := testDoubleClapDetector(t)
	t0 := time.Unix(1, 0)
	if d.ObservePCM(pcmChunk(160, 4000), t0) {
		t.Fatal("first peak must not trigger")
	}
	d.ObservePCM(pcmChunk(160, 0), t0.Add(40*time.Millisecond))
	if !d.ObservePCM(pcmChunk(160, 5000), t0.Add(250*time.Millisecond)) {
		t.Fatal("second separated peak inside the gap window must trigger")
	}
}

func TestDoubleClapDetectorRejectsSustainedSound(t *testing.T) {
	d := testDoubleClapDetector(t)
	t0 := time.Unix(1, 0)
	d.ObserveEnergy(4000, t0)
	if d.ObserveEnergy(5000, t0.Add(250*time.Millisecond)) {
		t.Fatal("sustained energy without a reset edge must not trigger")
	}
}

func TestDoubleClapDetectorHonorsGapWindow(t *testing.T) {
	d := testDoubleClapDetector(t)
	t0 := time.Unix(1, 0)
	d.ObserveEnergy(4000, t0)
	d.ObserveEnergy(0, t0.Add(20*time.Millisecond))
	if d.ObserveEnergy(4000, t0.Add(50*time.Millisecond)) {
		t.Fatal("peaks closer than MinGap must not trigger")
	}
	d.ObserveEnergy(0, t0.Add(70*time.Millisecond))
	if d.ObserveEnergy(4000, t0.Add(800*time.Millisecond)) {
		t.Fatal("peaks farther apart than MaxGap must not trigger")
	}
	d.ObserveEnergy(0, t0.Add(820*time.Millisecond))
	if !d.ObserveEnergy(4000, t0.Add(1100*time.Millisecond)) {
		t.Fatal("a new pair inside the gap window must trigger")
	}
}

func TestDoubleClapDetectorRejectsInvalidCalibration(t *testing.T) {
	_, err := NewDoubleClapDetector(DoubleClapDetectorOpts{
		PeakThreshold:  100,
		ResetThreshold: 100,
		MinGap:         time.Second,
		MaxGap:         500 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("invalid calibration must be rejected")
	}
}
