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
	"log"
	"sort"
	"sync"
	"time"
)

const (
	notchTalkEvent = "notch.talk"
	// The longest one recording may be. Past it the microphone closes by
	// itself: a key that stuck, or a lost key-up, must not leave it open.
	notchTalkCap = 60 * time.Second
	// Less voiced sound than this is not an instruction. The audio is not sent.
	// One short word ("yes", "stop") is about 180 to 220 ms of voice, so the
	// floor is under that: at 250 those words were thrown away.
	notchTalkMinVoicedMs = 150

	// How loud a piece of sound must be to count as voice is not one number:
	// a webcam microphone across a desk is ten times quieter than a headset.
	// So it is judged against the recording's own quiet: a piece is voice
	// when it is this many times louder than the quiet tenth of the pieces.
	// (The first build used the fixed 500 of the one-shot capture. On the
	// first real microphone it met, a Logitech C270, speech hardly reached
	// it, and every recording was thrown away as "too little".)
	// (At 2.5 a fan under a quiet microphone raised the level above the
	// speech. 1.8 still leaves a steady room, quiet or not, under it.)
	notchTalkVoiceOverQuiet = 1.8
	// Never lower than this: below it is the hiss of the microphone itself.
	notchTalkVoiceFloorRMS = 90.0
	// Never higher than this, however loud the room: what the fixed level
	// passed, this passes too.
	notchTalkVoiceCapRMS = 500.0
)

// notchTalkPiece is one piece of sound as the device handed it over: how loud
// it was, and how many bytes long.
type notchTalkPiece struct {
	rms   float32
	bytes int32
}

// notchTalkHeard is what was measured in one recording. It is written to the
// log for every recording, so that a level that is wrong for some microphone
// can be seen and not guessed at.
type notchTalkHeard struct {
	VoicedMs int64
	// How loud a piece had to be to count as voice in this recording.
	Level float64
	// The quiet tenth, the middle, the loud tenth and the loudest piece.
	Quiet, Middle, Loud, Loudest float64
	Pieces                        int
}

// notchTalkMeasure says how much voice there is in a recording.
func notchTalkMeasure(pieces []notchTalkPiece, sampleRate int) notchTalkHeard {
	heard := notchTalkHeard{Pieces: len(pieces), Level: notchTalkVoiceFloorRMS}
	if len(pieces) == 0 {
		return heard
	}
	if sampleRate <= 0 {
		sampleRate = pebbleAudioSampleRate
	}
	levels := make([]float64, len(pieces))
	for i, piece := range pieces {
		levels[i] = float64(piece.rms)
	}
	sort.Float64s(levels)
	at := func(part float64) float64 { return levels[int(part*float64(len(levels)-1))] }
	heard.Quiet, heard.Middle, heard.Loud, heard.Loudest = at(0.1), at(0.5), at(0.9), levels[len(levels)-1]
	level := heard.Quiet * notchTalkVoiceOverQuiet
	if level < notchTalkVoiceFloorRMS {
		level = notchTalkVoiceFloorRMS
	}
	if level > notchTalkVoiceCapRMS {
		level = notchTalkVoiceCapRMS
	}
	heard.Level = level
	var voiced int64
	for _, piece := range pieces {
		if float64(piece.rms) >= level {
			voiced += int64(piece.bytes)
		}
	}
	// 16-bit mono: two bytes a sample.
	heard.VoicedMs = voiced * 1000 / (int64(sampleRate) * 2)
	return heard
}

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
	capTimer   *time.Timer
	sampleRate int

	// The pieces of the open recording. Written on the audio thread.
	piecesMu sync.Mutex
	pieces   []notchTalkPiece
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
	t.piecesMu.Lock()
	// Room for the whole cap at the device's 20 ms pieces, so nothing grows on the audio thread.
	if cap(t.pieces) < 4096 {
		t.pieces = make([]notchTalkPiece, 0, 4096)
	}
	t.pieces = t.pieces[:0]
	t.piecesMu.Unlock()
	refused := mic.Open(id, func(chunk []byte) {
		// On the audio thread: measure, note, and nothing else.
		piece := notchTalkPiece{rms: float32(pcmRMSint16(chunk)), bytes: int32(len(chunk))}
		t.piecesMu.Lock()
		if len(t.pieces) < cap(t.pieces) {
			t.pieces = append(t.pieces, piece)
		}
		t.piecesMu.Unlock()
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

// measure says how much voice the recording that was just closed had in it,
// and writes what it found to the log with what became of the recording.
func (t *notchTalker) measure(id string, dur time.Duration, outcome func(notchTalkHeard) string) notchTalkHeard {
	t.piecesMu.Lock()
	heard := notchTalkMeasure(t.pieces, t.sampleRate)
	t.piecesMu.Unlock()
	log.Printf("[notch] talk %s: %.2fs, %d ms of voice at level %.0f (quiet %.0f, middle %.0f, loud %.0f, loudest %.0f, %d pieces): %s",
		id, dur.Seconds(), heard.VoicedMs, heard.Level, heard.Quiet, heard.Middle, heard.Loud, heard.Loudest, heard.Pieces, outcome(heard))
	return heard
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
		t.measure(id, dur, func(notchTalkHeard) string { return "muted, not sent" })
		send("cancelled", map[string]any{"talk_id": id}, nil)
		return
	}
	voiced := t.measure(id, dur, func(heard notchTalkHeard) string {
		switch {
		case heard.VoicedMs < notchTalkMinVoicedMs:
			return "too little voice, not sent"
		case reason == "cap":
			return "ran into the limit, sent as far as it got"
		}
		return "sent"
	}).VoicedMs
	payload := map[string]any{
		"talk_id":     id,
		"voiced_ms":   voiced,
		"duration_ms": dur.Milliseconds(),
		"sample_rate": t.sampleRate,
		"channels":    1,
		"format":      "pcm_s16le",
		"reason":      reason,
	}
	if voiced < notchTalkMinVoicedMs {
		// Too little to be an instruction: the brain is told, and the sound
		// stays here.
		send("end", payload, nil)
		return
	}
	// One that ran into the limit is sent as far as it got, marked as that
	// (reason "cap"): the brain asks before acting on words that may stop in
	// the middle of a sentence. The whole minute used to be thrown away.
	send("end", payload, pcm)
}

// drop throws the open recording away. tell says whether the brain hears of it.
func (t *notchTalker) drop(tell bool) {
	if t.cur == "" {
		return
	}
	id, _, dur, _, send := t.close()
	t.measure(id, dur, func(notchTalkHeard) string { return "thrown away, not sent" })
	if tell && send != nil {
		send("cancelled", map[string]any{"talk_id": id}, nil)
	}
}
