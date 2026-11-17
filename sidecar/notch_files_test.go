package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func notchFilesWrite(t *testing.T, dir, name string, age time.Duration) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("SECRET CONTENT that must never be told"), 0o600); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

func TestNotchFilesTellsNamesKindsAndCountsAndNothingOfWhatIsInAFile(t *testing.T) {
	dir := t.TempDir()
	notchFilesWrite(t, dir, "Budget Q4.xlsx", 2*time.Hour)
	notchFilesWrite(t, dir, "Pitch.pptx", time.Hour)
	notchFilesWrite(t, dir, "notes.txt", 3*time.Hour)
	notchFilesWrite(t, dir, "Chrome.lnk", time.Minute)
	notchFilesWrite(t, dir, "desktop.ini", time.Minute)
	notchFilesWrite(t, dir, "~$Budget Q4.xlsx", time.Minute)
	notchFilesWrite(t, dir, ".hidden", time.Minute)
	if err := os.Mkdir(filepath.Join(dir, "Clients"), 0o700); err != nil {
		t.Fatal(err)
	}
	// What is inside a folder is not looked at.
	notchFilesWrite(t, filepath.Join(dir, "Clients"), "inside.pdf", time.Minute)

	got := notchFilesIn("desktop", dir)
	if !got.Reached || got.Files != 3 || got.Folders != 1 || got.Shortcuts != 1 {
		t.Fatalf("counts: reached %v, files %d, folders %d, shortcuts %d", got.Reached, got.Files, got.Folders, got.Shortcuts)
	}
	if got.Kinds["sheet"] != 1 || got.Kinds["slides"] != 1 || got.Kinds["document"] != 1 || got.Kinds["pdf"] != 0 {
		t.Fatalf("kinds: %v", got.Kinds)
	}
	// The newest first; a shortcut, and what the system keeps for itself, are never named.
	var names []string
	for _, seen := range got.Recent {
		names = append(names, seen.Name)
		if seen.Changed == 0 {
			t.Fatalf("%q has no date", seen.Name)
		}
	}
	want := []string{"Clients", "Pitch.pptx", "Budget Q4.xlsx", "notes.txt"}
	if len(names) != len(want) {
		t.Fatalf("named %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("named %v, want %v", names, want)
		}
	}
}

func TestNotchFilesNamesOnlyTheNewestFew(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < notchFilesNamed+4; i++ {
		notchFilesWrite(t, dir, string(rune('a'+i))+".pdf", time.Duration(i)*time.Minute)
	}
	got := notchFilesIn("documents", dir)
	if got.Files != notchFilesNamed+4 || len(got.Recent) != notchFilesNamed || got.Recent[0].Name != "a.pdf" {
		t.Fatalf("files %d, named %d, first %q", got.Files, len(got.Recent), got.Recent[0].Name)
	}
}

func TestNotchFilesAFolderThatIsNotThereIsNotReachedAndNothingBreaks(t *testing.T) {
	got := notchFilesIn("desktop", filepath.Join(t.TempDir(), "no such folder"))
	if got.Reached || got.Files != 0 || got.Recent == nil || got.Kinds == nil {
		t.Fatalf("got %+v", got)
	}
}

func TestNotchFilesLooksWhereTheDesktopReallyIsAndNeverInABlockedFolder(t *testing.T) {
	home, drive := t.TempDir(), t.TempDir()
	// A cloud drive has taken the desktop over: the one in the home folder is empty.
	for _, dir := range []string{filepath.Join(home, "Desktop"), filepath.Join(drive, "Desktop"), filepath.Join(home, "Documents")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	notchFilesWrite(t, filepath.Join(drive, "Desktop"), "Pitch.pptx", time.Minute)
	notchFilesWrite(t, filepath.Join(home, "Documents"), "Contract.pdf", time.Minute)
	env := func(key string) string {
		if key == "OneDrive" {
			return drive
		}
		return ""
	}
	roots := notchFileRoots([]string{home}, env, "windows", nil)
	if roots["desktop"][0] != filepath.Join(drive, "Desktop") || roots["downloads"][0] != filepath.Join(home, "Downloads") {
		t.Fatalf("roots: %v", roots)
	}
	places := notchFilesLook(roots, nil)
	if len(places) != 3 || places[0].Place != "desktop" || places[0].Files != 1 || places[1].Files != 1 || places[2].Reached {
		t.Fatalf("places: %+v", places)
	}
	// The person blocked their documents: that folder is not looked into at all.
	blocked := func(dir string) bool { return dir == filepath.Join(home, "Documents") }
	places = notchFilesLook(roots, blocked)
	if places[1].Reached || places[1].Files != 0 || len(places[1].Recent) != 0 {
		t.Fatalf("a blocked folder was looked into: %+v", places[1])
	}
	// On a Mac there is no cloud drive to ask about: the home folder is where it is.
	mac := notchFileRoots([]string{home}, env, "darwin", nil)
	if len(mac["desktop"]) != 1 || mac["desktop"][0] != filepath.Join(home, "Desktop") {
		t.Fatalf("mac roots: %v", mac)
	}
}

func TestNotchFileNameIsOneLineAndNotLongerThanALine(t *testing.T) {
	long := ""
	for i := 0; i < 300; i++ {
		long += "x"
	}
	if got := notchFileName("a\nb\tc"); got != "a b c" {
		t.Fatalf("got %q", got)
	}
	if got := notchFileName(long); len([]rune(got)) != notchFileNameMost {
		t.Fatalf("length %d", len([]rune(got)))
	}
}

func TestNotchFilePrivateIsToldFromTheNameAlone(t *testing.T) {
	for _, name := range []string{"passwords.txt", "My Passwords 2026.docx", "wifi password.txt", "id_rsa.pem", "server.key", "vault.kdbx", ".env", "prod.env", "recovery codes.txt",
		"Backup-Codes Google.pdf", "seed phrase.txt", "wallet.dat", "Bank statement October.pdf", "IBAN.txt", "payslip_2026_10.pdf", "Tax return 2025.pdf", "passport scan.jpg", "API tokens.md", "logins.csv", "medical report.pdf"} {
		if !notchFilePrivate(name) {
			t.Errorf("%q must be private", name)
		}
	}
	for _, name := range []string{"Budget Q4.xlsx", "Pitch.pptx", "notes.txt", "monkey business.docx", "Turkey trip.pdf", "tokenomics deck.pptx", "taxi receipts.pdf", "Keynote for Monday.pptx"} {
		if notchFilePrivate(name) {
			t.Errorf("%q must not be private", name)
		}
	}
	// It errs towards private, on purpose: it would rather not open a harmless
	// file than open a private one. These are harmless, and are not opened.
	for _, name := range []string{"draft.key.pptx", "banker's lamp.jpg", "Statement of work.docx"} {
		if !notchFilePrivate(name) {
			t.Errorf("%q is expected to be held back by the rule as it stands", name)
		}
	}
}

func TestNotchFilesMarksWhatIsPrivateAndSaysHowLargeEachIs(t *testing.T) {
	dir := t.TempDir()
	notchFilesWrite(t, dir, "passwords.txt", time.Minute)
	notchFilesWrite(t, dir, "notes.txt", 2*time.Minute)
	got := notchFilesIn("desktop", dir)
	if len(got.Recent) != 2 || !got.Recent[0].Private || got.Recent[1].Private || got.Recent[1].Size == 0 {
		t.Fatalf("recent: %+v", got.Recent)
	}
}

func TestNotchFileOpenHandsOverOnlyAPlainFileAtTheTopOfAPlace(t *testing.T) {
	home := t.TempDir()
	desk := filepath.Join(home, "Desktop")
	if err := os.MkdirAll(filepath.Join(desk, "Clients"), 0o700); err != nil {
		t.Fatal(err)
	}
	notchFilesWrite(t, desk, "notes.txt", time.Minute)
	notchFilesWrite(t, desk, "passwords.txt", time.Minute)
	notchFilesWrite(t, desk, "Chrome.lnk", time.Minute)
	notchFilesWrite(t, filepath.Join(desk, "Clients"), "inside.txt", time.Minute)
	notchFilesWrite(t, home, "outside.txt", time.Minute)
	if err := os.WriteFile(filepath.Join(desk, "empty.txt"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	roots := notchFileRoots([]string{home}, func(string) string { return "" }, "linux", nil)

	bytes, kind, err := notchFileOpen(roots, nil, "desktop", "notes.txt")
	if err != nil || kind != "document" || len(bytes) == 0 {
		t.Fatalf("notes.txt: %v, %q, %d bytes", err, kind, len(bytes))
	}
	// Everything else is refused, and nothing of it is handed over.
	for _, refused := range [][2]string{
		{"desktop", "passwords.txt"},      // private by its name
		{"desktop", "Chrome.lnk"},         // a shortcut
		{"desktop", "Clients"},            // a folder
		{"desktop", "Clients/inside.txt"}, // not at the top
		{"desktop", "../outside.txt"},     // not in the place at all
		{"desktop", "..\\outside.txt"},    // the same, written the other way
		{"desktop", ".."},                 // not a name
		{"desktop", ""},                   // nothing
		{"desktop", "missing.txt"},        // not there
		{"desktop", "empty.txt"},          // nothing in it
		{"desktop", "desktop.ini"},        // not listed
		{"home", "outside.txt"},           // not a place that is looked in
		{"documents", "notes.txt"},        // that place is not there
	} {
		if got, _, err := notchFileOpen(roots, nil, refused[0], refused[1]); err == nil || got != nil {
			t.Errorf("%s / %q must be refused, got %d bytes", refused[0], refused[1], len(got))
		}
	}
	// A link on the desktop to a file somewhere else is not followed.
	if err := os.Symlink(filepath.Join(home, "outside.txt"), filepath.Join(desk, "link.txt")); err == nil {
		if got, _, err := notchFileOpen(roots, nil, "desktop", "link.txt"); err == nil || got != nil {
			t.Errorf("a link was followed: %d bytes", len(got))
		}
	}
	// A place the person blocked hands over nothing.
	if got, _, err := notchFileOpen(roots, func(string) bool { return true }, "desktop", "notes.txt"); err == nil || got != nil {
		t.Errorf("a blocked place handed a file over")
	}
}

func TestNotchFileOpenRefusesAFileLargerThanTheBrainReads(t *testing.T) {
	home := t.TempDir()
	desk := filepath.Join(home, "Desktop")
	if err := os.MkdirAll(desk, 0o700); err != nil {
		t.Fatal(err)
	}
	big, err := os.Create(filepath.Join(desk, "film notes.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if err := big.Truncate(notchFileMost + 1); err != nil {
		t.Fatal(err)
	}
	big.Close()
	if got, _, err := notchFileOpen(notchFileRoots([]string{home}, func(string) string { return "" }, "linux", nil), nil, "desktop", "film notes.txt"); err == nil || got != nil {
		t.Fatalf("a file over the limit was handed over")
	}
}

func TestNotchFileHomesAsksTheSystemBeforeTheEnvironment(t *testing.T) {
	// A test build is started with its home pointed at a folder of its own. The person's files are not in there.
	env := func(key string) string {
		return map[string]string{"HOMEDRIVE": "C:", "HOMEPATH": `\Users\sam`}[key]
	}
	homes := notchFileHomes(`C:\Users\sam`, `C:\Users\sam\JarvisNotchDev\profile`, env, "windows")
	// The account's own folder first, the same one from the drive and path not twice, the environment's last.
	if len(homes) != 2 || homes[0] != `C:\Users\sam` || homes[1] != `C:\Users\sam\JarvisNotchDev\profile` {
		t.Fatalf("homes: %q", homes)
	}
	// With no account to ask, the drive and path still come before the environment.
	if homes = notchFileHomes("", `C:\fake`, env, "windows"); len(homes) != 2 || homes[0] != `C:\Users\sam` {
		t.Fatalf("homes without an account: %q", homes)
	}
	if homes = notchFileHomes("", "", func(string) string { return "" }, "linux"); len(homes) != 0 {
		t.Fatalf("no home at all: %q", homes)
	}
}

func TestNotchFilesFindsTheDesktopThoughTheEnvironmentPointsElsewhere(t *testing.T) {
	real, fake, moved := t.TempDir(), t.TempDir(), t.TempDir()
	for _, dir := range []string{filepath.Join(real, "Desktop"), filepath.Join(moved, "My papers")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	notchFilesWrite(t, filepath.Join(real, "Desktop"), "Pitch.pptx", time.Minute)
	notchFilesWrite(t, filepath.Join(moved, "My papers"), "Contract.pdf", time.Minute)
	none := func(string) string { return "" }
	// The environment's home is a folder with nothing in it; the account's own is asked first.
	roots := notchFileRoots(notchFileHomes(real, fake, none, "linux"), none, "linux", map[string]string{"documents": filepath.Join(moved, "My papers")})
	places := notchFilesLook(roots, nil)
	if !places[0].Reached || places[0].Files != 1 {
		t.Fatalf("the desktop was not found: %+v", places[0])
	}
	// Documents were moved somewhere of another name: where the system says they are is where they are looked for.
	if !places[1].Reached || places[1].Files != 1 || places[1].Recent[0].Name != "Contract.pdf" {
		t.Fatalf("the documents were not found where the system says they are: %+v", places[1])
	}
	if got, _, err := notchFileOpen(roots, nil, "documents", "Contract.pdf"); err != nil || len(got) == 0 {
		t.Fatalf("a file was not handed over from where the system says the documents are: %v", err)
	}
}
