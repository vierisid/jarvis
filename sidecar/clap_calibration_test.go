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
	if len(got.P99Peaks) != 2 || got.P99Peaks[0].RMS != 99 || got.P99Peaks[1].RMS != 100 {
		t.Fatalf("unexpected p99 peaks: %+v", got.P99Peaks)
	}
}

func TestSummarizeClapEnergyEmpty(t *testing.T) {
	if got := summarizeClapEnergy(nil); got.Samples != 0 || got.P50 != 0 || got.P95 != 0 || got.P99 != 0 || got.Max != 0 || len(got.P99Peaks) != 0 {
		t.Fatalf("empty summary = %+v", got)
	}
}
