package main

import (
	"strings"
	"testing"
)

func TestStartMenuWantedIsABareNameWithNoArguments(t *testing.T) {
	for in, want := range map[string]string{"steam": "steam", "Steam.exe": "Steam", "  spotify ": "spotify", "Google Chrome": "Google Chrome", "notepad++": "notepad++"} {
		if got, ok := startMenuWanted(in, ""); !ok || got != want {
			t.Errorf("startMenuWanted(%q) = %q, %v; want %q, true", in, got, ok, want)
		}
	}
	for _, in := range []string{`C:\Program Files\Steam\steam.exe`, "steam://run/730", "https://example.com", "steam & del x", "a|b", "$(steam)", "", "   ", ".exe", "'steam'"} {
		if got, ok := startMenuWanted(in, ""); ok {
			t.Errorf("startMenuWanted(%q) = %q, true; want it refused", in, got)
		}
	}
	if _, ok := startMenuWanted("steam", "-applaunch 730"); ok {
		t.Error("a launch with arguments is not a plain app by its name")
	}
}

func TestStartMenuScriptsQuoteWhatTheyAreGiven(t *testing.T) {
	find := startMenuFindScript("it's")
	if !strings.Contains(find, "$want = 'it''s'") {
		t.Errorf("the name was not quoted for PowerShell:\n%s", find)
	}
	if !strings.Contains(find, "://") || !strings.Contains(find, "WildcardPattern]::Escape") {
		t.Errorf("the lookup must leave out web links and escape wildcards:\n%s", find)
	}
	launch := startMenuLaunchScript(`{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\Steam\Steam.exe`)
	if !strings.Contains(launch, `'shell:AppsFolder\' + '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\Steam\Steam.exe'`) {
		t.Errorf("the launch script:\n%s", launch)
	}
}

func TestStartMenuWindowHint(t *testing.T) {
	if got := startMenuWindowHint(`{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\Steam\Steam.exe`, "steam"); got != "Steam.exe" {
		t.Errorf("a classic app's hint = %q, want its program's name", got)
	}
	if got := startMenuWindowHint("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", "notepad"); got != "notepad" {
		t.Errorf("a packaged app's hint = %q, want the name that was asked for", got)
	}
}
