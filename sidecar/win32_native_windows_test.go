//go:build windows

package main

import (
	"strings"
	"testing"
)

// UIA answers S_OK with a null pattern when a control simply does not
// implement one, and uiaElementGetPattern funnels that through hresultText
// with hr = 0. Rendering it as a raw zero HRESULT plus "retry once" sent the
// model back around a loop that could never succeed.
func TestHresultTextExplainsAnUnsupportedPattern(t *testing.T) {
	got := hresultText(0)
	if strings.Contains(got, "0x00000000") {
		t.Errorf("a null pattern is not an error code to show the model: %s", got)
	}
	if strings.Contains(strings.ToLower(got), "retry") {
		t.Errorf("an unsupported pattern will never start working, so do not ask for a retry: %s", got)
	}
	if !strings.Contains(got, "does not expose this pattern") {
		t.Errorf("should name the actual problem: %s", got)
	}
}

// The mapped failures each need to survive as actionable text rather than a
// bare code, and the fallback must still say what to do with an unknown one.
func TestHresultTextMapsKnownUiaFailures(t *testing.T) {
	cases := map[uintptr]string{
		0x80040201: "no longer exists",
		0x80040200: "disabled",
		0x80040202: "scroll_into_view",
		0x80070005: "elevated",
		0x80004005: "rejected the action",
	}
	for hr, want := range cases {
		if got := hresultText(hr); !strings.Contains(got, want) {
			t.Errorf("hresultText(0x%08x) = %q, want it to mention %q", uint32(hr), got, want)
		}
	}
	if got := hresultText(0x8000FFFF); !strings.Contains(got, "0x8000ffff") {
		t.Errorf("an unmapped HRESULT should still be reported verbatim: %s", got)
	}
}
