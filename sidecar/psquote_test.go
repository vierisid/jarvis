package main

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestPsSingleQuotedDoublesEveryQuoteVariant(t *testing.T) {
	quotes := []string{"'", "\u2018", "\u2019", "\u201a", "\u201b"}
	in := "it's \u2018smart\u2019 and \u201alow\u201b"
	got := psSingleQuoted(in)
	if !strings.HasPrefix(got, "'") || !strings.HasSuffix(got, "'") {
		t.Fatalf("not wrapped in quotes: %q", got)
	}
	inner := got[1 : len(got)-1]
	for _, q := range quotes {
		if strings.Contains(inner, q) && !strings.Contains(inner, q+q) {
			t.Errorf("quote %q not doubled in %q", q, inner)
		}
		// No lone occurrence: every quote is part of a pair.
		if strings.Count(inner, q)%2 != 0 {
			t.Errorf("odd number of %q in %q", q, inner)
		}
	}
	// Nothing else is touched; $ and backticks are inert inside single quotes.
	if got := psSingleQuoted("$env:X `n"); got != "'$env:X `n'" {
		t.Errorf("unexpected escaping: %q", got)
	}
}

func TestPsUTF8Base64ExprRoundTrips(t *testing.T) {
	in := "line1\r\nit's \u2018x\u2019 日本語 ' ; Start-Process calc"
	expr := psUTF8Base64Expr(in)
	marker := "FromBase64String('"
	start := strings.Index(expr, marker)
	if start < 0 {
		t.Fatalf("unexpected expression shape: %q", expr)
	}
	start += len(marker)
	end := strings.Index(expr[start:], "'")
	if end < 0 {
		t.Fatalf("unexpected expression shape: %q", expr)
	}
	raw, err := base64.StdEncoding.DecodeString(expr[start : start+end])
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(raw) != in {
		t.Errorf("round trip = %q, want %q", raw, in)
	}
	// The only quotes in the expression are the two around the base64 literal.
	if strings.Count(expr, "'") != 2 {
		t.Errorf("payload leaked a quote into the command: %q", expr)
	}
}
