package main

import (
	"testing"
	"time"
)

// 100 ns since 1601 for a moment, as the system writes it.
func ticksAt(at time.Time) uint64 { return uint64(at.UnixNano()/100) + 116444736000000000 }

func TestNotchCallAppIsAProgramPeopleCallWith(t *testing.T) {
	for _, name := range []string{
		`C:#Program Files#Google#Chrome#Application#chrome.exe`,
		`C:#Users#sam#AppData#Local#Programs#Zoom#bin#Zoom.exe`,
		`MSTeams_8wekyb3d8bbwe`,
		`5319275A.WhatsAppDesktop_cv1g1gvanyjgm`,
		`C:#Program Files (x86)#Microsoft#Edge#Application#msedge.exe`,
	} {
		if !notchCallApp(name) {
			t.Errorf("%s was not taken for a calling program", name)
		}
	}
	for _, name := range []string{
		`C:#Program Files#Wispr Flow#Wispr Flow.exe`, // a dictation tool
		`C:#Program Files#NVIDIA Corporation#NVIDIA Broadcast#NVIDIA Broadcast.exe`,
		`Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe`,
		// A folder named like a calling program does not make what is in it one.
		`C:#Users#sam#zoom-backgrounds#recorder.exe`,
		``,
	} {
		if notchCallApp(name) {
			t.Errorf("%s was taken for a calling program", name)
		}
	}
}

func TestNotchOnCallReadsTheRecord(t *testing.T) {
	now := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	chrome := `C:#Program Files#Google#Chrome#Application#chrome.exe`
	self := `C:\Users\sam\AppData\Local\JarvisNotch\jarvis.exe`
	selfInRecord := `C:#Users#sam#AppData#Local#JarvisNotch#jarvis.exe`
	began := ticksAt(now.Add(-5 * time.Minute))
	cases := []struct {
		name   string
		record []notchMicUse
		want   bool
	}{
		{"nothing in the record", nil, false},
		{"a browser has the microphone now", []notchMicUse{{chrome, began, 0}}, true},
		{"it had it, and stopped", []notchMicUse{{chrome, began, began + 600_000_000}}, false},
		{"it never used it", []notchMicUse{{chrome, 0, 0}}, false},
		// Talking to Jarvis is not a call.
		{"only this program has it", []notchMicUse{{selfInRecord, began, 0}}, false},
		{"a dictation tool has it", []notchMicUse{{`C:#Program Files#Wispr Flow#Wispr Flow.exe`, began, 0}}, false},
		// A program that died with the microphone says it has it still, for good.
		{"a record from yesterday that never stopped", []notchMicUse{{chrome, ticksAt(now.Add(-26 * time.Hour)), 0}}, false},
		{"a start in the future", []notchMicUse{{chrome, ticksAt(now.Add(3 * time.Hour)), 0}}, false},
		{"this program and a calling one", []notchMicUse{{selfInRecord, began, 0}, {`MSTeams_8wekyb3d8bbwe`, began, 0}}, true},
	}
	for _, tc := range cases {
		if got := notchOnCall(tc.record, self, now); got != tc.want {
			t.Errorf("%s: on a call = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestNotchAroundSaysOnlyWhatItKnowsAndOnlyWhenItChanges(t *testing.T) {
	a := &NotchAround{}
	var said []map[string]any
	a.Use(func(payload map[string]any) { said = append(said, payload) })
	if len(said) != 0 {
		t.Fatalf("something was said before anything was known: %v", said)
	}
	a.SetOnline(true)
	a.SetOnline(true)
	a.SetCall(false)
	a.SetCall(true)
	a.SetCall(true)
	if len(said) != 3 {
		t.Fatalf("said %d times, want 3 (online; then with no call; then with a call): %v", len(said), said)
	}
	if _, has := said[0]["call"]; has || said[0]["online"] != true {
		t.Errorf("the first word names a fact that was not known yet: %v", said[0])
	}
	if said[2]["call"] != true || said[2]["online"] != true {
		t.Errorf("the last word is %v", said[2])
	}
	// A brain that connects later is told what is known, once.
	var again []map[string]any
	a.Use(func(payload map[string]any) { again = append(again, payload) })
	if len(again) != 1 || again[0]["call"] != true {
		t.Errorf("a new connection was told %v", again)
	}
	// And nothing after it has gone.
	a.Forget()
	a.SetCall(false)
	if len(again) != 1 {
		t.Errorf("something was said after the connection was taken away: %v", again)
	}
}
