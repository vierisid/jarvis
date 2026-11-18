package main

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// What is going on around the person, as far as two facts go.
//
// The notch holds things back while the person is on a call, and says so when
// the connection is lost (pass 8). The brain cannot know either by itself, so
// this program tells it two things about the machine it runs on, each a yes or
// a no, in the event `notch.around`:
//
//   - `call`: a program that people make calls with is using the microphone
//     now. Which programs use the microphone is something the system itself
//     keeps a record of (notch_around_windows.go); nothing is listened to and
//     nothing is recorded to know it. Which program it is, is not said.
//   - `online`: the system says this machine has a connection.
//
// A fact this program cannot tell on this system is left out of the event:
// the brain then knows that it does not know, and holds nothing back for it.
//
// As with where the person is (notch_where.go), nothing is said until a brain
// with the notch on is connected, and nothing after it has gone.

const notchAroundEvent = "notch.around"

// How long ago a program may have started using the microphone and still be
// believed. A program that died while it had the microphone leaves a record
// that says it has it still, for good: that must not read as a call for good.
const notchMicFreshFor = 6 * time.Hour

// NotchAround keeps the two facts and says them when they change.
type NotchAround struct {
	mu          sync.Mutex
	send        func(payload map[string]any)
	callKnown   bool
	call        bool
	onlineKnown bool
	online      bool
	last        string
}

var notchAround = &NotchAround{}

// The system is asked from the first time a brain with the notch on connects,
// and then for as long as this program runs.
var notchAroundStart sync.Once

// Use gives it a connection whose brain has the notch on. What is known is
// said at once.
func (a *NotchAround) Use(send func(payload map[string]any)) {
	a.mu.Lock()
	a.send = send
	a.last = ""
	a.mu.Unlock()
	a.tell()
}

func (a *NotchAround) Forget() {
	a.mu.Lock()
	a.send = nil
	a.last = ""
	a.mu.Unlock()
}

// SetCall is whether a calling program has the microphone now.
func (a *NotchAround) SetCall(on bool) {
	a.mu.Lock()
	a.callKnown, a.call = true, on
	a.mu.Unlock()
	a.tell()
}

// SetOnline is whether the system says this machine has a connection.
func (a *NotchAround) SetOnline(online bool) {
	a.mu.Lock()
	a.onlineKnown, a.online = true, online
	a.mu.Unlock()
	a.tell()
}

// notchAroundPayload is what the brain is told: only what is known.
func notchAroundPayload(callKnown, call, onlineKnown, online bool) map[string]any {
	payload := map[string]any{}
	if callKnown {
		payload["call"] = call
	}
	if onlineKnown {
		payload["online"] = online
	}
	return payload
}

func (a *NotchAround) tell() {
	a.mu.Lock()
	send := a.send
	payload := notchAroundPayload(a.callKnown, a.call, a.onlineKnown, a.online)
	said, _ := json.Marshal(payload)
	if send == nil || len(payload) == 0 || string(said) == a.last {
		a.mu.Unlock()
		return
	}
	a.last = string(said)
	a.mu.Unlock()
	send(payload)
}

// notchMicUse is one program's entry in the system's record of who used the
// microphone: its name there (a path, or a package's name), and when it last
// began and stopped, as the system's own clock counts (100 ns since 1601). A
// stop of 0 with a start that is not 0 is "it has the microphone now".
type notchMicUse struct {
	App   string
	Start uint64
	Stop  uint64
}

// The programs people make calls with, by the name the system keeps them
// under. A browser is one: a call in a browser is a call. Everything else
// that holds the microphone (a dictation tool, a noise filter, an assistant
// that listens for its name) is not a call, and some of those hold it all day.
//
// Three lists, by how a name may be matched. A short name is also a piece of
// other words: "arc" is in "SearchHost", and matched by any piece of a name,
// Windows' own search was a calling program, and the notch held everything
// for as long as it had the microphone (the hardening audit, 17 November
// 2026).
var (
	// Only as a whole word of the name: "arc.exe", never "searchhost".
	notchCallWords = []string{"arc", "g2m", "opera", "loom", "tuple", "around"}
	// As the beginning of a word of the name: "zoom.exe", "Zoom.us", "teams2",
	// "SkypeApp".
	notchCallStarts = []string{"zoom", "brave", "teams", "slack", "skype", "webex"}
	// As any piece of the name: long enough to be nobody else's.
	notchCallPieces = []string{
		"chrome", "msedge", "firefox", "vivaldi", "discord", "msteams", "ms-teams", "whatsapp", "telegram", "signal",
		"facetime", "gotomeeting", "bluejeans", "ringcentral", "whereby", "ciscocollab",
	}
)

// notchCallApp says whether a name in the record is a program people make
// calls with.
func notchCallApp(name string) bool {
	lower := strings.ToLower(name)
	// The last piece of a path: the program itself, not a folder it is in.
	if at := strings.LastIndexAny(lower, "#\\/"); at >= 0 {
		lower = lower[at+1:]
	}
	for _, app := range notchCallPieces {
		if strings.Contains(lower, app) {
			return true
		}
	}
	// The words of the name: what stands between its dots, dashes and blanks.
	words := strings.FieldsFunc(lower, func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9')
	})
	for _, word := range words {
		for _, app := range notchCallWords {
			if word == app {
				return true
			}
		}
		for _, app := range notchCallStarts {
			if strings.HasPrefix(word, app) {
				return true
			}
		}
	}
	return false
}

// notchFiletime turns the system's count into a time.
func notchFiletime(ticks uint64) time.Time {
	const toUnix = 116444736000000000 // 100 ns from 1601 to 1970
	if ticks < toUnix {
		return time.Time{}
	}
	return time.Unix(0, int64(ticks-toUnix)*100)
}

// notchOnCall reads the record: is a calling program, other than this one,
// using the microphone now? `self` is this program's own path: it uses the
// microphone when the person talks to Jarvis, and that is not a call.
func notchOnCall(record []notchMicUse, self string, now time.Time) bool {
	own := strings.ToLower(strings.ReplaceAll(self, "\\", "#"))
	for _, use := range record {
		if use.Start == 0 || use.Stop != 0 {
			continue
		}
		if own != "" && strings.ToLower(use.App) == own {
			continue
		}
		if !notchCallApp(use.App) {
			continue
		}
		began := notchFiletime(use.Start)
		if began.IsZero() || now.Sub(began) > notchMicFreshFor || began.After(now.Add(time.Hour)) {
			continue
		}
		return true
	}
	return false
}
