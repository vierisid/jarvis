package main

// Listening to a call.
//
// With the person's yes for that one call, this program opens the microphone
// and, where it can and was asked to, what the machine is playing (the other
// side of the call), cuts what it hears into pieces at the pauses, and hands
// each piece to the brain to be made into words. When the call is over the
// brain writes down what was agreed.
//
// The rules, each of them the owner's decision of 8 August 2026:
//
//   - Nothing is heard unless the brain asked for this call (notch.listen),
//     and the brain asks only after the person said yes to this call. There
//     is no setting that listens without being asked.
//   - No sound is kept. A piece is in memory until it has gone out, and is
//     nowhere after that: no file, no folder.
//   - The other side is a second, separate thing to ask for ("far"). It is
//     the only thing here that hears people who switched nothing on.
//   - A muted microphone hears nothing, and neither does the other side
//     while it is muted: someone who muted Jarvis during a call did not ask
//     for the others to go on being heard.
//   - What is heard is never an instruction. It goes out as "notch.call",
//     which nothing but the call's own notes reads: the talk keys' recording
//     is "notch.talk", a different thing.
//   - It ends by itself: when the brain says so, when the connection goes,
//     when the notch is switched off, and after notchCallMost at the latest.
//
// No platform calls in this file: the two devices are handed in (notchCallEars),
// so the cutting and the rules are tested on every platform.

import (
	"encoding/binary"
	"errors"
	"math"
	"sync"
	"time"
)

var errNotchCallID = errors.New("notch.listen: a call needs an id")

const (
	// notchCallEvent carries one piece of a call, or its end.
	notchCallEvent = "notch.call"
	// The rate both devices are opened at, and the brain is told: 16 kHz, one
	// channel, 16 bits, as the talk keys' recording is.
	notchCallRate = 16000

	// The longest one piece may be. A longer stretch of speech is cut here,
	// in the middle of a sentence if it has to be.
	notchCallPieceMax = 30 * time.Second
	// A pause ends a piece only once this much has been said in it: shorter
	// pieces make out worse, and every piece is a request of its own.
	notchCallPieceMin = 6 * time.Second
	// How long a silence is a pause.
	notchCallPause = 700 * time.Millisecond
	// A silence this long ends a piece however short it is: what was said
	// before it should not wait for the next thing said.
	notchCallLongPause = 2500 * time.Millisecond
	// How much of the quiet before the first sound is kept: the start of a
	// word is quieter than its middle.
	notchCallLead = 300 * time.Millisecond
	// How much of the quiet after the last sound is kept.
	notchCallTail = 250 * time.Millisecond
	// A piece with less sound than this in it is a click or a cough, and is
	// thrown away.
	notchCallVoicedLeast = 400 * time.Millisecond
	// How loud a moment has to be to count as sound (the wake listener's
	// measure: the root mean square of 16-bit samples).
	notchCallLoudFrom = 500.0

	// No call is listened to for longer than this.
	notchCallMost = 3*time.Hour + 10*time.Minute
)

// notchCallPiece is one stretch of speech, cut at its pauses.
type notchCallPiece struct {
	PCM       []byte
	StartedAt time.Time
	Voiced    time.Duration
}

// notchCallLoudness is the root mean square of a buffer of 16-bit samples.
func notchCallLoudness(pcm []byte) float64 {
	n := len(pcm) / 2
	if n == 0 {
		return 0
	}
	var sum float64
	for i := 0; i < n; i++ {
		v := float64(int16(binary.LittleEndian.Uint16(pcm[i*2 : i*2+2])))
		sum += v * v
	}
	return math.Sqrt(sum / float64(n))
}

// notchCallCutter cuts one stream of sound into pieces. Not safe for use from
// two goroutines: its owner holds a lock.
type notchCallCutter struct {
	rate int
	now  func() time.Time

	// The piece in the making. Empty until a sound is heard.
	buf       []byte
	startedAt time.Time
	voiced    time.Duration
	quiet     time.Duration
	// The quiet just before the piece: at most notchCallLead of it.
	lead []byte
}

func newNotchCallCutter(rate int, now func() time.Time) *notchCallCutter {
	if now == nil {
		now = time.Now
	}
	return &notchCallCutter{rate: rate, now: now}
}

func (c *notchCallCutter) span(bytes int) time.Duration {
	return time.Duration(bytes/2) * time.Second / time.Duration(c.rate)
}

func (c *notchCallCutter) bytesOf(d time.Duration) int {
	return int(d*time.Duration(c.rate)/time.Second) * 2
}

// feed takes the next buffer of sound and gives back a piece when one is
// finished. The buffer is copied: the device may use it again.
func (c *notchCallCutter) feed(chunk []byte) *notchCallPiece {
	if len(chunk) < 2 {
		return nil
	}
	loud := notchCallLoudness(chunk) >= notchCallLoudFrom
	if len(c.buf) == 0 {
		if !loud {
			// Quiet, and nothing begun: only the last moment of it is kept.
			c.lead = append(c.lead, chunk...)
			if most := c.bytesOf(notchCallLead); len(c.lead) > most {
				c.lead = append([]byte(nil), c.lead[len(c.lead)-most:]...)
			}
			return nil
		}
		c.startedAt = c.now().Add(-c.span(len(c.lead) + len(chunk)))
		c.buf = append(append(make([]byte, 0, c.bytesOf(notchCallPieceMin)), c.lead...), chunk...)
		c.lead = nil
		c.voiced, c.quiet = c.span(len(chunk)), 0
		return nil
	}
	c.buf = append(c.buf, chunk...)
	if loud {
		c.voiced += c.span(len(chunk))
		c.quiet = 0
	} else {
		c.quiet += c.span(len(chunk))
	}
	long := c.span(len(c.buf))
	switch {
	case long >= notchCallPieceMax:
	case c.quiet >= notchCallLongPause:
	case c.quiet >= notchCallPause && long-c.quiet >= notchCallPieceMin:
	default:
		return nil
	}
	return c.cut()
}

// flush gives back what is in the making, if it is worth anything.
func (c *notchCallCutter) flush() *notchCallPiece {
	if len(c.buf) == 0 {
		c.lead = nil
		return nil
	}
	return c.cut()
}

func (c *notchCallCutter) cut() *notchCallPiece {
	pcm, voiced, at := c.buf, c.voiced, c.startedAt
	// The quiet at its end is cut back to a moment.
	if drop := c.bytesOf(c.quiet - notchCallTail); drop > 0 && drop < len(pcm) {
		pcm = pcm[:len(pcm)-drop]
	}
	c.buf, c.lead, c.voiced, c.quiet = nil, nil, 0, 0
	if voiced < notchCallVoicedLeast {
		return nil
	}
	return &notchCallPiece{PCM: pcm, StartedAt: at, Voiced: voiced}
}

// notchCallEars is the two devices a call is heard through.
type notchCallEars struct {
	// Mic opens the microphone, and gives back what closes it.
	Mic func(onChunk func([]byte)) (close func(), err error)
	// Far opens what the machine is playing: the other side of the call. Nil
	// where this system has no way to hear it.
	Far func(onChunk func([]byte)) (close func(), err error)
	// Muted says whether the person has muted Jarvis's microphone.
	Muted func() bool
}

// notchCallStream is one device with its cutter.
type notchCallStream struct {
	mu     sync.Mutex
	cutter *notchCallCutter
	close  func()
	pieces int
	heard  bool
}

// NotchCall listens to one call at a time.
type NotchCall struct {
	mu   sync.Mutex
	ears *notchCallEars
	send func(payload map[string]any, pcm []byte)
	now  func() time.Time

	id    string
	seq   int
	mic   *notchCallStream
	far   *notchCallStream
	timer *time.Timer
}

func newNotchCall() *NotchCall { return &NotchCall{now: time.Now} }

// notchCalls is the process-wide listener. It has no ears and nobody to tell
// until a connection gives it both.
var notchCalls = newNotchCall()

// Use gives the listener its devices and where to send what it hears. A call
// that was being listened to on an earlier connection is over.
func (c *NotchCall) Use(ears *notchCallEars, send func(payload map[string]any, pcm []byte)) {
	c.end("", false)
	c.mu.Lock()
	c.ears, c.send = ears, send
	c.mu.Unlock()
}

// Forget is the connection going away: the devices are closed, and nothing
// more is sent, because there is nobody to send it to.
func (c *NotchCall) Forget() {
	c.end("", false)
	c.mu.Lock()
	c.ears, c.send = nil, nil
	c.mu.Unlock()
}

// Listening says which call is being listened to, or "".
func (c *NotchCall) Listening() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.id
}

// Listen starts listening to a call. It answers with what is open: the
// microphone, the other side, and why not when something is not.
func (c *NotchCall) Listen(id string, far bool) (mic, farOn bool, why string) {
	if id == "" {
		return false, false, "error"
	}
	c.mu.Lock()
	if c.id == id {
		mic, farOn = c.mic != nil, c.far != nil
		c.mu.Unlock()
		return mic, farOn, ""
	}
	c.mu.Unlock()
	// Another call was being listened to: it is over.
	c.end("replaced", true)

	c.mu.Lock()
	defer c.mu.Unlock()
	ears, send := c.ears, c.send
	if ears == nil || send == nil || ears.Mic == nil {
		return false, false, "none"
	}
	if ears.Muted != nil && ears.Muted() {
		return false, false, "muted"
	}
	c.id, c.seq = id, 0
	micStream := &notchCallStream{cutter: newNotchCallCutter(notchCallRate, c.now)}
	closeMic, err := ears.Mic(c.hear(id, "mic", micStream))
	if err != nil {
		c.id = ""
		return false, false, "error"
	}
	micStream.close = closeMic
	c.mic = micStream
	why = ""
	if far {
		switch {
		case ears.Far == nil:
			why = "far_unsupported"
		default:
			farStream := &notchCallStream{cutter: newNotchCallCutter(notchCallRate, c.now)}
			closeFar, err := ears.Far(c.hear(id, "far", farStream))
			if err != nil {
				// The microphone goes on without it: half a call is still worth writing down.
				why = "far_error"
			} else {
				farStream.close = closeFar
				c.far = farStream
			}
		}
	}
	c.timer = time.AfterFunc(notchCallMost, func() { c.endIf(id, "cap") })
	return true, c.far != nil, why
}

// hear is what a device calls with every buffer of sound.
func (c *NotchCall) hear(id, source string, stream *notchCallStream) func([]byte) {
	return func(chunk []byte) {
		c.mu.Lock()
		live, ears := c.id == id, c.ears
		c.mu.Unlock()
		if !live {
			return
		}
		// Muted: nothing is heard, from either side.
		if ears != nil && ears.Muted != nil && ears.Muted() {
			return
		}
		stream.mu.Lock()
		stream.heard = true
		piece := stream.cutter.feed(chunk)
		if piece != nil {
			stream.pieces++
		}
		stream.mu.Unlock()
		if piece != nil {
			c.tell(id, source, piece)
		}
	}
}

func (c *NotchCall) tell(id, source string, piece *notchCallPiece) {
	c.mu.Lock()
	if c.id != id || c.send == nil {
		c.mu.Unlock()
		return
	}
	c.seq++
	seq, send := c.seq, c.send
	c.mu.Unlock()
	send(map[string]any{
		"id": id, "phase": "piece", "source": source, "seq": seq,
		"at":        piece.StartedAt.UnixMilli(),
		"ms":        int64(len(piece.PCM)/2) * 1000 / notchCallRate,
		"voiced_ms": piece.Voiced.Milliseconds(),
		"rate":      notchCallRate,
	}, piece.PCM)
}

// Stop ends the listening the brain asked to end. It reports whether a call
// was being listened to.
func (c *NotchCall) Stop(reason string) bool { return c.end(reason, true) }

func (c *NotchCall) endIf(id, reason string) {
	c.mu.Lock()
	same := c.id == id
	c.mu.Unlock()
	if same {
		c.end(reason, true)
	}
}

// end closes the devices. With say, what was still in the making goes out,
// and then the word that it is over.
func (c *NotchCall) end(reason string, say bool) bool {
	c.mu.Lock()
	id, mic, far, timer := c.id, c.mic, c.far, c.timer
	if id == "" {
		c.mu.Unlock()
		return false
	}
	c.mic, c.far, c.timer = nil, nil, nil
	c.mu.Unlock()
	if timer != nil {
		timer.Stop()
	}
	// The devices first: after this no more sound arrives.
	for _, stream := range []*notchCallStream{mic, far} {
		if stream != nil && stream.close != nil {
			stream.close()
		}
	}
	told := map[string]any{"id": id, "phase": "end", "reason": reason, "mic": 0, "far": 0, "far_open": far != nil, "far_heard": false}
	for source, stream := range map[string]*notchCallStream{"mic": mic, "far": far} {
		if stream == nil {
			continue
		}
		stream.mu.Lock()
		piece := stream.cutter.flush()
		if piece != nil {
			stream.pieces++
		}
		pieces, heard := stream.pieces, stream.heard
		stream.mu.Unlock()
		if piece != nil && say {
			c.tell(id, source, piece)
		}
		told[source] = pieces
		if source == "far" {
			told["far_heard"] = heard
		}
	}
	c.mu.Lock()
	send := c.send
	c.id = ""
	c.mu.Unlock()
	if say && send != nil {
		send(told, nil)
	}
	return true
}

// makeNotchListenHandler serves notch.listen: the brain asks this machine to
// listen to the call that is on, or to stop.
//
//	Params: { "on": bool, "id": string, "far": bool }
//	Result: { "listening": bool, "mic": bool, "far": bool, "why": string }
//
// why: "" when all that was asked for is open; "none" (this desktop app has
// no microphone path), "muted", "error" for the microphone; "far_unsupported"
// or "far_error" when the microphone is open and the other side is not.
func makeNotchListenHandler(c *NotchCall) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		on, _ := params["on"].(bool)
		if !on {
			was := c.Stop("asked")
			return &RPCResult{Result: map[string]any{"listening": false, "was": was}}, nil
		}
		id, _ := params["id"].(string)
		if len(id) == 0 || len(id) > 80 {
			return nil, errNotchCallID
		}
		far, _ := params["far"].(bool)
		mic, farOn, why := c.Listen(id, far)
		return &RPCResult{Result: map[string]any{"listening": mic, "mic": mic, "far": farOn, "why": why}}, nil
	}
}
