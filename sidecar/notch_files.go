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
// notch.files itself opens nothing: a name, a kind told from the ending of the
// name, a size and a date are all that leave it. It looks at the top of each
// folder and does not go down into the folders it finds.
//
// Asked whether it should also open the files, the owner said the same
// evening: "Should it open file? Yes, it should." So there is notch.file,
// which hands the brain one file from the top of one of those three places,
// to be read there and said in a line. What it will not hand over:
//
//   - anything that is not at the top of the desktop, the documents or the
//     downloads. The brain names a place and a name, never a path, and a name
//     with a path in it is refused;
//   - a file whose name says it is private: passwords, keys, recovery codes,
//     a bank's papers. The prototype's own words for looking around were "I
//     skip banking and passwords". Such a file is marked in the list and is
//     never opened, whoever asks;
//   - a folder, a shortcut, a link to somewhere else, or a file larger than
//     the brain reads;
//   - anything in a folder the person has blocked.
//
// Both are only there on a desktop app that may read files at all.

import (
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

const (
	// The largest file that is handed over to be read: what the brain reads of
	// a dropped file at the most (src/notch/drop.ts).
	notchFileMost = 16 * 1024 * 1024
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
	Size    int64  `json:"size"`
	// Its name says it is private. It is listed, and never opened.
	Private bool `json:"private,omitempty"`
}

// What a name says is private. Told from the name alone: nothing is opened to
// find out. It errs towards calling a file private.
var notchFilePrivateName = regexp.MustCompile(`(?i)(pass(word|wd|phrase|code)?s?\b|\bpwd\b|secret|credential|\btokens?\b|private[ _-]?key|\bkeys?\b|recovery|seed[ _-]?phrase|\bwallet|\b2fa\b|backup[ _-]?codes?|\blogins?\b|\bbank|\biban\b|statement|payslip|salary|\btax(es)?\b|passport|\bid[ _-]?card|\bssn\b|medical|diagnos)`)

var notchFilePrivateEnding = map[string]bool{
	".pem": true, ".key": true, ".p12": true, ".pfx": true, ".kdbx": true, ".kdb": true, ".env": true, ".ppk": true, ".asc": true, ".gpg": true, ".keychain": true, ".ovpn": true, ".wallet": true,
}

// notchFileNameWords: a file's name as the words a person reads in it. An
// underscore, a number after a word and the step from a small letter to a
// capital each end a word for a reader. For the pattern above they do not: to
// it "passwords_2026.xlsx", "Taxes2025.pdf" and "PasswordsBackup.docx" are one
// long word in which no private word ends, and such files were opened. So a
// blank is put at each of those before the name is matched. A number that a
// word begins with stays with it ("2fa").
func notchFileNameWords(name string) string {
	var out strings.Builder
	var before rune
	for _, r := range name {
		switch {
		case r == '_':
			out.WriteRune(' ')
		case unicode.IsDigit(r) && unicode.IsLetter(before), unicode.IsUpper(r) && unicode.IsLower(before):
			out.WriteRune(' ')
			out.WriteRune(r)
		default:
			out.WriteRune(r)
		}
		before = r
	}
	return out.String()
}

// notchFilePrivate: whether a file is one that is never opened.
func notchFilePrivate(name string) bool {
	return notchFilePrivateEnding[strings.ToLower(filepath.Ext(name))] || notchFilePrivateName.MatchString(name) || notchFilePrivateName.MatchString(notchFileNameWords(name))
}

// notchFileNameOdd: whether a name is one of the forms under which Windows
// opens a file that is called something else. "server.pem::$DATA" is the
// file server.pem, and has no private ending to look at. "vault.kdbx." and
// "wallet.key " lose their last dot or blank on the way to the disk.
// "PASSWO~1.XLS" is the short name of "Passwords 2026.xlsx". Each of them
// walked round the rule that a private file is never opened. No file a
// person keeps on a desktop is asked for like this, so none is opened.
func notchFileNameOdd(name string) bool {
	if strings.ContainsAny(name, `:*?"<>|`) || strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return true
	}
	return notchFileShortName.MatchString(name)
}

var notchFileShortName = regexp.MustCompile(`~[0-9]`)

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
func notchFilesIn(place, dir string, blocked func(path string) bool) notchFilePlace {
	out, seen := notchFilesAll(place, dir, blocked)
	if len(seen) > notchFilesNamed {
		seen = seen[:notchFilesNamed]
	}
	if seen != nil {
		out.Recent = seen
	}
	return out
}

// notchFilesAll is the same look with every name it saw, the newest first:
// for looking a file up by its name (notch_files_peers.go). Nothing but
// notchFilesIn's few leave this program from here.
func notchFilesAll(place, dir string, blocked func(path string) bool) (notchFilePlace, []notchFileSeen) {
	out := notchFilePlace{Place: place, Kinds: map[string]int{}, Recent: []notchFileSeen{}}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out, nil
	}
	out.Reached = true
	seen := make([]notchFileSeen, 0, 64)
	looked := 0
	for _, entry := range entries {
		name := entry.Name()
		if notchFileHidden(name) {
			continue
		}
		// A file or folder that is blocked by itself is not named.
		if blocked != nil && blocked(filepath.Join(dir, name)) {
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
		changed, size := int64(0), int64(0)
		if info, err := entry.Info(); err == nil {
			changed = info.ModTime().UnixMilli()
			if kind != "folder" {
				size = info.Size()
			}
		}
		seen = append(seen, notchFileSeen{Name: notchFileName(name), Kind: kind, Changed: changed, Size: size, Private: kind != "folder" && notchFilePrivate(name)})
	}
	sort.SliceStable(seen, func(i, j int) bool { return seen[i].Changed > seen[j].Changed })
	return out, seen
}

// platformNotchKnownFolders asks the system itself where the person's
// desktop, documents and downloads are. Set where the system can be asked
// (Windows); nil elsewhere.
var platformNotchKnownFolders func() map[string]string

// notchFileHomes is every folder that may be the person's own, the surest
// first. The environment is asked last, because it can be wrong: a test build
// is started with its "home" pointed at a folder of its own, so that it does
// not touch an installed Jarvis, and the person's desktop is not in there.
// The owner's first look at his files, 17 November 2026, found nothing for
// exactly that reason. The system's own record of who is signed in is not
// changed by that, and is asked first.
func notchFileHomes(account, environment string, env func(string) string, goos string) []string {
	homes := []string{account}
	if goos == "windows" {
		if drive, path := env("HOMEDRIVE"), env("HOMEPATH"); drive != "" && path != "" {
			homes = append(homes, drive+path)
		}
	}
	homes = append(homes, environment)
	seen, out := map[string]bool{}, []string{}
	for _, home := range homes {
		key := strings.ToLower(filepath.Clean(home))
		if home == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, home)
	}
	return out
}

// notchFileRoots is where each place may be on this machine, the likeliest
// first: where the system says it is, then a cloud drive that has taken it
// over (the one in the home folder is then empty or gone), then each home.
func notchFileRoots(homes []string, env func(string) string, goos string, known map[string]string) map[string][]string {
	roots := map[string][]string{}
	names := map[string]string{"desktop": "Desktop", "documents": "Documents", "downloads": "Downloads"}
	for place, name := range names {
		var dirs []string
		if dir := known[place]; dir != "" {
			dirs = append(dirs, dir)
		}
		if goos == "windows" && place != "downloads" {
			for _, key := range []string{"OneDrive", "OneDriveConsumer", "OneDriveCommercial"} {
				if drive := env(key); drive != "" {
					dirs = append(dirs, filepath.Join(drive, name))
				}
			}
			for _, home := range homes {
				dirs = append(dirs, filepath.Join(home, "OneDrive", name))
			}
		}
		for _, home := range homes {
			dirs = append(dirs, filepath.Join(home, name))
		}
		seen, unique := map[string]bool{}, []string{}
		for _, dir := range dirs {
			key := strings.ToLower(filepath.Clean(dir))
			if !seen[key] {
				seen[key] = true
				unique = append(unique, dir)
			}
		}
		roots[place] = unique
	}
	return roots
}

// notchFileRootsHere is the roots on this machine, as it is now.
func notchFileRootsHere() map[string][]string {
	account := ""
	if who, err := user.Current(); err == nil {
		account = who.HomeDir
	}
	environment, _ := os.UserHomeDir()
	var known map[string]string
	if platformNotchKnownFolders != nil {
		known = platformNotchKnownFolders()
	}
	return notchFileRoots(notchFileHomes(account, environment, os.Getenv, goosName()), os.Getenv, goosName(), known)
}

// notchFilesPlace looks in one place: the first of its folders that is
// there, is not blocked, and holds anything. It also says which folder that
// was, so that a file is later handed over from the same one.
func notchFilesPlace(place string, dirs []string, blocked func(dir string) bool) (notchFilePlace, string) {
	best, where := notchFilePlace{Place: place, Kinds: map[string]int{}, Recent: []notchFileSeen{}}, ""
	for _, dir := range dirs {
		if blocked != nil && blocked(dir) {
			continue
		}
		got := notchFilesIn(place, dir, blocked)
		if !got.Reached {
			continue
		}
		// The one that holds something is the one the person uses.
		if !best.Reached || got.Files+got.Folders > best.Files+best.Folders {
			best, where = got, dir
		}
		if best.Files+best.Folders > 0 {
			break
		}
	}
	return best, where
}

// notchFilesLook looks in each of the three places.
func notchFilesLook(roots map[string][]string, blocked func(dir string) bool) []notchFilePlace {
	out := make([]notchFilePlace, 0, 3)
	for _, place := range []string{"desktop", "documents", "downloads"} {
		got, _ := notchFilesPlace(place, roots[place], blocked)
		out = append(out, got)
	}
	return out
}

// notchFileOpen reads one file from the top of one place, for the brain to
// say what it is. The name is a name and nothing else: it is looked for in
// the folder that the list was made from, and is never joined to anything
// the brain sent. Every refusal says why in a word the brain can show.
// notchFileAttrsElsewhere reads what Windows says of a file: whether its
// content is not on this disk (notchFileElsewhere). The three bits are
// "offline", "recall on open" and "recall on data access".
func notchFileAttrsElsewhere(attrs uint32) bool {
	return attrs&(0x00001000|0x00040000|0x00400000) != 0
}

func notchFileOpen(roots map[string][]string, blocked func(dir string) bool, place, name string) ([]byte, string, error) {
	return notchFileOpenIn(roots, blocked, place, "", name)
}

// notchFileSub reads the folder below a place that a file is said to be in:
// "" for its top, or one or two folder names with a stroke between. Each is
// a name and nothing else, and none of them is hidden or private.
func notchFileSub(sub string) ([]string, bool) {
	if sub == "" {
		return nil, true
	}
	parts := strings.Split(sub, "/")
	if len(parts) > 2 {
		return nil, false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, `\`) || len(part) > 255 || notchFileHidden(part) || notchFileNameOdd(part) || notchFilePrivate(part) {
			return nil, false
		}
	}
	return parts, true
}

// notchFileOpenIn is notchFileOpen for a file that lies in a folder below
// the place (`sub`, as notch.find names it). The folders on the way are real
// folders of that place: a link among them is not followed.
func notchFileOpenIn(roots map[string][]string, blocked func(dir string) bool, place, sub, name string) ([]byte, string, error) {
	dirs, known := roots[place]
	if !known {
		return nil, "", fmt.Errorf("that is not a place I look in")
	}
	folders, ok := notchFileSub(sub)
	if !ok {
		return nil, "", fmt.Errorf("that is not a folder I look in")
	}
	// A name, not a way to somewhere: no folder in it, and not "." or "..".
	if name == "" || name != filepath.Base(name) || strings.ContainsAny(name, `/\`) || name == "." || name == ".." || len(name) > 255 {
		return nil, "", fmt.Errorf("that is not the name of a file")
	}
	if notchFileHidden(name) {
		return nil, "", fmt.Errorf("that is not a file I list")
	}
	if notchFileNameOdd(name) {
		return nil, "", fmt.Errorf("that is not the name of a file I list")
	}
	if notchFilePrivate(name) {
		return nil, "", fmt.Errorf("private: its name says so, and it is never opened")
	}
	kind := notchFileKind(name, false)
	if kind == "shortcut" {
		return nil, "", fmt.Errorf("that is a shortcut, not a file")
	}
	_, dir := notchFilesPlace(place, dirs, blocked)
	if dir == "" {
		return nil, "", fmt.Errorf("that place is not reached")
	}
	for _, folder := range folders {
		dir = filepath.Join(dir, folder)
		if blocked != nil && blocked(dir) {
			return nil, "", fmt.Errorf("that folder is blocked")
		}
		// Not followed: a link among the folders may lead anywhere on the machine.
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() {
			return nil, "", fmt.Errorf("that folder is not there")
		}
	}
	path := filepath.Join(dir, name)
	// A file the person has blocked by itself is not handed over either: only
	// its folder used to be asked about.
	if blocked != nil && blocked(path) {
		return nil, "", fmt.Errorf("that file is blocked")
	}
	// Not followed: a link on the desktop may point anywhere on the machine.
	info, err := os.Lstat(path)
	if err != nil {
		return nil, "", fmt.Errorf("it is no longer there")
	}
	if !info.Mode().IsRegular() {
		return nil, "", fmt.Errorf("that is not a plain file")
	}
	if info.Size() == 0 {
		return nil, "", fmt.Errorf("it is empty")
	}
	if info.Size() > notchFileMost {
		return nil, "", fmt.Errorf("it is too large to read")
	}
	// A file that is kept online only is not fetched to be read.
	if notchFileElsewhere(info) {
		return nil, "", fmt.Errorf("it is kept online and is not on this computer")
	}
	// Read to the limit and no further: a file that grows between the look at
	// its size and the reading is not read to its new end.
	file, err := os.Open(path)
	if err != nil {
		return nil, "", fmt.Errorf("it could not be read")
	}
	defer file.Close()
	bytes, err := io.ReadAll(io.LimitReader(file, notchFileMost+1))
	if err != nil {
		return nil, "", fmt.Errorf("it could not be read")
	}
	if len(bytes) > notchFileMost {
		return nil, "", fmt.Errorf("it is too large to read")
	}
	return bytes, kind, nil
}

// makeNotchFilesHandler serves notch.files. It takes nothing: where to look
// is this machine's own to know, and the brain cannot name a folder.
func makeNotchFilesHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		started := time.Now()
		// Made for this look: the blocked list is read once, not once for every file (blockedPathCheck).
		places := notchFilesLook(notchFileRootsHere(), blockedPathCheck(cfg.Filesystem.BlockedPaths))
		// Counts, never a name.
		total := 0
		for _, place := range places {
			total += place.Files + place.Folders
		}
		logNotchFiles(len(places), total, time.Since(started))
		return &RPCResult{Result: map[string]any{"places": places}}, nil
	}
}

// makeNotchFileHandler serves notch.file: {place, name} gives one file's
// bytes, or the reason it is not handed over.
func makeNotchFileHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		place, _ := params["place"].(string)
		name, _ := params["name"].(string)
		// A folder below the place, for a file that was found there (notch.find).
		sub, _ := params["dir"].(string)
		bytes, kind, err := notchFileOpenIn(notchFileRootsHere(), blockedPathCheck(cfg.Filesystem.BlockedPaths), place, sub, name)
		if err != nil {
			// Why, never which.
			logNotchFile(place, "", 0, err.Error())
			return &RPCResult{Result: map[string]any{"opened": false, "why": err.Error()}}, nil
		}
		logNotchFile(place, kind, len(bytes), "")
		return &RPCResult{
			Result:     map[string]any{"opened": true, "kind": kind, "size": len(bytes)},
			BinaryRaw:  bytes,
			BinaryMime: "application/octet-stream",
		}, nil
	}
}
