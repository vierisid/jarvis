package main

// Opening an app the way a person does: by the name the Start menu shows.
//
// launch_app starts what it is given with Start-Process, which finds a
// program by name only if it is on PATH or registered under "App Paths".
// Notepad is. Steam, Spotify, and most things a person installs are not:
// they are in the Start menu, and that is where a person opens them from.
// "Open Steam" therefore failed by name on the first machine it was tried on,
// while "open Notepad" worked.
//
// So when a bare name cannot be started, it is looked up in the Start menu's
// own list (Get-StartApps) and started as the Start menu starts it. Only for
// a bare name with no arguments, and only when exactly one app answers to it:
// "an app the person named", never a guess between two, never a web link the
// Start menu happens to list.
//
// This file is the part with no Windows in it: what to look for and the two
// scripts. desktop_windows.go runs them.

import (
	"regexp"
	"strings"
)

// A name a person calls an app by: no path, no address, nothing a shell reads.
var startMenuName = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} ._+-]{0,79}$`)

// startMenuWanted says what to look for in the Start menu for a launch that
// failed, or false when this launch is not a plain app by its name.
func startMenuWanted(executable, args string) (string, bool) {
	if strings.TrimSpace(args) != "" {
		return "", false
	}
	name := strings.TrimSpace(executable)
	if !startMenuName.MatchString(name) {
		return "", false
	}
	if len(name) > 4 && strings.EqualFold(name[len(name)-4:], ".exe") {
		name = strings.TrimSpace(name[:len(name)-4])
	}
	if name == "" {
		return "", false
	}
	return name, true
}

// startMenuFindScript looks the name up: the app with exactly that name, or
// failing that the apps whose name contains it. It answers one JSON object,
// {id, name, count}; id is empty unless exactly one app was found. Entries
// that are web links are not apps and are left out, and so is anything the
// Start menu lists to uninstall something. `names` holds up to five of what
// was found, so that "more than one" can be said with their names.
func startMenuFindScript(name string) string {
	return `
$ErrorActionPreference = 'Stop'
$want = ` + psSingleQuoted(name) + `
$apps = @(Get-StartApps | Where-Object { $_.AppID -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://' -and $_.Name -notmatch '(?i)\buninstall' })
$hit = @($apps | Where-Object { $_.Name -eq $want })
if ($hit.Count -eq 0) {
  $like = '*' + [System.Management.Automation.WildcardPattern]::Escape($want) + '*'
  $hit = @($apps | Where-Object { $_.Name -like $like })
}
$names = @($hit | Select-Object -First 5 | ForEach-Object { [string]$_.Name })
if ($hit.Count -eq 1) { @{ id = [string]$hit[0].AppID; name = [string]$hit[0].Name; count = 1; names = $names } | ConvertTo-Json -Compress }
else { @{ id = ''; name = ''; count = $hit.Count; names = $names } | ConvertTo-Json -Compress }
`
}

// startMenuLaunchScript starts an app by its Start menu id, as a click on its
// tile does.
func startMenuLaunchScript(appID string) string {
	return `
$ErrorActionPreference = 'Stop'
Start-Process -FilePath ('shell:AppsFolder\' + ` + psSingleQuoted(appID) + `)
'started'
`
}

// startMenuWin is a window as the picker needs it.
type startMenuWin struct {
	Hwnd        uintptr
	Title       string
	ProcessName string
}

func startMenuFold(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.TrimSuffix(s, ".exe")
}

// startMenuMatches says whether a window is the app's: its program is the one
// the Start menu entry names, or its title carries the app's name ("Untitled
// - Paint", "Calculator", "Settings"). A packaged app's window belongs to a
// host program with another name, so the title is often all there is.
func startMenuMatches(w startMenuWin, appName, hint string) string {
	if h := startMenuFold(hint); h != "" && startMenuFold(w.ProcessName) == h {
		return "process_name"
	}
	if n := strings.ToLower(strings.TrimSpace(appName)); n != "" && strings.Contains(strings.ToLower(w.Title), n) {
		return "title"
	}
	return ""
}

// pickStartMenuWindow chooses, from the windows on screen, the one a Start
// menu launch produced: a window that was not there before and is the app's.
// With none, `already` is a window that was there before and is the app's:
// the app was open, and starting it again showed nothing new. -1 for neither.
func pickStartMenuWindow(wins []startMenuWin, appName, hint string, preexisting map[uintptr]bool) (opened int, how string, already int) {
	opened, already = -1, -1
	for i, w := range wins {
		match := startMenuMatches(w, appName, hint)
		if match == "" {
			continue
		}
		if !preexisting[w.Hwnd] {
			return i, match, already
		}
		if already < 0 {
			already = i
		}
	}
	return opened, "", already
}

// startMenuWindowHint is the program whose window to wait for. A classic
// app's id ends in its program's file name ({folder id}\Steam\Steam.exe); a
// packaged app's does not, and the name that was asked for is the best there is.
func startMenuWindowHint(appID, executable string) string {
	if i := strings.LastIndexAny(appID, `\/`); i >= 0 && strings.HasSuffix(strings.ToLower(appID), ".exe") {
		return appID[i+1:]
	}
	return executable
}
