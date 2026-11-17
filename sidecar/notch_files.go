package main

// Looking around this computer's files.
//
// The owner, 17 November 2026, about day one: "it's good that he checks the
// mail, but he should actually go through kind of the files that he can see
// in the desktop. I think that would be a massive selling point."
//
// notch.files tells the brain what lies on the person's desktop, and in
// their documents and downloads: how many files and folders, of what kinds,
// and the names of the few that were changed last. That is what anyone
// looking at the desktop sees.
//
// What it never does: open a file. Nothing of what is in one is read here,
// not a line and not a first page. A name, a kind told from the ending of the
// name, and a date are all that leave this function. It looks at the top of
// each folder and does not go down into the folders it finds.
//
// It is only there on a desktop app that may read files at all, and a folder
// the person has blocked is not looked into.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// How many entries of one folder are looked at. A desktop with more than
	// this is counted as far as this, and says so.
	notchFilesMost = 2000
	// How many of the newest are named, for each place.
	notchFilesNamed = 6
	// The longest name that is told. A longer one is cut.
	notchFileNameMost = 120
)

// notchFileSeen is one file or folder, as it is told: never more than this.
type notchFileSeen struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Changed int64  `json:"changed"`
}

// notchFilePlace is one of the places looked in.
type notchFilePlace struct {
	// "desktop", "documents" or "downloads".
	Place string `json:"place"`
	// Whether the folder was there and could be listed.
	Reached bool `json:"reached"`
	Files   int  `json:"files"`
	Folders int  `json:"folders"`
	// Shortcuts to programs and links: counted, and not named with the files.
	Shortcuts int `json:"shortcuts"`
	// How many files of each kind.
	Kinds map[string]int `json:"kinds"`
	// The newest first.
	Recent []notchFileSeen `json:"recent"`
	// There was more in the folder than was looked at.
	More bool `json:"more"`
}

var notchFileKinds = map[string]string{
	".doc": "document", ".docx": "document", ".odt": "document", ".rtf": "document", ".txt": "document", ".md": "document", ".pages": "document",
	".xls": "sheet", ".xlsx": "sheet", ".csv": "sheet", ".ods": "sheet", ".numbers": "sheet", ".tsv": "sheet",
	".ppt": "slides", ".pptx": "slides", ".key": "slides", ".odp": "slides",
	".pdf": "pdf",
	".png": "picture", ".jpg": "picture", ".jpeg": "picture", ".gif": "picture", ".webp": "picture", ".heic": "picture", ".svg": "picture", ".bmp": "picture", ".tiff": "picture", ".psd": "picture", ".fig": "picture",
	".mp4": "video", ".mov": "video", ".mkv": "video", ".avi": "video", ".webm": "video",
	".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".flac": "audio", ".ogg": "audio",
	".zip": "archive", ".rar": "archive", ".7z": "archive", ".tar": "archive", ".gz": "archive", ".dmg": "archive", ".iso": "archive",
	".js": "code", ".ts": "code", ".py": "code", ".go": "code", ".json": "code", ".html": "code", ".css": "code", ".sh": "code", ".sql": "code", ".yaml": "code", ".yml": "code", ".ipynb": "code",
	".lnk": "shortcut", ".url": "shortcut", ".webloc": "shortcut", ".desktop": "shortcut", ".app": "shortcut", ".exe": "shortcut",
}

// notchFileKind tells a kind from a name alone.
func notchFileKind(name string, dir bool) string {
	ext := strings.ToLower(filepath.Ext(name))
	// A program on a Mac is a folder whose name ends in ".app".
	if dir && ext != ".app" {
		return "folder"
	}
	if kind, ok := notchFileKinds[ext]; ok {
		return kind
	}
	return "other"
}

// notchFileHidden: what nobody sees on their desktop. Files the system keeps
// there for itself, and the half-written copies programs leave while a file
// is open.
func notchFileHidden(name string) bool {
	lower := strings.ToLower(name)
	return name == "" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "~$") || strings.HasPrefix(name, "$") ||
		lower == "desktop.ini" || lower == "thumbs.db" || strings.HasSuffix(lower, ".tmp") || strings.HasSuffix(lower, ".crdownload") || strings.HasSuffix(lower, ".part")
}

func notchFileName(name string) string {
	// One line, and not longer than a line can be.
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, name)
	runes := []rune(strings.TrimSpace(clean))
	if len(runes) > notchFileNameMost {
		runes = runes[:notchFileNameMost]
	}
	return string(runes)
}

// notchFilesIn looks at the top of one folder. The folder not being there is
// not an error: the place is simply not reached.
func notchFilesIn(place, dir string) notchFilePlace {
	out := notchFilePlace{Place: place, Kinds: map[string]int{}, Recent: []notchFileSeen{}}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	out.Reached = true
	seen := make([]notchFileSeen, 0, 64)
	looked := 0
	for _, entry := range entries {
		name := entry.Name()
		if notchFileHidden(name) {
			continue
		}
		if looked >= notchFilesMost {
			out.More = true
			break
		}
		looked++
		kind := notchFileKind(name, entry.IsDir())
		switch kind {
		case "folder":
			out.Folders++
		case "shortcut":
			out.Shortcuts++
			continue
		default:
			out.Files++
			out.Kinds[kind]++
		}
		changed := int64(0)
		if info, err := entry.Info(); err == nil {
			changed = info.ModTime().UnixMilli()
		}
		seen = append(seen, notchFileSeen{Name: notchFileName(name), Kind: kind, Changed: changed})
	}
	sort.SliceStable(seen, func(i, j int) bool { return seen[i].Changed > seen[j].Changed })
	if len(seen) > notchFilesNamed {
		seen = seen[:notchFilesNamed]
	}
	out.Recent = seen
	return out
}

// notchFileRoots is where each place may be on this machine, the likeliest
// first. A desktop that a cloud drive has taken over lives in that drive's
// folder, and the one in the home folder is then empty or gone.
func notchFileRoots(home string, env func(string) string, goos string) map[string][]string {
	roots := map[string][]string{}
	names := map[string]string{"desktop": "Desktop", "documents": "Documents", "downloads": "Downloads"}
	for place, name := range names {
		var dirs []string
		if goos == "windows" {
			for _, key := range []string{"OneDrive", "OneDriveConsumer", "OneDriveCommercial"} {
				if drive := env(key); drive != "" && place != "downloads" {
					dirs = append(dirs, filepath.Join(drive, name))
				}
			}
		}
		if home != "" {
			dirs = append(dirs, filepath.Join(home, name))
		}
		roots[place] = dirs
	}
	return roots
}

// notchFilesLook looks in each place: the first of its folders that is there,
// is not blocked, and holds anything. Blocked is asked for each folder.
func notchFilesLook(roots map[string][]string, blocked func(dir string) bool) []notchFilePlace {
	out := make([]notchFilePlace, 0, 3)
	for _, place := range []string{"desktop", "documents", "downloads"} {
		best := notchFilePlace{Place: place, Kinds: map[string]int{}, Recent: []notchFileSeen{}}
		for _, dir := range roots[place] {
			if blocked != nil && blocked(dir) {
				continue
			}
			got := notchFilesIn(place, dir)
			if !got.Reached {
				continue
			}
			// The one that holds something is the one the person uses.
			if !best.Reached || got.Files+got.Folders > best.Files+best.Folders {
				best = got
			}
			if best.Files+best.Folders > 0 {
				break
			}
		}
		out = append(out, best)
	}
	return out
}

// makeNotchFilesHandler serves notch.files. It takes nothing: where to look
// is this machine's own to know, and the brain cannot name a folder.
func makeNotchFilesHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		home, _ := os.UserHomeDir()
		started := time.Now()
		places := notchFilesLook(notchFileRoots(home, os.Getenv, goosName()), func(dir string) bool {
			return isBlockedPath(dir, cfg.Filesystem.BlockedPaths)
		})
		// Counts, never a name.
		total := 0
		for _, place := range places {
			total += place.Files + place.Folders
		}
		logNotchFiles(len(places), total, time.Since(started))
		return &RPCResult{Result: map[string]any{"places": places}}, nil
	}
}
