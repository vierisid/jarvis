package main

import (
	"strings"
	"testing"
)

// The publisher-pin script embeds the staged exe path in a single-quoted
// PowerShell literal. PowerShell ends that literal on U+2018..U+201B as well as
// on ASCII ', so doubling only the ASCII quote let a path such as
// C:\Users\O’Brien\... close the literal early (#524).
func TestSignerSubjectScriptQuotesEveryDelimiter(t *testing.T) {
	const prefix = "(Get-AuthenticodeSignature -FilePath '"
	const suffix = "').SignerCertificate.Subject"
	cases := map[string]string{
		`C:\Users\bob\AppData\Local\jarvis.exe`:     `C:\Users\bob\AppData\Local\jarvis.exe`,
		`C:\Users\o'brien\jarvis.exe`:               `C:\Users\o''brien\jarvis.exe`,
		"C:\\Users\\o\u2019brien\\jarvis.exe":       "C:\\Users\\o\u2019\u2019brien\\jarvis.exe",
		"C:\\a\u2018b\u201ac\u201bd\\jarvis.exe":    "C:\\a\u2018\u2018b\u201a\u201ac\u201b\u201bd\\jarvis.exe",
		"C:\\x\u2019; Start-Process calc; '\\j.exe": "C:\\x\u2019\u2019; Start-Process calc; ''\\j.exe",
		"C:\\$env:TEMP\\`n\\jarvis.exe":             "C:\\$env:TEMP\\`n\\jarvis.exe", // inert in single quotes
	}
	for path, wantInner := range cases {
		got := signerSubjectScript(path)
		want := prefix + wantInner + suffix
		if got != want {
			t.Errorf("signerSubjectScript(%q)\n got  %q\n want %q", path, got, want)
		}
		// Well-formed: inside the literal, every quote character is paired.
		inner := strings.TrimSuffix(strings.TrimPrefix(got, prefix), suffix)
		for _, q := range []string{"'", "\u2018", "\u2019", "\u201a", "\u201b"} {
			if strings.Count(inner, q)%2 != 0 {
				t.Errorf("unpaired %q in %q", q, inner)
			}
		}
	}
}
