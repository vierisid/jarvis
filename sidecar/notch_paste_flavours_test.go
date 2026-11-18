package main

import "testing"

func TestOnlyCellsForASheetAreMadeSafeAndTheShapeIsOfWhatWasGiven(t *testing.T) {
	rows := [][]string{{"Name", "=HYPERLINK(\"https://evil.example\")"}, {"Sam", "-12.5"}}
	plain, html, shape := pasteFlavours(notchAct{Rows: rows, As: "cells"})
	if plain != "Name\t'=HYPERLINK(\"https://evil.example\")\r\nSam\t-12.5" {
		t.Errorf("the words for a sheet: %q", plain)
	}
	if !contains(html, "&#39;=HYPERLINK") && !contains(html, "'=HYPERLINK") {
		t.Errorf("the table for a sheet carries the formula as it was: %q", html)
	}
	// The shape a paste is known by is of the rows as they were given: it is what an undo compares with.
	if shape != pasteTSV(rows) {
		t.Errorf("the shape changed: %q", shape)
	}
	// As a table in a document, or as text, nothing is worked out, and nothing is changed.
	for _, as := range []string{"table", "text", "list"} {
		plain, _, _ := pasteFlavours(notchAct{Rows: rows, As: as})
		if contains(plain, "'=HYPERLINK") {
			t.Errorf("as %s the cell was changed: %q", as, plain)
		}
	}
}

func contains(s, part string) bool {
	for i := 0; i+len(part) <= len(s); i++ {
		if s[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
