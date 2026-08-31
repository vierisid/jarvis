package main

import (
	"errors"
	"time"
)

// DoubleClapDetectorOpts contains calibration values supplied by the caller.
// There are deliberately no production defaults yet: real microphone samples
// must determine them before this detector is connected to capture or actions.
type DoubleClapDetectorOpts struct {
	PeakThreshold  float64
	ResetThreshold float64
	MinGap         time.Duration
	MaxGap         time.Duration
}

// DoubleClapDetector is a pure, local PCM classifier. It owns no microphone,
// sends no audio, and performs no action. A caller may eventually feed it the
// same chunks already captured by the Sidecar, but that wiring is intentionally
// absent until privacy controls and calibration are approved.
type DoubleClapDetector struct {
	opts      DoubleClapDetectorOpts
	abovePeak bool
	firstPeak time.Time
}

func NewDoubleClapDetector(opts DoubleClapDetectorOpts) (*DoubleClapDetector, error) {
	if opts.PeakThreshold <= 0 || opts.ResetThreshold < 0 {
		return nil, errors.New("clap thresholds must be non-negative and peak must be positive")
	}
	if opts.ResetThreshold >= opts.PeakThreshold {
		return nil, errors.New("clap reset threshold must be below peak threshold")
	}
	if opts.MinGap <= 0 || opts.MaxGap <= opts.MinGap {
		return nil, errors.New("clap gap window must be positive and ordered")
	}
	return &DoubleClapDetector{opts: opts}, nil
}

// ObservePCM returns true only on the rising edge of a qualifying second peak.
// Hysteresis requires energy to fall below ResetThreshold before another peak
// can count, so one sustained sound cannot masquerade as multiple claps.
func (d *DoubleClapDetector) ObservePCM(pcm []byte, at time.Time) bool {
	return d.ObserveEnergy(pcmRMSint16(pcm), at)
}

// ObserveEnergy is exposed for deterministic tests and later calibration.
func (d *DoubleClapDetector) ObserveEnergy(energy float64, at time.Time) bool {
	if energy <= d.opts.ResetThreshold {
		d.abovePeak = false
		if !d.firstPeak.IsZero() && at.Sub(d.firstPeak) > d.opts.MaxGap {
			d.firstPeak = time.Time{}
		}
		return false
	}
	if energy < d.opts.PeakThreshold || d.abovePeak {
		return false
	}

	d.abovePeak = true
	if d.firstPeak.IsZero() || at.Before(d.firstPeak) {
		d.firstPeak = at
		return false
	}

	gap := at.Sub(d.firstPeak)
	if gap < d.opts.MinGap {
		return false
	}
	if gap > d.opts.MaxGap {
		d.firstPeak = at
		return false
	}

	d.firstPeak = time.Time{}
	return true
}

func (d *DoubleClapDetector) Reset() {
	d.abovePeak = false
	d.firstPeak = time.Time{}
}
