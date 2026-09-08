package main

import "testing"

// The wake listener holds one capture session open for as long as it is armed,
// which is hours, and it discards Stop()'s buffer. Accumulating there grew a
// bytes.Buffer without bound at ~115 MB an hour, and every doubling was a
// realloc inside the miniaudio data callback: a stall on the audio thread,
// which is the failure class this file exists to avoid.
func TestNewAudioSessionOnlyReservesWhenItAccumulates(t *testing.T) {
	streaming := newAudioSession("wake-1", pebbleAudioSampleRate, false)
	if streaming.pcm != nil {
		t.Fatal("a streaming session must not allocate an accumulator to grow")
	}

	accumulating := newAudioSession("summon-1", pebbleAudioSampleRate, true)
	if accumulating.pcm == nil {
		t.Fatal("an accumulating session has nowhere to put the capture")
	}
	// Reserved ahead of the VAD's hard cap so the audio thread never grows it.
	want := pebbleAudioSampleRate * pebbleAudioChannels * 2 * pebbleCaptureReserveSeconds
	if got := accumulating.pcm.Cap(); got < want {
		t.Fatalf("reserved %d bytes, want at least %d", got, want)
	}
	hardCapBytes := int(DefaultVADOpts().HardCap.Seconds()) * pebbleAudioSampleRate * pebbleAudioChannels * 2
	if want <= hardCapBytes {
		t.Fatalf("reservation %d does not clear the VAD hard cap of %d bytes", want, hardCapBytes)
	}
}

// The rate matters: a 24 kHz session reserves more than a 16 kHz one for the
// same wall-clock duration.
func TestNewAudioSessionScalesTheReservationWithTheRate(t *testing.T) {
	low := newAudioSession("a", 16000, true)
	high := newAudioSession("b", 24000, true)
	if high.pcm.Cap() <= low.pcm.Cap() {
		t.Fatalf("24 kHz reserved %d, 16 kHz reserved %d", high.pcm.Cap(), low.pcm.Cap())
	}
}
