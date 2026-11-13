package main

// Talking to the notch: the microphone is open while the talk keys are held.
//
// The keys say three things (notch_keys.go): talking started, talking ended
// by letting go, talking ended by a slip. This file turns them into one
// recording each, and tells the brain with one event type, `notch.talk`:
//
//	start      the microphone is open                  {talk_id}
//	end        let go: here is the recording           {talk_id, voiced_ms, duration_ms, sample_rate, reason} + audio
//	cancelled  thrown away here, never sent            {talk_id}
//	refused    the microphone was not opened           {reason}
//
// Why it is decided here and not in the brain: the microphone is this app's
// (tray_status.go), a round trip would clip the first syllable, and if the
// connection drops in the middle of a sentence only this side can close the
// device. The brain decides everything after the audio.
//
// What never leaves this machine: a recording that was cancelled, one made
// while the microphone was muted, and one with too little speech in it to be
// an instruction (the brain is told how little, and gets no audio).
//
// Every recording has an id made here when the microphone opens. The brain
// acts on audio only if its id is the recording it was told is open.
//
// Nothing in this file touches a platform. The microphone is handed in.

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"sync/atomic"
	"time"
)

const (
	notchTalkEvent = "notch.talk"
	// The longest one recording may be. Past it the microphone closes by
	// itself: a key that stuck, or a lost key-up, must not leave it open.
	notchTalkCap = 60 * time.Second
	// Less voiced sound than this is not an instruction. The audio is not sent.
	notchTalkMinVoicedMs = 250
	// How loud a piece of sound must be to count as voice. The same level the
	// one-shot capture and the wake listener use (DefaultVADOpts).
	notchTalkVoiceRMS = 500.0
)

// notchTalkMic is the microphone as talking needs it.
type notchTalkMic struct {
	// Open starts a recording. A non-empty answer says why it did not:
	// "muted", "busy" (something else is recording), or "error".
	Open func(id string, onChunk func([]byte)) (refused string)
	// Close stops it and hands over what was recorded.
	Close func() (pcm []byte, dur time.Duration)
	// Muted says whether the person has the microphone muted now.
	Muted func() bool
	// SampleRate is the recording's rate, for the brain.
	SampleRate int
}

type notchTalkCmd struct {
	kind   uint8 // 1 start, 2 end, 3 cancel, 4 let go of the microphone
	reason string
	// For an end sent by the cap's timer: the recording it was armed for.
	id string
	// Closed when the command has been carried out.
	done chan struct{}
}

// notchTalker makes one recording per hold of the talk keys.
type notchTalker struct {
	mu   sync.Mutex
	mic  *notchTalkMic
	send func(phase string, payload map[string]any, pcm []byte)
	cap  time.Duration

	cmds chan notchTalkCmd
	once sync.Once

	// Owned by the run loop.
	cur        string
	voiced     atomic.Int64 // bytes of sound loud enough to be voice
	capTimer   *time.Timer
	sampleRate int
}

func newNotchTalker() *notchTalker {
	return &notchTalker{cap: notchTalkCap, cmds: make(chan notchTalkCmd, 16)}
}

// use gives the talker its way to the brain and, if this app has one, its
// microphone. With no microphone (nil) a hold of the keys is answered with
// "refused", so the notch can say why nothing is heard.
func (t *notchTalker) use(mic *notchTalkMic, send func(phase string, payload map[string]any, pcm []byte)) {
	t.mu.Lock()
	t.mic, t.send = mic, send
	t.mu.Unlock()
}

// forget takes the microphone and the way to the brain away, when the
// connection that had them ends. A recording that is open is thrown away. It
// goes through the loop, so that recording is closed on the microphone it was
// opened on before that microphone is forgotten, and comes back when it is.
func (t *notchTalker) forget() {
	done := make(chan struct{})
	t.start()
	t.cmds <- notchTalkCmd{kind: 4, done: done}
	<-done
}

func (t *notchTalker) start() {
	t.once.Do(func() { go t.run() })
}

// key takes what the keys said. It never blocks: on a Mac it is called from
// inside the keyboard tap, which the system switches off if it is slow.
func (t *notchTalker) key(action notchKeyAction) {
	var cmd notchTalkCmd
	switch action {
	case notchKeyTalkStart:
		cmd = notchTalkCmd{kind: 1}
	case notchKeyTalkEnd:
		cmd = notchTalkCmd{kind: 2, reason: "released"}
	case notchKeyTalkCancel:
		cmd = notchTalkCmd{kind: 3}
	default:
		return
	}
	t.start()
	select {
	case t.cmds <- cmd:
	default:
		// Full only if the loop is stuck in the device. Whatever is open is
		// closed by its cap.
	}
}

func (t *notchTalker) run() {
	for cmd := range t.cmds {
		switch cmd.kind {
		case 1:
			t.begin()
		case 2:
			if cmd.id == "" || cmd.id == t.cur {
				t.end(cmd.reason)
			}
		case 3:
			t.drop(true)
		case 4:
			t.drop(false)
			t.mu.Lock()
			t.mic, t.send = nil, nil
			t.mu.Unlock()
		}
		if cmd.done != nil {
			close(cmd.done)
		}
	}
}

func (t *notchTalker) parts() (*notchTalkMic, func(string, map[string]any, []byte)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.mic, t.send
}

func newNotchTalkID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "t" + hex.EncodeToString([]byte(time.Now().Format("150405.000000000")))
	}
	return "t" + hex.EncodeToString(b[:])
}

func (t *notchTalker) begin() {
	if t.cur != "" {
		return
	}
	mic, send := t.parts()
	if send == nil {
		return
	}
	if mic == nil {
		send("refused", map[string]any{"reason": "none"}, nil)
		return
	}
	id := newNotchTalkID()
	t.voiced.Store(0)
	refused := mic.Open(id, func(chunk []byte) {
		// On the audio thread: count, and nothing else.
		if pcmRMSint16(chunk) >= notchTalkVoiceRMS {
			t.voiced.Add(int64(len(chunk)))
		}
	})
	if refused != "" {
		send("refused", map[string]any{"reason": refused}, nil)
		return
	}
	t.cur = id
	t.sampleRate = mic.SampleRate
	send("start", map[string]any{"talk_id": id}, nil)
	t.capTimer = time.AfterFunc(t.cap, func() {
		select {
		case t.cmds <- notchTalkCmd{kind: 2, reason: "cap", id: id}:
		default:
		}
	})
}

// close stops the open recording and comes back with it.
func (t *notchTalker) close() (id string, pcm []byte, dur time.Duration, mic *notchTalkMic, send func(string, map[string]any, []byte)) {
	id = t.cur
	t.cur = ""
	if t.capTimer != nil {
		t.capTimer.Stop()
		t.capTimer = nil
	}
	mic, send = t.parts()
	if mic != nil {
		pcm, dur = mic.Close()
	}
	return id, pcm, dur, mic, send
}

func (t *notchTalker) voicedMs() int64 {
	rate := int64(t.sampleRate)
	if rate <= 0 {
		rate = pebbleAudioSampleRate
	}
	// 16-bit mono: two bytes a sample.
	return t.voiced.Load() * 1000 / (rate * 2)
}

func (t *notchTalker) end(reason string) {
	if t.cur == "" {
		return
	}
	id, pcm, dur, mic, send := t.close()
	if send == nil {
		return
	}
	// Muted while the keys were held: what was recorded before stays here.
	if mic == nil || mic.Muted() {
		send("cancelled", map[string]any{"talk_id": id}, nil)
		return
	}
	voiced := t.voicedMs()
	payload := map[string]any{
		"talk_id":     id,
		"voiced_ms":   voiced,
		"duration_ms": dur.Milliseconds(),
		"sample_rate": t.sampleRate,
		"channels":    1,
		"format":      "pcm_s16le",
		"reason":      reason,
	}
	if voiced < notchTalkMinVoicedMs || reason == "cap" {
		// Too little to be an instruction, or one that ran into the limit:
		// the brain is told, and the sound stays here.
		send("end", payload, nil)
		return
	}
	send("end", payload, pcm)
}

// drop throws the open recording away. tell says whether the brain hears of it.
func (t *notchTalker) drop(tell bool) {
	if t.cur == "" {
		return
	}
	id, _, _, _, send := t.close()
	if tell && send != nil {
		send("cancelled", map[string]any{"talk_id": id}, nil)
	}
}
