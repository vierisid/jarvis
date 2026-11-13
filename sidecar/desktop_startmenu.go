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
// that are web links are not apps and are left out.
func startMenuFindScript(name string) string {
	return `
$ErrorActionPreference = 'Stop'
$want = ` + psSingleQuoted(name) + `
$apps = @(Get-StartApps | Where-Object { $_.AppID -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://' })
$hit = @($apps | Where-Object { $_.Name -eq $want })
if ($hit.Count -eq 0) {
  $like = '*' + [System.Management.Automation.WildcardPattern]::Escape($want) + '*'
  $hit = @($apps | Where-Object { $_.Name -like $like })
}
if ($hit.Count -eq 1) { @{ id = [string]$hit[0].AppID; name = [string]$hit[0].Name; count = 1 } | ConvertTo-Json -Compress }
else { @{ id = ''; name = ''; count = $hit.Count } | ConvertTo-Json -Compress }
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

// startMenuWindowHint is the program whose window to wait for. A classic
// app's id ends in its program's file name ({folder id}\Steam\Steam.exe); a
// packaged app's does not, and the name that was asked for is the best there is.
func startMenuWindowHint(appID, executable string) string {
	if i := strings.LastIndexAny(appID, `\/`); i >= 0 && strings.HasSuffix(strings.ToLower(appID), ".exe") {
		return appID[i+1:]
	}
	return executable
}
