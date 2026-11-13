package main

import "testing"

// Nothing is on this machine: the line is read.
func nothingThere(string) bool { return false }

func TestLaunchArgLineKeepsOnePathWhole(t *testing.T) {
	for in, want := range map[string]string{
		`C:\Users\me\My Notes\a.txt`:       `"C:\Users\me\My Notes\a.txt"`,
		`  C:/Users/me/My Notes/a.txt `:    `"C:/Users/me/My Notes/a.txt"`,
		`\\server\share\Team Docs\plan.md`: `"\\server\share\Team Docs\plan.md"`,
		`C:\Program Files\`:                `"C:\Program Files\\"`,
		`C:\Program Files\\`:               `"C:\Program Files\\\\"`,
		// A dash with a space after it is part of a name, not a switch.
		`C:\Music\Artist - Title.mp3`: `"C:\Music\Artist - Title.mp3"`,
		// Not one path with spaces: taken as written.
		`C:\a.txt`:                `C:\a.txt`,
		`"C:\My Notes\a.txt"`:     `"C:\My Notes\a.txt"`,
		`C:\a b.txt C:\c.txt`:     `C:\a b.txt C:\c.txt`,
		`C:\My Notes\a.txt /p`:    `C:\My Notes\a.txt /p`,
		`C:\My Notes\a.txt -n 12`: `C:\My Notes\a.txt -n 12`,
		// Two files, the second not rooted: still two.
		`C:\data\in.txt out.txt`:           `C:\data\in.txt out.txt`,
		`-applaunch 730`:                   `-applaunch 730`,
		`my notes.txt`:                     `my notes.txt`,
		`--new-window https://example.com`: `--new-window https://example.com`,
	} {
		got, err := launchArgLine(map[string]any{"args": in}, nothingThere)
		if err != nil || got != want {
			t.Errorf("launchArgLine(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestLaunchArgLineBelievesWhatIsThere(t *testing.T) {
	// A folder whose name looks like a file ending followed by more, and a
	// file whose name has a switch in it: they exist, so each is one path.
	there := map[string]bool{`C:\Work\v1.2 final\notes.txt`: true, `C:\Work\plan -old.txt`: true}
	exists := func(path string) bool { return there[path] }
	for in, want := range map[string]string{
		`C:\Work\v1.2 final\notes.txt`: `"C:\Work\v1.2 final\notes.txt"`,
		`C:\Work\plan -old.txt`:        `"C:\Work\plan -old.txt"`,
		// Not there: read as before.
		`C:\Work\v1.3 final\notes.txt`: `C:\Work\v1.3 final\notes.txt`,
	} {
		if got, err := launchArgLine(map[string]any{"args": in}, exists); err != nil || got != want {
			t.Errorf("launchArgLine(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	// Never asked about a line that is not a rooted path with a space, or is quoted already.
	asked := 0
	count := func(string) bool { asked++; return true }
	for _, in := range []string{`-applaunch 730`, `C:\a.txt`, `"C:\My Notes\a.txt"`, `my notes.txt`} {
		if _, err := launchArgLine(map[string]any{"args": in}, count); err != nil {
			t.Fatal(err)
		}
	}
	if asked != 0 {
		t.Errorf("the machine was asked %d times about lines that are not one rooted path", asked)
	}
}

func TestLaunchArgLineKeepsEachItemOfAListWhole(t *testing.T) {
	got, err := launchArgLine(map[string]any{"args": []any{"-n", `C:\My Notes\a.txt`, `"already quoted"`, "plain"}}, nothingThere)
	want := `-n "C:\My Notes\a.txt" "already quoted" plain`
	if err != nil || got != want {
		t.Errorf("got %q, %v; want %q", got, err, want)
	}
	if got, err := launchArgLine(map[string]any{}, nothingThere); err != nil || got != "" {
		t.Errorf("no arguments: got %q, %v", got, err)
	}
	if _, err := launchArgLine(map[string]any{"args": []any{1}}, nothingThere); err == nil {
		t.Error("an argument that is not text must be refused")
	}
	if _, err := launchArgLine(map[string]any{"args": 3}, nothingThere); err == nil {
		t.Error("arguments that are neither a line nor a list must be refused")
	}
}
