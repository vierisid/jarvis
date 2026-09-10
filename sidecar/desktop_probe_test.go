package main

import "testing"

func TestFirstLineKeepsOnlyTheLeadingLine(t *testing.T) {
	cases := map[string]string{
		"":                             "",
		"single":                       "single",
		"Error: Can't open display\n":  "Error: Can't open display",
		"first\nsecond\nthird":         "first",
		"  padded first  \n  second  ": "padded first",
	}
	for in, want := range cases {
		if got := firstLine(in); got != want {
			t.Errorf("firstLine(%q) = %q, want %q", in, got, want)
		}
	}
}

// launch_app documents its parameter as "executable path or name", and the
// packaged-app fallback compares it against windowInfo.ProcessName, which is
// always the bare stem. Without reducing the argument to that same shape the
// fallback silently never fires for the path form - which is exactly the
// form used for anything outside System32.
func TestProcessBaseNameOfReducesPathsToProcessNames(t *testing.T) {
	cases := map[string]string{
		"notepad.exe":                     "notepad",
		"Notepad.EXE":                     "notepad",
		`C:\Windows\System32\notepad.exe`: "notepad",
		`C:/Program Files/App/App.exe`:    "app",
		`  C:\Windows\notepad.exe  `:      "notepad",
		"calc":                            "calc",
		`\\server\share\tool.exe`:         "tool",
		"":                                "",
	}
	for in, want := range cases {
		if got := processBaseNameOf(in); got != want {
			t.Errorf("processBaseNameOf(%q) = %q, want %q", in, got, want)
		}
	}
}
