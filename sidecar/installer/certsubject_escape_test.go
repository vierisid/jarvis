package main

import "testing"

// RFC 4514 escapes other than \, must also be reversed — otherwise a CN like
// `Jarvis \+ Co` never EqualFold-matches the pin and a legitimately signed
// payload is refused at exit 3.
func TestSubjectCNUnescapesAllSpecials(t *testing.T) {
	cases := map[string]string{
		`CN=Jarvis \+ Co, O=Jarvis`:   "Jarvis + Co",
		`CN=Jarvis \; Co`:             "Jarvis ; Co",
		`CN=Jarvis \= Co`:             "Jarvis = Co",
		`CN=Jarvis \\ Co`:             `Jarvis \ Co`,
		`CN=Jarvis \" Co`:             `Jarvis " Co`,
		`CN=Jarvis \3C Co`:            "Jarvis < Co", // hex escape
		`CN=Jarvis\, Inc., O=Jarvis`:  "Jarvis, Inc.",
		`CN=Plain Company Name, C=US`: "Plain Company Name",
	}
	for subject, want := range cases {
		got, ok := subjectCN(subject)
		if !ok {
			t.Errorf("%q: no CN found", subject)
			continue
		}
		if got != want {
			t.Errorf("subjectCN(%q) = %q, want %q", subject, got, want)
		}
	}
}
