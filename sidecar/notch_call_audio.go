package main

// The two devices a call is heard through (notch_call.go).
//
// The microphone is an ordinary capture device, opened a second time beside
// the one the talk keys use: Windows and macOS hand the same microphone to as
// many listeners as ask.
//
// The other side is what the machine is playing. Windows can hand that to a
// program as if it were a microphone ("loopback"): whatever goes to the
// speakers or the headphones comes in here, whichever program plays it. So
// the people on the other end of a call are in it, and so is anything else
// the machine plays meanwhile: a video, a notification. Only Windows has
// this. On a Mac the other side is not heard, and the brain is told so.

import (
	"errors"
	"fmt"
	"log"
	"runtime"
	"sync"

	"github.com/gen2brain/malgo"
)

var (
	notchCallAudioMu  sync.Mutex
	notchCallAudioCtx *malgo.AllocatedContext
)

// notchCallAudio gives the one audio context calls are heard through, made
// the first time a call is listened to.
func notchCallAudio() (*malgo.AllocatedContext, error) {
	notchCallAudioMu.Lock()
	defer notchCallAudioMu.Unlock()
	if notchCallAudioCtx != nil {
		return notchCallAudioCtx, nil
	}
	// Sizes and states, never what was heard.
	ctx, err := newAudioContext(func(message string) { log.Printf("[notch] call: miniaudio: %s", message) })
	if err != nil {
		return nil, fmt.Errorf("the sound system could not be reached: %w", err)
	}
	notchCallAudioCtx = ctx
	return ctx, nil
}

// notchCallOpen opens one device for a call and gives back what closes it.
// far: what the machine is playing, instead of the microphone.
func notchCallOpen(far bool, onChunk func([]byte)) (func(), error) {
	if far && runtime.GOOS != "windows" {
		return nil, errors.New("the other side of a call can only be heard on Windows")
	}
	ctx, err := notchCallAudio()
	if err != nil {
		return nil, err
	}
	kind, name := malgo.Capture, "the microphone"
	if far {
		kind, name = malgo.Loopback, "what the machine plays"
	}
	// A loopback device reads a playback endpoint and delivers through the
	// capture half of the config, so the capture fields are the ones to set.
	cfg := malgo.DefaultDeviceConfig(kind)
	cfg.Capture.Format = malgo.FormatS16
	cfg.Capture.Channels = 1
	cfg.SampleRate = notchCallRate
	cfg.PeriodSizeInMilliseconds = pebbleCapturePeriodMs
	cfg.Periods = pebbleCapturePeriods
	cfg.Alsa.NoMMap = 1
	device, err := malgo.InitDevice(ctx.Context, cfg, malgo.DeviceCallbacks{Data: func(_, input []byte, _ uint32) {
		if len(input) > 0 {
			onChunk(input)
		}
	}})
	if err != nil {
		return nil, fmt.Errorf("%s could not be opened: %w", name, err)
	}
	if err := device.Start(); err != nil {
		device.Uninit()
		return nil, fmt.Errorf("%s could not be started: %w", name, err)
	}
	log.Printf("[notch] call: listening to %s", name)
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = device.Stop()
			device.Uninit()
			log.Printf("[notch] call: no longer listening to %s", name)
		})
	}, nil
}

// notchCallFarOpener is how the other side is heard on this system, or nil
// where it cannot be.
func notchCallFarOpener() func(onChunk func([]byte)) (func(), error) {
	if runtime.GOOS != "windows" {
		return nil
	}
	return func(onChunk func([]byte)) (func(), error) { return notchCallOpen(true, onChunk) }
}
