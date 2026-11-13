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

func TestStartMenuLookupLeavesOutUninstallersAndNamesWhatItFound(t *testing.T) {
	find := startMenuFindScript("steam")
	if !strings.Contains(find, `\buninstall`) {
		t.Errorf("an uninstaller must not be an app to open:\n%s", find)
	}
	if !strings.Contains(find, "names = $names") {
		t.Errorf("the lookup must say what it found, for when it is more than one:\n%s", find)
	}
}

func TestPickStartMenuWindow(t *testing.T) {
	before := map[uintptr]bool{1: true, 2: true}
	wins := []startMenuWin{
		{Hwnd: 1, Title: "Inbox - Outlook", ProcessName: "olk.exe"},
		{Hwnd: 2, Title: "Program Manager", ProcessName: "explorer.exe"},
		{Hwnd: 3, Title: "Calculator", ProcessName: "ApplicationFrameHost.exe"},
		{Hwnd: 4, Title: "Steam", ProcessName: "steamwebhelper.exe"},
		{Hwnd: 5, Title: "Welcome", ProcessName: "Code.exe"},
	}
	// A packaged app: the window is a host program's, the title is the app's.
	if i, how, _ := pickStartMenuWindow(wins, "Calculator", "calculator", before); i != 2 || how != "title" {
		t.Errorf("Calculator: got %d by %q, want window 3 by title", i, how)
	}
	// A classic app whose window is drawn by a helper: found by its title.
	if i, how, _ := pickStartMenuWindow(wins, "Steam", "Steam.exe", before); i != 3 || how != "title" {
		t.Errorf("Steam: got %d by %q", i, how)
	}
	// By its program, when the title says nothing.
	if i, how, _ := pickStartMenuWindow(wins, "Visual Studio Code", "Code.exe", before); i != 4 || how != "process_name" {
		t.Errorf("VS Code: got %d by %q", i, how)
	}
	// Already open: nothing new, but its own window was there.
	if i, _, already := pickStartMenuWindow(wins, "Outlook", "olk.exe", before); i != -1 || already != 0 {
		t.Errorf("Outlook already open: got opened %d already %d", i, already)
	}
	// Not there at all.
	if i, _, already := pickStartMenuWindow(wins, "Paint", "mspaint.exe", before); i != -1 || already != -1 {
		t.Errorf("Paint not open: got opened %d already %d", i, already)
	}
}
