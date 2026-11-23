package main

// Files between people's Jarvises (src/notch/people-files.ts): looking one
// up by what it is called, and putting one that arrived where the person
// finds it.
//
// The owner, 22 November 2026, after the first files crossed between a PC
// and a Mac: "i might want to retreive a file in someone elses pc like we
// built in our poc", and: "for the mac it receives it but fails to save it
// in the folder".
//
// notch.find takes the words somebody asked with ("the Q3 numbers") and
// names the files of the desktop, the documents and the downloads that they
// fit best, down to two folders deep. It opens nothing.
//
// The owner, 23 November 2026, after trying it: "it only basically works if
// I already know what the file name is, which shouldn't ... Send me the
// deck. It might not be called deck. It might be called deck v30." So it
// also names the files that were changed last and are the kind of thing
// people ask for (documents, sheets, slides, PDFs, pictures), whatever they
// are called. Which of them is meant is then worked out by the brain, from
// more than the name, and put to the person at this computer. What it names is shown to
// the person at this computer, who says whether one of them is sent: the
// one who asked is told nothing by this, not even that nothing was found.
// A file that would never be handed over (private by its name, a shortcut,
// a folder, empty, kept online only) is not named either.
//
// notch.save puts a file into the downloads. It comes in parts, because one
// message is not large enough for it, and is only put in place when all of
// it is here and adds up to what was promised. It is never written over
// something that is there, and its name is made into a plain file name
// first: no folder in it, nothing a file system gives a meaning to.
//
// Why the saving is done here and not by the brain: this is the program
// that the person gave leave to touch their folders. On a Mac the brain is
// not, and macOS turned its writing down.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	// How many files are named for one asking by their name alone, and how
	// many in all with the ones that were changed last.
	notchFindNamed = 5
	notchFindWide  = 60
	// How far down the folders are looked through, and the most that is
	// looked at in all.
	notchFindDepth = 2
	notchFindLooks = 6000
	// The longest asking that is read.
	notchFindWordsMost = 200
	// The largest file that is saved: what crosses at the most
	// (src/peers/notes.ts, PEER_FILE_MAX).
	notchSaveMost = 25 * 1024 * 1024
	// The largest part of one. A message to this program is at most 10 MB.
	notchSavePartMost = 2 * 1024 * 1024
	// How many files may be arriving at once, and how long one may rest
	// between two parts before it is let go.
	notchSaveOpenMost = 4
	notchSaveIdle     = 10 * time.Minute
	// How many names are tried: "deck.pdf", "deck (2).pdf", ...
	notchSaveNames = 200
)

// notchFileFound is one file that fits what was asked for, or may.
type notchFileFound struct {
	Place string `json:"place"`
	// The folder it is in, below the place: "" at its top, "Pitch/Decks"
	// further down. Never more than notchFindDepth folders.
	Dir     string `json:"dir"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Size    int64  `json:"size"`
	Changed int64  `json:"changed"`
	// How well its name and kind fit the words. Nought: it is named only
	// because it was changed lately and is the kind of thing people ask for.
	Score int `json:"score"`
}

// The kinds of file people ask each other for.
var notchFindAsked = map[string]bool{"document": true, "sheet": true, "slides": true, "pdf": true, "picture": true}

// Folders nobody keeps their own files in.
var notchFindSkipped = map[string]bool{"node_modules": true, "__pycache__": true, "venv": true, "dist": true, "build": true, "target": true, "vendor": true}

// notchFileIn is one file with the folder it was found in.
type notchFileIn struct {
	dir  string
	file notchFileSeen
}

// notchFilesDeep lists the files of one place, down to `depth` folders. A
// folder that is hidden, blocked, private by its name, or only a link to
// somewhere else is not gone into.
func notchFilesDeep(root, sub string, depth int, blocked func(path string) bool, looked *int, out *[]notchFileIn) {
	dir := filepath.Join(root, filepath.FromSlash(sub))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if *looked >= notchFindLooks {
			return
		}
		name := entry.Name()
		if notchFileHidden(name) || notchFileNameOdd(name) {
			continue
		}
		path := filepath.Join(dir, name)
		if blocked != nil && blocked(path) {
			continue
		}
		*looked++
		// A link is neither gone into nor named: it may lead anywhere.
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if entry.IsDir() {
			if depth > 0 && filepath.Ext(name) != ".app" && !notchFindSkipped[strings.ToLower(name)] && !notchFilePrivate(name) {
				next := name
				if sub != "" {
					next = sub + "/" + name
				}
				notchFilesDeep(root, next, depth-1, blocked, looked, out)
			}
			continue
		}
		kind := notchFileKind(name, false)
		if kind == "shortcut" || notchFilePrivate(name) {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || notchFileElsewhere(info) {
			continue
		}
		*out = append(*out, notchFileIn{sub, notchFileSeen{Name: notchFileName(name), Kind: kind, Changed: info.ModTime().UnixMilli(), Size: info.Size()}})
	}
}

// Words that say nothing about which file is meant.
var notchFindIdle = map[string]bool{
	"the": true, "a": true, "an": true, "my": true, "your": true, "his": true, "her": true, "their": true, "our": true, "me": true, "us": true,
	"please": true, "file": true, "files": true, "of": true, "for": true, "from": true, "to": true, "on": true, "in": true, "at": true, "and": true,
	"or": true, "that": true, "this": true, "it": true, "one": true, "called": true, "named": true, "version": true, "copy": true, "latest": true,
	"last": true, "newest": true, "recent": true, "new": true, "current": true, "send": true, "get": true, "give": true, "can": true, "you": true,
	"i": true, "need": true, "want": true, "with": true, "about": true, "is": true, "are": true, "was": true, "have": true, "has": true,
}

// Words that say what kind of file is meant. A deck is as often a PDF as it
// is slides, so it fits both.
var notchFindKinds = map[string][]string{
	"deck": {"slides", "pdf"}, "decks": {"slides", "pdf"}, "slides": {"slides", "pdf"}, "presentation": {"slides", "pdf"}, "powerpoint": {"slides"}, "keynote": {"slides"},
	"spreadsheet": {"sheet"}, "sheet": {"sheet"}, "excel": {"sheet"}, "csv": {"sheet"},
	"pdf": {"pdf"}, "document": {"document", "pdf"}, "doc": {"document"}, "word": {"document"},
	"picture": {"picture"}, "photo": {"picture"}, "image": {"picture"}, "screenshot": {"picture"},
	"video": {"video"}, "recording": {"audio", "video"},
}

// notchFindTokens cuts text into its words: letters and digits, in small letters.
func notchFindTokens(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

// notchFindScore says how well a file's name and kind fit what was asked for.
// Nought is "not this one".
//
// A wrong file must not be put up for a yes: the person may press it out of
// habit, and then it has left. So when words that name a file were said
// ("the Acme contract"), more than half of them must be in the name: a
// "Northwind contract" is not offered for it. Only when nothing but a kind
// was said ("the latest deck") is the kind enough.
func notchFindScore(asked string, wanted []string, kinds map[string]bool, file notchFileSeen) int {
	ext := filepath.Ext(file.Name)
	base := strings.ToLower(strings.TrimSuffix(file.Name, ext))
	nameWords := map[string]bool{}
	for _, word := range notchFindTokens(base) {
		nameWords[word] = true
	}
	score, named, namedHits, kindInName := 0, 0, 0, false
	for _, word := range wanted {
		_, isKind := notchFindKinds[word]
		hit := 0
		if nameWords[word] {
			hit = 10
		} else if len(word) >= 3 {
			// "number" for "numbers", "contract" for "contracts": the same word, a little longer or shorter.
			for have := range nameWords {
				if len(have) >= 3 && (strings.HasPrefix(have, word) || strings.HasPrefix(word, have)) {
					hit = 6
					break
				}
			}
		}
		score += hit
		if isKind {
			kindInName = kindInName || hit > 0
			continue
		}
		named++
		if hit > 0 {
			namedHits++
		}
	}
	if kinds[file.Kind] {
		score += 3
	}
	// Its whole name was said: that is the one.
	if len(base) >= 4 && strings.Contains(strings.ToLower(asked), base) {
		return score + 30
	}
	if named > 0 {
		if namedHits*2 <= named {
			return 0
		}
		return score
	}
	if !kinds[file.Kind] && !kindInName {
		return 0
	}
	return score
}

// notchFileFind looks through the three places for the files that fit, the
// best first, and among equals the newest.
func notchFileFind(roots map[string][]string, blocked func(path string) bool, asked string) []notchFileFound {
	found := notchFileFindWide(roots, blocked, asked, false)
	if len(found) > notchFindNamed {
		found = found[:notchFindNamed]
	}
	return found
}

// notchFileFindWide is the same looking. With `wide` it goes on to name the
// files that were changed last and are the kind of thing people ask for,
// with a score of nought, so that the one that is meant can be told by more
// than its name. The ones that fit by name come first.
func notchFileFindWide(roots map[string][]string, blocked func(path string) bool, asked string, wide bool) []notchFileFound {
	if len(asked) > notchFindWordsMost {
		// Cut at a word's end: half a word would count as a word that is in no name.
		asked = asked[:notchFindWordsMost]
		if at := strings.LastIndexAny(asked, " \t\n"); at > 0 {
			asked = asked[:at]
		}
	}
	wanted := []string{}
	kinds := map[string]bool{}
	for _, word := range notchFindTokens(asked) {
		if fit, ok := notchFindKinds[word]; ok {
			for _, kind := range fit {
				kinds[kind] = true
			}
			wanted = append(wanted, word)
			continue
		}
		if !notchFindIdle[word] {
			wanted = append(wanted, word)
		}
	}
	if len(wanted) == 0 && !wide {
		return []notchFileFound{}
	}
	all := []notchFileFound{}
	looked := 0
	for _, place := range []string{"desktop", "documents", "downloads"} {
		_, dir := notchFilesPlace(place, roots[place], blocked)
		if dir == "" {
			continue
		}
		in := []notchFileIn{}
		notchFilesDeep(dir, "", notchFindDepth, blocked, &looked, &in)
		for _, one := range in {
			score := 0
			if len(wanted) > 0 {
				score = notchFindScore(asked, wanted, kinds, one.file)
			}
			if score == 0 && !(wide && notchFindAsked[one.file.Kind]) {
				continue
			}
			all = append(all, notchFileFound{Place: place, Dir: one.dir, Name: one.file.Name, Kind: one.file.Kind, Size: one.file.Size, Changed: one.file.Changed, Score: score})
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Score != all[j].Score {
			return all[i].Score > all[j].Score
		}
		return all[i].Changed > all[j].Changed
	})
	most := notchFindNamed
	if wide {
		most = notchFindWide
	}
	if !wide {
		// By name alone: only the ones that fit.
		fit := all[:0]
		for _, one := range all {
			if one.Score > 0 {
				fit = append(fit, one)
			}
		}
		all = fit
	}
	if len(all) > most {
		all = all[:most]
	}
	return all
}

// makeNotchFindHandler serves notch.find: {words} gives the files that fit.
func makeNotchFindHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		words, _ := params["words"].(string)
		wide, _ := params["wide"].(bool)
		started := time.Now()
		// Made for this look: the blocked list is read once, not once for every file (blockedPathCheck).
		found := notchFileFindWide(notchFileRootsHere(), blockedPathCheck(cfg.Filesystem.BlockedPaths), words, wide)
		if !wide && len(found) > notchFindNamed {
			found = found[:notchFindNamed]
		}
		fit := 0
		for _, one := range found {
			if one.Score > 0 {
				fit++
			}
		}
		// How many, never which, and never what was asked for.
		log.Printf("[notch] a file was looked up: %d fit by name, %d named in all, in %d ms", fit, len(found), time.Since(started).Milliseconds())
		return &RPCResult{Result: map[string]any{"found": found}}, nil
	}
}

// Names a Windows folder keeps for itself, whatever comes after the dot.
var notchSaveReserved = map[string]bool{"con": true, "prn": true, "aux": true, "nul": true}

// notchSaveName makes a plain file name of what came with a file: the last
// part of a path, no control characters, nothing a file system reads as more
// than a name, not hidden, not too long. Never empty.
func notchSaveName(raw string) string {
	if at := strings.LastIndexAny(raw, `/\`); at >= 0 {
		raw = raw[at+1:]
	}
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(`<>:"|?*`, r) {
			return -1
		}
		return r
	}, raw)
	clean = strings.TrimRight(strings.TrimLeft(strings.TrimSpace(clean), ". "), ". ")
	runes := []rune(clean)
	if len(runes) > notchFileNameMost {
		clean = strings.TrimRight(string(runes[:notchFileNameMost]), ". ")
	}
	if clean == "" {
		return "file"
	}
	stem := strings.ToLower(strings.TrimSuffix(clean, filepath.Ext(clean)))
	if notchSaveReserved[stem] || (len(stem) == 4 && (strings.HasPrefix(stem, "com") || strings.HasPrefix(stem, "lpt")) && stem[3] >= '0' && stem[3] <= '9') {
		clean = "file " + clean
	}
	return clean
}

// notchSaveInto puts what is in `temp` into `dir` under `name`, or under the
// next name that is free. Nothing is ever written over.
func notchSaveInto(dir, name, temp string) (string, error) {
	name = notchSaveName(name)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	from, err := os.Open(temp)
	if err != nil {
		return "", fmt.Errorf("it could not be read back")
	}
	defer from.Close()
	for n := 1; n <= notchSaveNames; n++ {
		one := name
		if n > 1 {
			one = fmt.Sprintf("%s (%d)%s", stem, n, ext)
		}
		// Fails when the name is taken, by a file or by anything else.
		to, err := os.OpenFile(filepath.Join(dir, one), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			if os.IsPermission(err) {
				return "", fmt.Errorf("this computer did not let me write there")
			}
			return "", fmt.Errorf("it could not be written there")
		}
		_, copyErr := io.Copy(to, from)
		closeErr := to.Close()
		if copyErr != nil || closeErr != nil {
			_ = os.Remove(filepath.Join(dir, one))
			return "", fmt.Errorf("it could not be written there")
		}
		return one, nil
	}
	return "", fmt.Errorf("too many files of that name are there already")
}

// notchSaving is one file on its way in.
type notchSaving struct {
	name    string
	size    int64
	written int64
	temp    *os.File
	sum     interface {
		io.Writer
		Sum(b []byte) []byte
	}
	touched time.Time
}

// notchSaves holds the files that are arriving.
type notchSaves struct {
	mu   sync.Mutex
	open map[string]*notchSaving
	now  func() time.Time
}

func newNotchSaves() *notchSaves {
	return &notchSaves{open: map[string]*notchSaving{}, now: time.Now}
}

func (s *notchSaves) drop(id string) {
	if one, ok := s.open[id]; ok {
		name := one.temp.Name()
		_ = one.temp.Close()
		_ = os.Remove(name)
		delete(s.open, id)
	}
}

// begin opens a place for a file of this size. An id comes back for its parts.
func (s *notchSaves) begin(name string, size int64) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, one := range s.open {
		if s.now().Sub(one.touched) > notchSaveIdle {
			s.drop(id)
		}
	}
	if size <= 0 || size > notchSaveMost {
		return "", fmt.Errorf("it is larger than is saved")
	}
	if len(s.open) >= notchSaveOpenMost {
		return "", fmt.Errorf("too many files are arriving at once")
	}
	temp, err := os.CreateTemp("", "jarvis-arriving-*")
	if err != nil {
		return "", fmt.Errorf("there is nowhere to keep it while it arrives")
	}
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return "", fmt.Errorf("it could not be begun")
	}
	id := hex.EncodeToString(raw)
	s.open[id] = &notchSaving{name: name, size: size, temp: temp, sum: sha256.New(), touched: s.now()}
	return id, nil
}

// part takes the next piece. Never more than was promised.
func (s *notchSaves) part(id string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	one, ok := s.open[id]
	if !ok {
		return fmt.Errorf("that file is not arriving")
	}
	if len(data) == 0 || len(data) > notchSavePartMost || one.written+int64(len(data)) > one.size {
		s.drop(id)
		return fmt.Errorf("it is not the file that was promised")
	}
	if _, err := one.temp.Write(data); err != nil {
		s.drop(id)
		return fmt.Errorf("it could not be kept while it arrives")
	}
	_, _ = one.sum.Write(data)
	one.written += int64(len(data))
	one.touched = s.now()
	return nil
}

// end puts the file into `dir` when all of it is here and adds up.
func (s *notchSaves) end(id, sha, dir string) (string, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	one, ok := s.open[id]
	if !ok {
		return "", 0, fmt.Errorf("that file is not arriving")
	}
	defer s.drop(id)
	if one.written != one.size || !strings.EqualFold(hex.EncodeToString(one.sum.Sum(nil)), sha) {
		return "", 0, fmt.Errorf("it is not the file that was promised")
	}
	if err := one.temp.Sync(); err != nil {
		return "", 0, fmt.Errorf("it could not be kept while it arrives")
	}
	saved, err := notchSaveInto(dir, one.name, one.temp.Name())
	return saved, one.size, err
}

// notchDownloadsHere is the folder a file that arrived goes into: the first
// of the downloads folders that is there and is not blocked.
func notchDownloadsHere(roots map[string][]string, blocked func(dir string) bool) string {
	for _, dir := range roots["downloads"] {
		if blocked != nil && blocked(dir) {
			continue
		}
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
	}
	return ""
}

// makeNotchSaveHandler serves notch.save, in three steps: {step: "begin",
// name, size} gives an id; {step: "part", id, data} takes a piece, in
// base64; {step: "end", id, sha} puts it in the downloads and says under
// which name. {step: "drop", id} lets one go.
func makeNotchSaveHandler(cfg *SidecarConfig) RPCHandler {
	saves := newNotchSaves()
	// Read anew at each call: it is asked about a folder or two, not about every file.
	blocked := func(dir string) bool { return isBlockedPath(dir, cfg.Filesystem.BlockedPaths) }
	refused := func(why string) (*RPCResult, error) {
		// Why, never which.
		log.Printf("[notch] a file that arrived was not saved: %s", why)
		return &RPCResult{Result: map[string]any{"saved": false, "why": why}}, nil
	}
	return func(params map[string]any) (*RPCResult, error) {
		step, _ := params["step"].(string)
		id, _ := params["id"].(string)
		switch step {
		case "begin":
			name, _ := params["name"].(string)
			size, _ := params["size"].(float64)
			if notchDownloadsHere(notchFileRootsHere(), blocked) == "" {
				return refused("the downloads are not reached")
			}
			got, err := saves.begin(name, int64(size))
			if err != nil {
				return refused(err.Error())
			}
			return &RPCResult{Result: map[string]any{"id": got}}, nil
		case "part":
			text, _ := params["data"].(string)
			if len(text) > notchSavePartMost*4/3+8 {
				saves.mu.Lock()
				saves.drop(id)
				saves.mu.Unlock()
				return refused("it is not the file that was promised")
			}
			data, err := base64.StdEncoding.DecodeString(text)
			if err != nil {
				saves.mu.Lock()
				saves.drop(id)
				saves.mu.Unlock()
				return refused("it is not the file that was promised")
			}
			if err := saves.part(id, data); err != nil {
				return refused(err.Error())
			}
			return &RPCResult{Result: map[string]any{"taken": true}}, nil
		case "end":
			sha, _ := params["sha"].(string)
			dir := notchDownloadsHere(notchFileRootsHere(), blocked)
			if dir == "" {
				saves.mu.Lock()
				saves.drop(id)
				saves.mu.Unlock()
				return refused("the downloads are not reached")
			}
			name, size, err := saves.end(id, sha, dir)
			if err != nil {
				return refused(err.Error())
			}
			// Its kind and its size, never its name.
			log.Printf("[notch] a file that arrived was saved to the downloads: %s, %d bytes", notchFileKind(name, false), size)
			return &RPCResult{Result: map[string]any{"saved": true, "name": name, "place": "downloads"}}, nil
		case "drop":
			saves.mu.Lock()
			saves.drop(id)
			saves.mu.Unlock()
			return &RPCResult{Result: map[string]any{"dropped": true}}, nil
		}
		return nil, fmt.Errorf("notch.save: unknown step")
	}
}
