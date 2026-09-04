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

func TestDoubleClapDetectorRequiresCalibratedImpulsePeak(t *testing.T) {
	d, err := NewDoubleClapDetector(DoubleClapDetectorOpts{
		PeakThreshold:  1000,
		MinPeakAbs:     5000,
		ResetThreshold: 200,
		MinGap:         100 * time.Millisecond,
		MaxGap:         600 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Unix(1, 0)
	if d.ObserveFeatures(PCMTransientFeatures{RMS: 4000, PeakAbs: 4500}, t0) {
		t.Fatal("first non-impulsive peak must not trigger")
	}
	d.ObserveFeatures(PCMTransientFeatures{}, t0.Add(40*time.Millisecond))
	if d.ObserveFeatures(PCMTransientFeatures{RMS: 4000, PeakAbs: 4500}, t0.Add(250*time.Millisecond)) {
		t.Fatal("two loud chunks below the impulse floor must not trigger")
	}
}

func TestDoubleClapDetectorMatchesCalibratedPositiveSession(t *testing.T) {
	d, err := NewDoubleClapDetector(DoubleClapDetectorOpts{
		PeakThreshold:  5000,
		MinPeakAbs:     15000,
		ResetThreshold: 2500,
		MinGap:         150 * time.Millisecond,
		MaxGap:         600 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Unix(1, 0)
	sequence := []struct {
		offset time.Duration
		rms    float64
		peak   float64
	}{
		{0, 7896, 32768},
		{40 * time.Millisecond, 1000, 4000},
		{390 * time.Millisecond, 6200, 24000},
		{430 * time.Millisecond, 1000, 4000},
		{2 * time.Second, 10761, 32768},
		{2040 * time.Millisecond, 1000, 4000},
		{2360 * time.Millisecond, 7887, 32768},
		{2400 * time.Millisecond, 1000, 4000},
		{4 * time.Second, 7669, 32768},
		{4040 * time.Millisecond, 1000, 4000},
		{4390 * time.Millisecond, 14499, 32768},
		{4430 * time.Millisecond, 1000, 4000},
	}
	detections := 0
	for _, sample := range sequence {
		if d.ObserveFeatures(PCMTransientFeatures{RMS: sample.rms, PeakAbs: sample.peak}, t0.Add(sample.offset)) {
			detections++
		}
	}
	if detections != 3 {
		t.Fatalf("calibrated positive session detections = %d, want 3", detections)
	}
}

func TestDoubleClapDetectorRejectsCalibratedNegativeTransient(t *testing.T) {
	d, err := NewDoubleClapDetector(DoubleClapDetectorOpts{
		PeakThreshold:  5000,
		MinPeakAbs:     15000,
		ResetThreshold: 2500,
		MinGap:         150 * time.Millisecond,
		MaxGap:         600 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Unix(1, 0)
	// The negative control contained a sharp peak (29498) with low RMS (2169).
	// Requiring both metrics prevents that isolated household sound from counting.
	if d.ObserveFeatures(PCMTransientFeatures{RMS: 2169, PeakAbs: 29498}, t0) {
		t.Fatal("high absolute peak with sub-threshold RMS must not trigger")
	}
	d.ObserveFeatures(PCMTransientFeatures{}, t0.Add(40*time.Millisecond))
	if d.ObserveFeatures(PCMTransientFeatures{RMS: 2169, PeakAbs: 29498}, t0.Add(390*time.Millisecond)) {
		t.Fatal("two low-RMS transients must not form a double clap")
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

func TestPCMTransientFeatures(t *testing.T) {
	features := pcmTransientFeatures(pcmChunk(160, 4000))
	if features.RMS != 4000 || features.PeakAbs != 4000 || features.CrestFactor != 1 || features.ZeroCrossingRate != 0 {
		t.Fatalf("constant PCM features = %+v", features)
	}
}
