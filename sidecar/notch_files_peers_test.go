package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func peersWrite(t *testing.T, dir, name, text string, age time.Duration) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

func peersRoots(t *testing.T) (map[string][]string, string, string, string) {
	t.Helper()
	root := t.TempDir()
	desk, docs, down := filepath.Join(root, "Desktop"), filepath.Join(root, "Documents"), filepath.Join(root, "Downloads")
	for _, dir := range []string{desk, docs, down} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return map[string][]string{"desktop": {desk}, "documents": {docs}, "downloads": {down}}, desk, docs, down
}

func peersNames(found []notchFileFound) string {
	names := []string{}
	for _, one := range found {
		names = append(names, one.Place+"/"+one.Name)
	}
	return strings.Join(names, " | ")
}

func TestNotchFindByWhatItIsCalled(t *testing.T) {
	roots, desk, docs, down := peersRoots(t)
	peersWrite(t, desk, "Deck, November.pdf", "deck", time.Hour)
	peersWrite(t, desk, "Deck, October.pdf", "deck", 40*24*time.Hour)
	peersWrite(t, docs, "Q3 numbers.xlsx", "numbers", 2*time.Hour)
	peersWrite(t, docs, "budget 2026.xlsx", "budget", 3*time.Hour)
	peersWrite(t, docs, "Northwind contract.docx", "contract", 5*time.Hour)
	peersWrite(t, down, "holiday.jpg", "picture", time.Minute)
	peersWrite(t, down, "pitch v30.pptx", "slides", 30*time.Minute)

	for asked, want := range map[string]string{
		"the Q3 numbers":                   "documents/Q3 numbers.xlsx",
		"Q3 number":                        "documents/Q3 numbers.xlsx",
		"the Northwind contract":           "documents/Northwind contract.docx",
		"can you send me budget 2026.xlsx": "documents/budget 2026.xlsx",
		"the holiday picture":              "downloads/holiday.jpg",
	} {
		found := notchFileFind(roots, nil, asked)
		if len(found) == 0 || found[0].Place+"/"+found[0].Name != want {
			t.Errorf("%q: got %q, want %q first", asked, peersNames(found), want)
		}
	}
	// A kind alone: the files of that kind, one whose name says it first, then the newest.
	if got := peersNames(notchFileFind(roots, nil, "the latest deck")); got != "desktop/Deck, November.pdf | desktop/Deck, October.pdf | downloads/pitch v30.pptx" {
		t.Errorf("the latest deck: %q", got)
	}
	if got := peersNames(notchFileFind(roots, nil, "the latest spreadsheet")); got != "documents/Q3 numbers.xlsx | documents/budget 2026.xlsx" {
		t.Errorf("the latest spreadsheet: %q", got)
	}
	// Words that name a file, and no file of that name: nothing, whatever kinds are there.
	// "The Acme contract" is not the Northwind contract: half of what was said is not enough.
	for _, asked := range []string{"the Acme contract pdf", "the Acme contract", "the roadmap deck", "", "the latest file please", "send me that one"} {
		if found := notchFileFind(roots, nil, asked); len(found) != 0 {
			t.Errorf("%q: nothing fits, got %q", asked, peersNames(found))
		}
	}
	// What it found is what is there: its size and its kind.
	found := notchFileFind(roots, nil, "the Q3 numbers")
	if found[0].Kind != "sheet" || found[0].Size != 7 || found[0].Changed == 0 {
		t.Errorf("found: %+v", found[0])
	}
}

func TestNotchFindNamesOnlyWhatWouldBeHandedOver(t *testing.T) {
	roots, desk, docs, _ := peersRoots(t)
	peersWrite(t, desk, "passwords.txt", "secret", time.Hour)
	peersWrite(t, desk, "bank recovery codes.pdf", "secret", time.Hour)
	peersWrite(t, docs, "empty report.docx", "", time.Hour)
	if err := os.Mkdir(filepath.Join(docs, "report folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	peersWrite(t, docs, "report.docx", "report", time.Hour)
	if err := os.Symlink(filepath.Join(docs, "report.docx"), filepath.Join(desk, "report link.docx")); err != nil {
		t.Skip("no links here")
	}
	for _, asked := range []string{"my passwords", "the bank recovery codes"} {
		if found := notchFileFind(roots, nil, asked); len(found) != 0 {
			t.Errorf("%q: a private file was named: %q", asked, peersNames(found))
		}
	}
	// Not the folder, not the empty one, not the link: the one plain file.
	if got := peersNames(notchFileFind(roots, nil, "the report")); got != "documents/report.docx" {
		t.Errorf("the report: %q", got)
	}
	// A blocked folder is not looked in.
	blocked := func(path string) bool { return strings.HasPrefix(path, docs) }
	if found := notchFileFind(roots, blocked, "the report"); len(found) != 0 {
		t.Errorf("a blocked folder was looked in: %q", peersNames(found))
	}
}

func TestNotchFindNamesAFew(t *testing.T) {
	roots, desk, _, _ := peersRoots(t)
	for n := 0; n < 12; n++ {
		peersWrite(t, desk, "report "+string(rune('a'+n))+".pdf", "x", time.Duration(n)*time.Hour)
	}
	found := notchFileFind(roots, nil, "the report")
	if len(found) != notchFindNamed || found[0].Name != "report a.pdf" {
		t.Errorf("got %d, first %q", len(found), found[0].Name)
	}
	// An asking longer than is read is cut, not refused.
	if found := notchFileFind(roots, nil, "report "+strings.Repeat("please ", 500)); len(found) == 0 {
		t.Errorf("a long asking found nothing")
	}
}

func TestNotchSaveName(t *testing.T) {
	for raw, want := range map[string]string{
		"deck.pdf":                          "deck.pdf",
		"../../outside.txt":                 "outside.txt",
		`C:\Windows\System32\drivers\hosts`: "hosts",
		"/etc/passwd":                       "passwd",
		"...":                               "file",
		"":                                  "file",
		".bashrc":                           "bashrc",
		"run<me>:now?.bat":                  "runmenow.bat",
		"line\nbreak\x00.txt":               "linebreak.txt",
		"CON.txt":                           "file CON.txt",
		"nul":                               "file nul",
		"com1.log":                          "file com1.log",
		"console.txt":                       "console.txt",
		"trailing dots... ":                 "trailing dots",
		strings.Repeat("a", 300) + ".pdf":   strings.Repeat("a", notchFileNameMost),
	} {
		if got := notchSaveName(raw); got != want {
			t.Errorf("%q: got %q, want %q", raw, got, want)
		}
	}
}

func peersSum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestNotchSaveArrivesInPartsAndIsNeverWrittenOver(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "deck.pdf"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	saves := newNotchSaves()
	data := []byte(strings.Repeat("0123456789", 5000))
	id, err := saves.begin("../deck.pdf", int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	for at := 0; at < len(data); at += 20000 {
		end := at + 20000
		if end > len(data) {
			end = len(data)
		}
		if err := saves.part(id, data[at:end]); err != nil {
			t.Fatal(err)
		}
	}
	name, size, err := saves.end(id, strings.ToUpper(peersSum(data)), dir)
	if err != nil || name != "deck (2).pdf" || size != int64(len(data)) {
		t.Fatalf("end: %q %d %v", name, size, err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "deck (2).pdf")); string(got) != string(data) {
		t.Errorf("what was saved is not what arrived")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "deck.pdf")); string(got) != "mine" {
		t.Errorf("the file that was there was written over")
	}
	// Nothing of it is left where it was kept meanwhile, and it cannot be ended twice.
	if len(saves.open) != 0 {
		t.Errorf("it is still open")
	}
	if _, _, err := saves.end(id, peersSum(data), dir); err == nil {
		t.Errorf("ended twice")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Errorf("the folder holds %d things", len(entries))
	}
}

func TestNotchSaveTakesOnlyWhatWasPromised(t *testing.T) {
	dir := t.TempDir()
	saves := newNotchSaves()
	empty := func() {
		t.Helper()
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Errorf("something was saved: %d", len(entries))
		}
	}
	// Does not add up to what it says it is.
	id, _ := saves.begin("a.txt", 5)
	_ = saves.part(id, []byte("hello"))
	if _, _, err := saves.end(id, peersSum([]byte("HELLO")), dir); err == nil {
		t.Errorf("a file that does not add up was saved")
	}
	empty()
	// Shorter than promised.
	id, _ = saves.begin("a.txt", 10)
	_ = saves.part(id, []byte("hello"))
	if _, _, err := saves.end(id, peersSum([]byte("hello")), dir); err == nil {
		t.Errorf("a file that is cut short was saved")
	}
	empty()
	// Longer than promised: let go at the piece that goes over.
	id, _ = saves.begin("a.txt", 5)
	if err := saves.part(id, []byte("hello!")); err == nil {
		t.Errorf("more than was promised was taken")
	}
	if err := saves.part(id, []byte("h")); err == nil {
		t.Errorf("it was not let go")
	}
	// Too large, nothing at all, a piece too large, an id nobody was given.
	if _, err := saves.begin("a.txt", notchSaveMost+1); err == nil {
		t.Errorf("a file larger than is saved was begun")
	}
	if _, err := saves.begin("a.txt", 0); err == nil {
		t.Errorf("an empty file was begun")
	}
	id, _ = saves.begin("a.txt", notchSaveMost)
	if err := saves.part(id, make([]byte, notchSavePartMost+1)); err == nil {
		t.Errorf("a piece larger than a piece is was taken")
	}
	if err := saves.part("nobody", []byte("x")); err == nil {
		t.Errorf("a piece for no file was taken")
	}
	empty()
	if len(saves.open) != 0 {
		t.Errorf("%d are still open", len(saves.open))
	}
}

func TestNotchSaveLetsGoOfWhatRests(t *testing.T) {
	saves := newNotchSaves()
	now := time.Now()
	saves.now = func() time.Time { return now }
	ids := []string{}
	for n := 0; n < notchSaveOpenMost; n++ {
		id, err := saves.begin("a.txt", 5)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if _, err := saves.begin("a.txt", 5); err == nil {
		t.Errorf("more files than may arrive at once were begun")
	}
	kept := saves.open[ids[0]].temp.Name()
	now = now.Add(notchSaveIdle + time.Second)
	if _, err := saves.begin("a.txt", 5); err != nil {
		t.Errorf("what rested was not let go: %v", err)
	}
	if _, err := os.Stat(kept); !os.IsNotExist(err) {
		t.Errorf("what it kept meanwhile is still there")
	}
	if err := saves.part(ids[0], []byte("x")); err == nil {
		t.Errorf("a piece for a file that was let go was taken")
	}
	for id := range saves.open {
		saves.drop(id)
	}
}

func TestNotchDownloadsHere(t *testing.T) {
	roots, _, _, down := peersRoots(t)
	if got := notchDownloadsHere(roots, nil); got != down {
		t.Errorf("got %q", got)
	}
	if got := notchDownloadsHere(roots, func(string) bool { return true }); got != "" {
		t.Errorf("a blocked folder was chosen: %q", got)
	}
	if got := notchDownloadsHere(map[string][]string{"downloads": {filepath.Join(down, "no such"), down}}, nil); got != down {
		t.Errorf("got %q", got)
	}
	if got := notchDownloadsHere(map[string][]string{}, nil); got != "" {
		t.Errorf("got %q", got)
	}
}
