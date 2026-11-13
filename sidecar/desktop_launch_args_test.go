package main

import "testing"

func TestLaunchArgLineKeepsOnePathWhole(t *testing.T) {
	for in, want := range map[string]string{
		`C:\Users\me\My Notes\a.txt`:       `"C:\Users\me\My Notes\a.txt"`,
		`  C:/Users/me/My Notes/a.txt `:    `"C:/Users/me/My Notes/a.txt"`,
		`\\server\share\Team Docs\plan.md`: `"\\server\share\Team Docs\plan.md"`,
		`C:\Program Files\`:                `"C:\Program Files\\"`,
		// Not one path with spaces: taken as written.
		`C:\a.txt`:                         `C:\a.txt`,
		`"C:\My Notes\a.txt"`:              `"C:\My Notes\a.txt"`,
		`C:\a b.txt C:\c.txt`:              `C:\a b.txt C:\c.txt`,
		`C:\My Notes\a.txt /p`:             `C:\My Notes\a.txt /p`,
		`C:\My Notes\a.txt -n 12`:          `C:\My Notes\a.txt -n 12`,
		`-applaunch 730`:                   `-applaunch 730`,
		`my notes.txt`:                     `my notes.txt`,
		`--new-window https://example.com`: `--new-window https://example.com`,
	} {
		got, err := launchArgLine(map[string]any{"args": in})
		if err != nil || got != want {
			t.Errorf("launchArgLine(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestLaunchArgLineKeepsEachItemOfAListWhole(t *testing.T) {
	got, err := launchArgLine(map[string]any{"args": []any{"-n", `C:\My Notes\a.txt`, `"already quoted"`, "plain"}})
	want := `-n "C:\My Notes\a.txt" "already quoted" plain`
	if err != nil || got != want {
		t.Errorf("got %q, %v; want %q", got, err, want)
	}
	if got, err := launchArgLine(map[string]any{}); err != nil || got != "" {
		t.Errorf("no arguments: got %q, %v", got, err)
	}
	if _, err := launchArgLine(map[string]any{"args": []any{1}}); err == nil {
		t.Error("an argument that is not text must be refused")
	}
	if _, err := launchArgLine(map[string]any{"args": 3}); err == nil {
		t.Error("arguments that are neither a line nor a list must be refused")
	}
}
