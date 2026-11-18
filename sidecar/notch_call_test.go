package main

import (
	"encoding/binary"
	"errors"
	"sync"
	"testing"
	"time"
)

// sound makes d of 16-bit samples at notchCallRate: loud (a square wave well
// over the measure) or quiet (silence).
func callSound(d time.Duration, loud bool) []byte {
	n := int(d * notchCallRate / time.Second)
	pcm := make([]byte, n*2)
	if loud {
		for i := 0; i < n; i++ {
			v := int16(4000)
			if i%2 == 1 {
				v = -4000
			}
			binary.LittleEndian.PutUint16(pcm[i*2:], uint16(v))
		}
	}
	return pcm
}

// feedCall hands a cutter sound in the 20 ms buffers a device delivers.
func feedCall(c *notchCallCutter, d time.Duration, loud bool) []*notchCallPiece {
	var out []*notchCallPiece
	for fed := time.Duration(0); fed < d; fed += 20 * time.Millisecond {
		if piece := c.feed(callSound(20*time.Millisecond, loud)); piece != nil {
			out = append(out, piece)
		}
	}
	return out
}

func span(pcm []byte) time.Duration {
	return time.Duration(len(pcm)/2) * time.Second / notchCallRate
}

func TestCallSilenceIsNoPiece(t *testing.T) {
	c := newNotchCallCutter(notchCallRate, nil)
	if got := feedCall(c, 2*time.Minute, false); len(got) != 0 {
		t.Fatalf("two minutes of silence made %d pieces", len(got))
	}
	if c.flush() != nil {
		t.Fatal("silence left something to hand over")
	}
	// And it does not grow: only a moment of the quiet is kept.
	if len(c.lead) > c.bytesOf(notchCallLead) {
		t.Fatalf("%d bytes of silence are kept", len(c.lead))
	}
}

func TestCallAPieceEndsAtAPauseOnceEnoughWasSaid(t *testing.T) {
	c := newNotchCallCutter(notchCallRate, nil)
	// Three seconds, a pause, four more: the first pause is too early to cut at.
	if got := feedCall(c, 3*time.Second, true); len(got) != 0 {
		t.Fatal("cut in the middle of speech")
	}
	if got := feedCall(c, time.Second, false); len(got) != 0 {
		t.Fatal("cut at a pause after only three seconds")
	}
	if got := feedCall(c, 4*time.Second, true); len(got) != 0 {
		t.Fatal("cut in the middle of speech")
	}
	got := feedCall(c, time.Second, false)
	if len(got) != 1 {
		t.Fatalf("eight seconds and a pause made %d pieces", len(got))
	}
	// The pause inside it is kept, the quiet at its end is cut back.
	if long := span(got[0].PCM); long < 8*time.Second || long > 8*time.Second+notchCallTail+40*time.Millisecond {
		t.Fatalf("the piece is %v long", long)
	}
	if got[0].Voiced < 6900*time.Millisecond || got[0].Voiced > 7100*time.Millisecond {
		t.Fatalf("seven seconds of sound were counted as %v", got[0].Voiced)
	}
}

func TestCallALongSilenceEndsAShortRemark(t *testing.T) {
	c := newNotchCallCutter(notchCallRate, nil)
	feedCall(c, 1500*time.Millisecond, true)
	if got := feedCall(c, notchCallLongPause-100*time.Millisecond, false); len(got) != 0 {
		t.Fatal("cut before the silence was long")
	}
	if got := feedCall(c, 200*time.Millisecond, false); len(got) != 1 {
		t.Fatal("a remark followed by a long silence was not handed over")
	}
}

func TestCallSpeechWithoutAPauseIsCutAtTheMost(t *testing.T) {
	c := newNotchCallCutter(notchCallRate, nil)
	got := feedCall(c, 65*time.Second, true)
	if len(got) != 2 {
		t.Fatalf("65 seconds without a pause made %d pieces", len(got))
	}
	for _, piece := range got {
		if long := span(piece.PCM); long < notchCallPieceMax || long > notchCallPieceMax+40*time.Millisecond {
			t.Fatalf("a piece is %v long", long)
		}
	}
	if rest := c.flush(); rest == nil || span(rest.PCM) < 4*time.Second {
		t.Fatal("the last five seconds were not handed over at the end")
	}
}

func TestCallAClickIsThrownAway(t *testing.T) {
	c := newNotchCallCutter(notchCallRate, nil)
	feedCall(c, 100*time.Millisecond, true)
	if got := feedCall(c, 4*time.Second, false); len(got) != 0 {
		t.Fatal("a click was handed over as speech")
	}
	if len(c.buf) != 0 {
		t.Fatal("the click is still being kept")
	}
}

func TestCallAPieceBeginsALittleBeforeItsFirstSound(t *testing.T) {
	now := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	c := newNotchCallCutter(notchCallRate, func() time.Time { return now })
	feedCall(c, 5*time.Second, false)
	feedCall(c, 7*time.Second, true)
	got := feedCall(c, time.Second, false)
	if len(got) != 1 {
		t.Fatalf("%d pieces", len(got))
	}
	lead := span(got[0].PCM) - 7*time.Second - notchCallTail
	if lead < notchCallLead-40*time.Millisecond || lead > notchCallLead+40*time.Millisecond {
		t.Fatalf("%v of quiet is kept before the first sound", lead)
	}
}

// fakeEars are two devices that hand over what a test tells them to.
type fakeEars struct {
	mu       sync.Mutex
	mic, far func([]byte)
	closed   []string
	muted    bool
	farErr   error
	micErr   error
}

func (f *fakeEars) ears(withFar bool) *notchCallEars {
	e := &notchCallEars{
		Muted: func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.muted },
		Mic: func(onChunk func([]byte)) (func(), error) {
			if f.micErr != nil {
				return nil, f.micErr
			}
			f.mu.Lock()
			f.mic = onChunk
			f.mu.Unlock()
			return func() { f.mu.Lock(); f.closed = append(f.closed, "mic"); f.mic = nil; f.mu.Unlock() }, nil
		},
	}
	if withFar {
		e.Far = func(onChunk func([]byte)) (func(), error) {
			if f.farErr != nil {
				return nil, f.farErr
			}
			f.mu.Lock()
			f.far = onChunk
			f.mu.Unlock()
			return func() { f.mu.Lock(); f.closed = append(f.closed, "far"); f.far = nil; f.mu.Unlock() }, nil
		}
	}
	return e
}

func (f *fakeEars) say(source string, d time.Duration, loud bool) {
	for fed := time.Duration(0); fed < d; fed += 20 * time.Millisecond {
		f.mu.Lock()
		to := f.mic
		if source == "far" {
			to = f.far
		}
		f.mu.Unlock()
		if to != nil {
			to(callSound(20*time.Millisecond, loud))
		}
	}
}

type callTold struct {
	payload map[string]any
	pcm     int
}

func callWorld(withFar bool) (*NotchCall, *fakeEars, func() []callTold) {
	ears := &fakeEars{}
	var mu sync.Mutex
	var told []callTold
	call := newNotchCall()
	call.Use(ears.ears(withFar), func(payload map[string]any, pcm []byte) {
		mu.Lock()
		told = append(told, callTold{payload, len(pcm)})
		mu.Unlock()
	})
	return call, ears, func() []callTold { mu.Lock(); defer mu.Unlock(); return append([]callTold(nil), told...) }
}

func TestCallNothingIsHeardUntilItIsAskedFor(t *testing.T) {
	call, ears, told := callWorld(true)
	if ears.mic != nil || ears.far != nil {
		t.Fatal("a device is open before anything was asked")
	}
	if call.Listening() != "" || len(told()) != 0 {
		t.Fatal("it is listening by itself")
	}
}

func TestCallBothSidesArePiecesOfTheirOwn(t *testing.T) {
	call, ears, told := callWorld(true)
	mic, far, why := call.Listen("c1", true)
	if !mic || !far || why != "" {
		t.Fatalf("mic %v far %v why %q", mic, far, why)
	}
	ears.say("mic", 7*time.Second, true)
	ears.say("mic", time.Second, false)
	ears.say("far", 8*time.Second, true)
	ears.say("far", time.Second, false)
	got := told()
	if len(got) != 2 {
		t.Fatalf("%d things were told", len(got))
	}
	if got[0].payload["source"] != "mic" || got[1].payload["source"] != "far" || got[0].payload["seq"] != 1 || got[1].payload["seq"] != 2 {
		t.Fatalf("%v then %v", got[0].payload, got[1].payload)
	}
	for _, one := range got {
		if one.payload["id"] != "c1" || one.payload["phase"] != "piece" || one.payload["rate"] != notchCallRate || one.pcm == 0 {
			t.Fatalf("%v with %d bytes", one.payload, one.pcm)
		}
	}
}

func TestCallStoppingHandsOverWhatWasBeingSaidAndThenSaysItIsOver(t *testing.T) {
	call, ears, told := callWorld(true)
	call.Listen("c1", true)
	ears.say("mic", 3*time.Second, true)
	if !call.Stop("asked") {
		t.Fatal("it was not listening")
	}
	got := told()
	if len(got) != 2 || got[0].payload["phase"] != "piece" || got[1].payload["phase"] != "end" {
		t.Fatalf("%v", got)
	}
	end := got[1].payload
	if end["reason"] != "asked" || end["mic"] != 1 || end["far"] != 0 || end["far_open"] != true || end["far_heard"] != false {
		t.Fatalf("the end: %v", end)
	}
	if len(ears.closed) != 2 || call.Listening() != "" {
		t.Fatalf("closed %v, listening to %q", ears.closed, call.Listening())
	}
	// Sound that still arrives is nobody's.
	if call.Stop("asked") {
		t.Fatal("stopped twice")
	}
}

func TestCallTheOtherSideIsOnlyHeardWhenAskedFor(t *testing.T) {
	call, ears, _ := callWorld(true)
	mic, far, why := call.Listen("c1", false)
	if !mic || far || why != "" || ears.far != nil {
		t.Fatalf("mic %v far %v why %q, far device open %v", mic, far, why, ears.far != nil)
	}
}

func TestCallWhereTheOtherSideCannotBeHeardTheMicrophoneGoesOn(t *testing.T) {
	call, _, _ := callWorld(false)
	if mic, far, why := call.Listen("c1", true); !mic || far || why != "far_unsupported" {
		t.Fatalf("no way to hear the other side: mic %v far %v why %q", mic, far, why)
	}
	call2, ears2, _ := callWorld(true)
	ears2.farErr = errors.New("no device")
	if mic, far, why := call2.Listen("c1", true); !mic || far || why != "far_error" {
		t.Fatalf("the other side would not open: mic %v far %v why %q", mic, far, why)
	}
}

func TestCallAMutedMicrophoneHearsNothingFromEitherSide(t *testing.T) {
	call, ears, told := callWorld(true)
	ears.muted = true
	if mic, _, why := call.Listen("c1", true); mic || why != "muted" {
		t.Fatalf("muted, and it listens: %v %q", mic, why)
	}
	ears.muted = false
	call.Listen("c1", true)
	ears.muted = true
	ears.say("mic", 8*time.Second, true)
	ears.say("far", 8*time.Second, true)
	ears.muted = false
	ears.say("mic", time.Second, false)
	ears.say("far", time.Second, false)
	if got := told(); len(got) != 0 {
		t.Fatalf("something said while muted was handed over: %v", got)
	}
}

func TestCallTheConnectionGoingClosesTheDevicesAndSaysNothing(t *testing.T) {
	call, ears, told := callWorld(true)
	call.Listen("c1", true)
	ears.say("mic", 3*time.Second, true)
	call.Forget()
	if len(ears.closed) != 2 || len(told()) != 0 || call.Listening() != "" {
		t.Fatalf("closed %v, told %v", ears.closed, told())
	}
	if mic, _, why := call.Listen("c2", false); mic || why != "none" {
		t.Fatal("with no connection there is nothing to listen with")
	}
}

func TestCallTheHandlerAsksAndStops(t *testing.T) {
	call, ears, told := callWorld(true)
	handler := makeNotchListenHandler(call)
	if _, err := handler(map[string]any{"on": true}); err == nil {
		t.Fatal("a call with no id was listened to")
	}
	res, err := handler(map[string]any{"on": true, "id": "c1", "far": true})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Result.(map[string]any); got["listening"] != true || got["far"] != true || got["why"] != "" {
		t.Fatalf("%v", got)
	}
	ears.say("far", 2*time.Second, true)
	res, _ = handler(map[string]any{"on": false})
	if got := res.Result.(map[string]any); got["listening"] != false || got["was"] != true {
		t.Fatalf("%v", got)
	}
	if got := told(); len(got) != 2 || got[1].payload["far_heard"] != true {
		t.Fatalf("%v", got)
	}
}
