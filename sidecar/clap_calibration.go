package main

import (
	"fmt"
	"io"
	"sort"
	"sync"
	"time"
)

type clapEnergySample struct {
	Offset time.Duration
	RMS    float64
	Peak   float64
	Crest  float64
	ZCR    float64
}

type clapCalibrationSummary struct {
	Samples  int
	P50      float64
	P95      float64
	P99      float64
	Max      float64
	P99Peaks []clapEnergySample
}

// runClapCalibration is an explicit, terminal-only mic session. The capture
// service is stream-only, so PCM is never accumulated or written to disk; the
// callback retains only one RMS number and timestamp per audio chunk.
func runClapCalibration(duration time.Duration, out io.Writer) error {
	if duration <= 0 {
		return fmt.Errorf("duration must be positive")
	}

	svc := NewStreamingCaptureService(pebbleAudioSampleRate)
	started := time.Now()
	var mu sync.Mutex
	samples := make([]clapEnergySample, 0, int(duration/(30*time.Millisecond))+1)
	svc.SetChunkListener(func(chunk []byte) {
		features := pcmTransientFeatures(chunk)
		mu.Lock()
		samples = append(samples, clapEnergySample{
			Offset: time.Since(started), RMS: features.RMS, Peak: features.PeakAbs,
			Crest: features.CrestFactor, ZCR: features.ZeroCrossingRate,
		})
		mu.Unlock()
	})
	defer svc.SetChunkListener(nil)

	fmt.Fprintf(out, "Local clap calibration: %.1fs. Clap twice naturally; audio is not saved or sent.\n", duration.Seconds())
	if err := svc.Start("clap-calibration"); err != nil {
		return err
	}
	time.Sleep(duration)
	if _, _, err := svc.Stop(); err != nil {
		return err
	}

	mu.Lock()
	snapshot := append([]clapEnergySample(nil), samples...)
	mu.Unlock()
	summary := summarizeClapEnergy(snapshot)
	if summary.Samples == 0 {
		return fmt.Errorf("microphone returned no audio metrics")
	}
	if summary.Max <= 0 {
		return fmt.Errorf("microphone returned only silence; calibration is invalid")
	}
	fmt.Fprintf(out, "RMS metrics only: samples=%d p50=%.0f p95=%.0f p99=%.0f max=%.0f\n",
		summary.Samples, summary.P50, summary.P95, summary.P99, summary.Max)
	fmt.Fprint(out, "p99 peak times:")
	for _, peak := range summary.P99Peaks {
		fmt.Fprintf(out, " %.2fs[rms=%.0f peak=%.0f crest=%.2f zcr=%.3f]",
			peak.Offset.Seconds(), peak.RMS, peak.Peak, peak.Crest, peak.ZCR)
	}
	fmt.Fprintln(out)
	return nil
}

// runClapVerification feeds live PCM to an explicitly calibrated detector and
// reports detections only. It does not retain PCM and has no action callback.
func runClapVerification(duration time.Duration, opts DoubleClapDetectorOpts, out io.Writer) error {
	if duration <= 0 {
		return fmt.Errorf("duration must be positive")
	}
	detector, err := NewDoubleClapDetector(opts)
	if err != nil {
		return err
	}

	svc := NewStreamingCaptureService(pebbleAudioSampleRate)
	started := time.Now()
	var mu sync.Mutex
	detections := make([]time.Duration, 0, 4)
	samples := make([]clapEnergySample, 0, int(duration/(30*time.Millisecond))+1)
	svc.SetChunkListener(func(chunk []byte) {
		now := time.Now()
		features := pcmTransientFeatures(chunk)
		matched := detector.ObserveFeatures(features, now)
		mu.Lock()
		samples = append(samples, clapEnergySample{
			Offset: now.Sub(started), RMS: features.RMS, Peak: features.PeakAbs,
			Crest: features.CrestFactor, ZCR: features.ZeroCrossingRate,
		})
		if matched {
			detections = append(detections, now.Sub(started))
		}
		mu.Unlock()
	})
	defer svc.SetChunkListener(nil)

	fmt.Fprintf(out, "Local double-clap verification: %.1fs. No audio is saved or sent.\n", duration.Seconds())
	if err := svc.Start("clap-verification"); err != nil {
		return err
	}
	time.Sleep(duration)
	if _, _, err := svc.Stop(); err != nil {
		return err
	}

	mu.Lock()
	snapshot := append([]time.Duration(nil), detections...)
	metricSnapshot := append([]clapEnergySample(nil), samples...)
	mu.Unlock()
	fmt.Fprintf(out, "Double-clap detections: %d", len(snapshot))
	for _, offset := range snapshot {
		fmt.Fprintf(out, " %.2fs", offset.Seconds())
	}
	fmt.Fprintln(out)
	summary := summarizeClapEnergy(metricSnapshot)
	fmt.Fprintf(out, "Verification metrics: samples=%d p95=%.0f p99=%.0f max=%.0f\n",
		summary.Samples, summary.P95, summary.P99, summary.Max)
	fmt.Fprint(out, "Verification p99 peaks:")
	for _, peak := range summary.P99Peaks {
		fmt.Fprintf(out, " %.2fs[rms=%.0f peak=%.0f crest=%.2f zcr=%.3f]",
			peak.Offset.Seconds(), peak.RMS, peak.Peak, peak.Crest, peak.ZCR)
	}
	fmt.Fprintln(out)
	return nil
}

func summarizeClapEnergy(samples []clapEnergySample) clapCalibrationSummary {
	if len(samples) == 0 {
		return clapCalibrationSummary{}
	}
	values := make([]float64, len(samples))
	for i, sample := range samples {
		values[i] = sample.RMS
	}
	sort.Float64s(values)
	percentile := func(p float64) float64 {
		index := int(float64(len(values)-1) * p)
		return values[index]
	}
	summary := clapCalibrationSummary{
		Samples: len(values),
		P50:     percentile(0.50),
		P95:     percentile(0.95),
		P99:     percentile(0.99),
		Max:     values[len(values)-1],
	}
	for _, sample := range samples {
		if sample.RMS >= summary.P99 {
			summary.P99Peaks = append(summary.P99Peaks, sample)
		}
	}
	return summary
}
