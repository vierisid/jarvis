package main

import (
	"encoding/base64"
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

func TestStartMenuScripts(t *testing.T) {
	list := startMenuListScript()
	if !strings.Contains(list, "://") || !strings.Contains(list, `\buninstall`) {
		t.Errorf("the list must leave out web links and uninstallers:\n%s", list)
	}
	if !strings.Contains(list, "ToBase64String") {
		t.Errorf("the list must arrive whatever the console's code page is:\n%s", list)
	}
	launch := startMenuLaunchScript(`{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\Steam\Steam.exe`)
	if !strings.Contains(launch, `'shell:AppsFolder\' + '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\Steam\Steam.exe'`) {
		t.Errorf("the launch script:\n%s", launch)
	}
	if quoted := startMenuLaunchScript("it's"); !strings.Contains(quoted, "'it''s'") {
		t.Errorf("the id was not quoted for PowerShell:\n%s", quoted)
	}
}

func TestStartMenuAppsReadsTheList(t *testing.T) {
	encode := func(text string) string { return base64.StdEncoding.EncodeToString([]byte(text)) }
	apps, err := startMenuApps(encode(`[{"name":"HWiNFO\u00ae 64","id":"a"},{"name":"Caff\u00e8","id":"b"}]`) + "\r\n")
	if err != nil || len(apps) != 2 || apps[0].Name != "HWiNFO\u00ae 64" || apps[1].ID != "b" {
		t.Errorf("got %v, %v", apps, err)
	}
	// One app alone can arrive as an object; none at all as nothing.
	if apps, err := startMenuApps(encode(`{"name":"Steam","id":"s"}`)); err != nil || len(apps) != 1 || apps[0].Name != "Steam" {
		t.Errorf("one app: got %v, %v", apps, err)
	}
	for _, empty := range []string{"", encode(""), encode("null"), encode("[]")} {
		if apps, err := startMenuApps(empty); err != nil || len(apps) != 0 {
			t.Errorf("empty list %q: got %v, %v", empty, apps, err)
		}
	}
	if _, err := startMenuApps("not base64 !"); err == nil {
		t.Error("an answer that cannot be read must be an error")
	}
}

func TestStartMenuPick(t *testing.T) {
	var apps []startMenuApp
	for _, name := range []string{
		"Steam", "Visual Studio Code", "Google Chrome", "Chromium Web Browser (Ubuntu)", "Microsoft Edge", "Microsoft Teams",
		"Windows PowerShell", "Windows PowerShell (x86)", "Windows PowerShell ISE 5.1", "Windows Security", "Windows Tools",
		"Control Panel", "NVIDIA Control Panel", "Docker Desktop", "HWiNFO Manual", "HWiNFO\u00ae 64", "Media Player",
		"Windows Media Player Legacy", "File Explorer", "Notepad", "Notepad",
	} {
		apps = append(apps, startMenuApp{Name: name, ID: "id:" + name})
	}
	for said, want := range map[string]string{
		"steam":         "Steam",              // exactly, whatever the capitals
		"control panel": "Control Panel",      // exactly, though another name contains it
		"media player":  "Media Player",       // the same
		"chrome":        "Google Chrome",      // contained in one name only
		"edge":          "Microsoft Edge",     //
		"docker":        "Docker Desktop",     //
		"explorer":      "File Explorer",      //
		"powershell":    "Windows PowerShell", // contained in three: the closest name
		"vs code":       "Visual Studio Code", // said short
		"vscode":        "Visual Studio Code", //
		"VSC":           "Visual Studio Code", //
		"ms teams":      "Microsoft Teams",    // the maker's name said short
		"ms edge":       "Microsoft Edge",     //
		"notepad":       "Notepad",            // installed twice: either is it
	} {
		hit, _, count := startMenuPick(said, apps)
		if hit == nil || hit.Name != want || count != 1 {
			t.Errorf("startMenuPick(%q) = %v (%d found); want %q", said, hit, count, want)
		}
	}
	// Two that are equally close are not guessed between, and are named.
	hit, names, count := startMenuPick("hwinfo", apps)
	if hit != nil || count != 2 || len(names) != 2 {
		t.Errorf("hwinfo: got %v, %v, %d; want no pick and both names", hit, names, count)
	}
	if hit, _, count := startMenuPick("windows", apps); hit != nil || count < 2 {
		t.Errorf("windows: got %v, %d; want no pick", hit, count)
	}
	// Nothing answers to it.
	for _, said := range []string{"spotify", "", "  ", "code visual", "xz"} {
		if hit, _, count := startMenuPick(said, apps); hit != nil || count != 0 {
			t.Errorf("startMenuPick(%q) = %v, %d; want nothing", said, hit, count)
		}
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
