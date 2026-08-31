package main

import (
	"testing"
	"time"
)

func TestSummarizeClapEnergy(t *testing.T) {
	samples := make([]clapEnergySample, 100)
	for i := range samples {
		samples[i] = clapEnergySample{Offset: time.Duration(i) * time.Millisecond, RMS: float64(i + 1)}
	}
	got := summarizeClapEnergy(samples)
	if got.Samples != 100 || got.P50 != 50 || got.P95 != 95 || got.P99 != 99 || got.Max != 100 {
		t.Fatalf("unexpected summary: %+v", got)
	}
}

func TestSummarizeClapEnergyEmpty(t *testing.T) {
	if got := summarizeClapEnergy(nil); got != (clapCalibrationSummary{}) {
		t.Fatalf("empty summary = %+v", got)
	}
}
