package main

import (
	"regexp"
	"strings"
	"unicode"
)

// Cells that go into a sheet are words and numbers, never a formula.
//
// What is pasted "as cells" was read off a screen: a web page, a mail, a
// file. A sheet works out a cell that begins with "=", "+", "-" or "@", and
// "=IMPORTDATA(...)" read off a page would send what is in the sheet
// somewhere else, with nobody having typed it. So such a cell is given the
// apostrophe that makes a sheet take it as words. A number keeps its sign.

// pastePlainNumber is a cell that is a plain number: "-12.5", "+3",
// "1,200.00", "45 %". A sheet reads it as the number it is, and it stays as
// it is.
var pastePlainNumber = regexp.MustCompile(`^[+-]?[0-9][0-9 .,']*%?$`)

// pasteBlank is what can stand before the first sign of a cell without a
// sheet minding it: blanks, line ends, and the signs nobody sees. A table
// handed over as HTML loses them, so " =1+1" there is "=1+1".
func pasteBlank(r rune) bool {
	return unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
}

// pasteSafeCell is a cell as it goes into a sheet.
func pasteSafeCell(cell string) string {
	seen := strings.TrimLeftFunc(cell, pasteBlank)
	if seen == "" {
		return cell
	}
	first, _ := firstRune(seen)
	switch first {
	case '=', '@', '\uff1d', '\uff20':
		return "'" + cell
	case '+', '-', '\uff0b', '\uff0d', '\u2212':
		if pastePlainNumber.MatchString(strings.TrimRightFunc(seen, pasteBlank)) {
			return cell
		}
		return "'" + cell
	}
	return cell
}

func firstRune(text string) (rune, bool) {
	for _, r := range text {
		return r, true
	}
	return 0, false
}

func pasteSafeRows(rows [][]string) [][]string {
	out := make([][]string, len(rows))
	for i, row := range rows {
		out[i] = make([]string, len(row))
		for j, cell := range row {
			out[i][j] = pasteSafeCell(cell)
		}
	}
	return out
}
