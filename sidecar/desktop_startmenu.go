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
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
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

// startMenuApp is one entry of the Start menu: the name it shows and the id it
// is started by.
type startMenuApp struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

// startMenuListScript reads the Start menu's own list. Entries that are web
// links are not apps and are left out, and so is anything the Start menu lists
// to uninstall something. The answer is JSON in base64: a name can carry a
// letter the console's code page does not have (a trademark sign, an accented
// letter), and it has to arrive as it is.
func startMenuListScript() string {
	return `
$ErrorActionPreference = 'Stop'
$apps = @(Get-StartApps | Where-Object { $_.AppID -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://' -and $_.Name -notmatch '(?i)\buninstall' })
$json = ConvertTo-Json -Compress @($apps | ForEach-Object { @{ name = [string]$_.Name; id = [string]$_.AppID } })
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$json))
`
}

// startMenuApps reads what startMenuListScript printed.
func startMenuApps(out string) ([]startMenuApp, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
	if err != nil {
		return nil, err
	}
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" {
		return nil, nil
	}
	var apps []startMenuApp
	if err := json.Unmarshal([]byte(text), &apps); err != nil {
		// One app alone can arrive as an object instead of a list of one.
		var one startMenuApp
		if json.Unmarshal([]byte(text), &one) != nil {
			return nil, err
		}
		apps = []startMenuApp{one}
	}
	return apps, nil
}

var startMenuWordBreak = regexp.MustCompile(`[^\p{L}\p{N}+#]+`)

// startMenuWords is a name as its words, in small letters.
func startMenuWords(name string) []string {
	var words []string
	for _, word := range startMenuWordBreak.Split(strings.ToLower(name), -1) {
		if word != "" {
			words = append(words, word)
		}
	}
	return words
}

// startMenuSaidShort says whether `said` (small letters, no spaces) is the
// name said short: its words in order, each either whole or as its first
// letter, from the first word on. "vscode" is Visual Studio Code. The answer is
// how many of the name's words were left unsaid at the end, or -1 for no.
func startMenuSaidShort(said string, words []string) int {
	if said == "" {
		return len(words)
	}
	if len(words) == 0 {
		return -1
	}
	word, best := words[0], -1
	keep := func(left int) {
		if left >= 0 && (best < 0 || left < best) {
			best = left
		}
	}
	if strings.HasPrefix(said, word) {
		keep(startMenuSaidShort(said[len(word):], words[1:]))
	}
	first, size := utf8.DecodeRuneInString(word)
	if got, _ := utf8.DecodeRuneInString(said); got == first {
		keep(startMenuSaidShort(said[size:], words[1:]))
	}
	return best
}

// startMenuPick chooses the app a name means. It tries three readings, and
// stops at the first that finds anything: the app with exactly that name; the
// apps whose name contains it; the apps the name is a short way of saying
// ("vs code"). Within a reading, the app whose name has the fewest words
// beyond what was said wins ("powershell" is Windows PowerShell, not its ISE);
// two that are equally close are not guessed between. `names` holds up to five
// of what was found, so that "more than one" can be said with their names.
func startMenuPick(want string, apps []startMenuApp) (hit *startMenuApp, names []string, count int) {
	want = strings.TrimSpace(want)
	if want == "" {
		return nil, nil, 0
	}
	fold := strings.ToLower(want)
	wantWords := startMenuWords(want)
	said := strings.Join(wantWords, "")

	type found struct {
		app  int
		left int // words of the name beyond what was said
	}
	readings := []func(app startMenuApp) int{
		func(app startMenuApp) int {
			if strings.EqualFold(strings.TrimSpace(app.Name), want) {
				return 0
			}
			return -1
		},
		func(app startMenuApp) int {
			if !strings.Contains(strings.ToLower(app.Name), fold) {
				return -1
			}
			if left := len(startMenuWords(app.Name)) - len(wantWords); left > 0 {
				return left
			}
			return 0
		},
		func(app startMenuApp) int {
			// Two letters at least: one letter is every app that starts with it.
			if utf8.RuneCountInString(said) < 2 {
				return -1
			}
			return startMenuSaidShort(said, startMenuWords(app.Name))
		},
	}
	for which, reading := range readings {
		var hits []found
		for i, app := range apps {
			if left := reading(app); left >= 0 {
				hits = append(hits, found{app: i, left: left})
			}
		}
		if len(hits) == 0 {
			continue
		}
		closest, alone := hits[0], true
		for _, h := range hits[1:] {
			switch {
			case h.left < closest.left:
				closest, alone = h, true
			case h.left == closest.left:
				alone = false
			}
		}
		for _, h := range hits {
			if len(names) < 5 {
				names = append(names, apps[h.app].Name)
			}
		}
		// Two entries with exactly the name that was said are the same app
		// installed twice (from the Store and by its own installer): either is
		// what was asked for, so the first is taken.
		if alone || which == 0 {
			return &apps[closest.app], names, 1
		}
		return nil, names, len(hits)
	}
	// "ms teams": a short way of saying the maker's name.
	if longer := startMenuSpelledOut(wantWords); longer != "" {
		return startMenuPick(longer, apps)
	}
	return nil, nil, 0
}

// startMenuSpelledOut writes out the short forms people say for a maker's
// name, or "" when the name has none.
func startMenuSpelledOut(words []string) string {
	short := map[string]string{"ms": "microsoft"}
	changed := false
	out := make([]string, len(words))
	for i, word := range words {
		if long, ok := short[word]; ok {
			out[i], changed = long, true
		} else {
			out[i] = word
		}
	}
	if !changed {
		return ""
	}
	return strings.Join(out, " ")
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
