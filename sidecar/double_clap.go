package main

import (
	"encoding/binary"
	"errors"
	"math"
	"time"
)

type PCMTransientFeatures struct {
	RMS              float64
	PeakAbs          float64
	CrestFactor      float64
	ZeroCrossingRate float64
}

// pcmTransientFeatures reduces a PCM chunk to non-reversible numeric metrics.
// No samples leave the callback and no audio is retained.
func pcmTransientFeatures(pcm []byte) PCMTransientFeatures {
	if len(pcm) < 2 {
		return PCMTransientFeatures{}
	}
	n := len(pcm) / 2
	var sumSq float64
	var peak float64
	var crossings int
	var previous int16
	for i := 0; i < n; i++ {
		sample := int16(binary.LittleEndian.Uint16(pcm[i*2 : i*2+2]))
		value := float64(sample)
		abs := math.Abs(value)
		if abs > peak {
			peak = abs
		}
		sumSq += value * value
		if i > 0 && ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) {
			crossings++
		}
		previous = sample
	}
	rms := math.Sqrt(sumSq / float64(n))
	crest := 0.0
	if rms > 0 {
		crest = peak / rms
	}
	zcr := 0.0
	if n > 1 {
		zcr = float64(crossings) / float64(n-1)
	}
	return PCMTransientFeatures{RMS: rms, PeakAbs: peak, CrestFactor: crest, ZeroCrossingRate: zcr}
}

// DoubleClapDetectorOpts contains calibration values supplied by the caller.
// There are deliberately no production defaults yet: real microphone samples
// must determine them before this detector is connected to capture or actions.
type DoubleClapDetectorOpts struct {
	PeakThreshold  float64
	MinPeakAbs     float64
	ResetThreshold float64
	MinGap         time.Duration
	MaxGap         time.Duration
}

// CalibratedDoubleClapOpts returns the locally verified MacBook profile.
// It is used only after the user explicitly enables both continuous wake and
// double-clap summon; there is no implicit always-listening path.
func CalibratedDoubleClapOpts() DoubleClapDetectorOpts {
	return DoubleClapDetectorOpts{
		PeakThreshold: 5000, MinPeakAbs: 15000, ResetThreshold: 2500,
		MinGap: 150 * time.Millisecond, MaxGap: 600 * time.Millisecond,
	}
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
	if opts.PeakThreshold <= 0 || opts.MinPeakAbs < 0 || opts.ResetThreshold < 0 {
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
	return d.ObserveFeatures(pcmTransientFeatures(pcm), at)
}

// ObserveFeatures applies the calibrated impulse floor before the existing
// RMS hysteresis. A loud but non-impulsive chunk cannot become a clap peak.
func (d *DoubleClapDetector) ObserveFeatures(features PCMTransientFeatures, at time.Time) bool {
	if features.RMS >= d.opts.PeakThreshold && features.PeakAbs < d.opts.MinPeakAbs {
		features.RMS = math.Nextafter(d.opts.PeakThreshold, 0)
	}
	return d.ObserveEnergy(features.RMS, at)
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
