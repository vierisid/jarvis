package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPathWithin(t *testing.T) {
	root := canonicalPath(filepath.Join(t.TempDir(), "ssh"))
	cases := []struct {
		target string
		want   bool
	}{
		{root, true},
		{filepath.Join(root, "id_rsa"), true},
		{filepath.Join(root, "sub", "deep"), true},
		{root + "foo", false},       // prefix, not a child
		{filepath.Dir(root), false}, // parent
		{filepath.Join(root, "..", "x"), false},
	}
	for _, c := range cases {
		if got := pathWithin(canonicalPath(c.target), root); got != c.want {
			t.Errorf("pathWithin(%q, %q) = %v, want %v", c.target, root, got, c.want)
		}
	}
}

func TestIsBlockedPathNormalisesDotSegmentsAndTrailingSlash(t *testing.T) {
	base := t.TempDir()
	blocked := filepath.Join(base, ".ssh")
	if err := os.MkdirAll(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	list := []string{blocked + string(filepath.Separator)}
	for _, p := range []string{
		filepath.Join(base, ".ssh", "id_rsa"),
		filepath.Join(base, "docs", "..", ".ssh", "id_rsa"),
		filepath.Join(base, ".ssh", ".", "id_rsa"),
	} {
		if !isBlockedPath(p, list) {
			t.Errorf("%q should be blocked", p)
		}
	}
	if isBlockedPath(filepath.Join(base, ".sshfoo", "x"), list) {
		t.Error(".sshfoo must not match the .ssh entry")
	}
}

func TestIsBlockedPathFollowsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	base := t.TempDir()
	secret := filepath.Join(base, "secret")
	if err := os.MkdirAll(secret, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secret, "key"), []byte("k"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "innocent")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}
	list := []string{secret}

	// Reading through the link resolves to the blocked directory.
	if !isBlockedPath(filepath.Join(link, "key"), list) {
		t.Error("read through symlink must be blocked")
	}
	// Writing a NEW file through the link: the leaf does not exist yet, so the
	// existing ancestor (the link) must still be resolved.
	if !isBlockedPath(filepath.Join(link, "authorized_keys"), list) {
		t.Error("new file under a symlinked dir must be blocked")
	}
	// A file-level symlink to a blocked file.
	fileLink := filepath.Join(base, "alias")
	if err := os.Symlink(filepath.Join(secret, "key"), fileLink); err != nil {
		t.Fatal(err)
	}
	if !isBlockedPath(fileLink, list) {
		t.Error("symlink to a blocked file must be blocked")
	}
	// The blocklist entry itself may be a symlink.
	if !isBlockedPath(filepath.Join(secret, "key"), []string{link}) {
		t.Error("a symlinked blocklist entry must resolve to its target")
	}
	// Unrelated paths stay open.
	if isBlockedPath(filepath.Join(base, "other", "file"), list) {
		t.Error("unrelated path must not be blocked")
	}
}

func TestIsBlockedPathCaseFolding(t *testing.T) {
	if !caseInsensitiveFS() {
		t.Skip("case folding only applies on case-insensitive platforms")
	}
	base := t.TempDir()
	if isBlockedPath(strings.ToUpper(filepath.Join(base, "SSH", "id")), []string{filepath.Join(base, "ssh")}) != true {
		t.Error("case variants must match on a case-insensitive filesystem")
	}
}

func TestIsBlockedPathIgnoresBlankEntries(t *testing.T) {
	if isBlockedPath("/anything", []string{"", "  "}) {
		t.Error("blank entries must not block everything")
	}
	if isBlockedPath("/anything", nil) {
		t.Error("empty list blocks nothing")
	}
}

func TestExpandHome(t *testing.T) {
	home := homeDir()
	if got := expandHome("~/.ssh"); got != filepath.Join(home, ".ssh") {
		t.Errorf("expandHome(~/.ssh) = %q", got)
	}
	if got := expandHome("~"); got != home {
		t.Errorf("expandHome(~) = %q", got)
	}
	if got := expandHome("/plain"); got != "/plain" {
		t.Errorf("expandHome(/plain) = %q", got)
	}
	if got := expandHome("~user/x"); got != "~user/x" {
		t.Errorf("other users' homes are not expanded: %q", got)
	}
}

func TestStripWindowsPathPrefix(t *testing.T) {
	cases := map[string]string{
		`\\?\C:\Users\u\.ssh\id`:  `C:\Users\u\.ssh\id`,
		`\??\C:\Users\u\.ssh\id`:  `C:\Users\u\.ssh\id`,
		`\\.\C:\Users\u\.ssh\id`:  `C:\Users\u\.ssh\id`,
		`\\?\UNC\srv\share\x`:     `\\srv\share\x`,
		`\\?\unc\srv\share\x`:     `\\srv\share\x`,
		`\\?\\\?\C:\x`:            `C:\x`,               // nested prefixes are peeled
		`//?/C:/Users/u/.ssh/id`:  `C:/Users/u/.ssh/id`, // forward-slash prefix form
		`\\?/C:\x`:                `C:\x`,
		`//?/UNC/srv/share/x`:     `\\srv/share/x`,
		`C:\Users\u\plain`:        `C:\Users\u\plain`,
		`\\srv\share\already-unc`: `\\srv\share\already-unc`,
		`/posix/style`:            `/posix/style`,
	}
	for in, want := range cases {
		if got := stripWindowsPathPrefix(in); got != want {
			t.Errorf("stripWindowsPathPrefix(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDefaultBlockedPathsCoverCredentialsAndPersistence(t *testing.T) {
	home := homeDir()
	paths := defaultBlockedPaths()
	want := []string{
		filepath.Join(home, ".jarvis", "sidecar.yaml"),
		filepath.Join(home, ".jarvis", "sidecar-keys"),
		filepath.Join(home, ".ssh"),
		filepath.Join(home, ".bashrc"),
		filepath.Join(home, ".config", "autostart"),
	}
	for _, w := range want {
		found := false
		for _, p := range paths {
			if canonicalPath(p) == canonicalPath(w) {
				found = true
			}
		}
		if !found {
			t.Errorf("default blocklist is missing %q", w)
		}
	}
	for _, p := range paths {
		if !strings.HasPrefix(p, "~/") && !filepath.IsAbs(p) {
			t.Errorf("default entry %q is neither ~/-relative nor absolute", p)
		}
	}
	// The working areas inside ~/.jarvis must stay editable.
	if isBlockedPath(filepath.Join(home, ".jarvis", "projects", "site", "index.html"), paths) {
		t.Error("site-builder projects must not be blocked by the defaults")
	}
	if !isBlockedPath(filepath.Join(home, ".jarvis", "captures", "2026-01-01", "x.png"), paths) {
		t.Error("captures must be blocked by the defaults")
	}
}
