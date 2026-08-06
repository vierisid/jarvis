package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

type tgzEntry struct {
	name     string
	body     []byte
	mode     int64
	typeflag byte
	linkname string
}

func buildTgz(t *testing.T, entries []tgzEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		tf := e.typeflag
		if tf == 0 {
			tf = tar.TypeReg
		}
		hdr := &tar.Header{Name: e.name, Mode: e.mode, Size: int64(len(e.body)), Typeflag: tf, Linkname: e.linkname}
		if e.mode == 0 {
			hdr.Mode = 0644
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if len(e.body) > 0 {
			if _, err := tw.Write(e.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func writeTgz(t *testing.T, entries []tgzEntry) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "p.tgz")
	if err := os.WriteFile(p, buildTgz(t, entries), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExtractHappyPath(t *testing.T) {
	tgz := writeTgz(t, []tgzEntry{
		{name: "package/package.json", body: []byte("{}")},
		{name: "package/bin/jarvis.exe", body: []byte("MZ fake"), mode: 0755},
		{name: "package/bin/Jarvis.app/Contents/MacOS/jarvis", body: []byte("#!fake"), mode: 0755},
	})
	dest := t.TempDir()
	if err := extractPayload(tgz, dest); err != nil {
		t.Fatalf("extract: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "bin", "jarvis.exe")); err != nil {
		t.Errorf("missing extracted exe: %v", err)
	}
	fi, err := os.Stat(filepath.Join(dest, "bin", "Jarvis.app", "Contents", "MacOS", "jarvis"))
	if err != nil {
		t.Fatalf("missing bundle binary: %v", err)
	}
	if fi.Mode().Perm()&0100 == 0 {
		t.Error("exec bit lost on bundle binary")
	}
	if _, err := os.Stat(filepath.Join(dest, "package.json")); err == nil {
		t.Error("non-bin file extracted; only bin/** should land")
	}
}

func TestExtractRejectsTraversal(t *testing.T) {
	tgz := writeTgz(t, []tgzEntry{
		{name: "package/bin/../../evil", body: []byte("x")},
	})
	if err := extractPayload(tgz, t.TempDir()); err == nil {
		t.Fatal("path traversal accepted")
	}
}

func TestExtractRejectsSymlinks(t *testing.T) {
	tgz := writeTgz(t, []tgzEntry{
		{name: "package/bin/jarvis", body: []byte("x"), mode: 0755},
		{name: "package/bin/link", typeflag: tar.TypeSymlink, linkname: "/etc/passwd"},
	})
	if err := extractPayload(tgz, t.TempDir()); err == nil {
		t.Fatal("symlink entry accepted")
	}
}

func TestExtractRejectsEmptyPayload(t *testing.T) {
	tgz := writeTgz(t, []tgzEntry{
		{name: "package/package.json", body: []byte("{}")},
	})
	if err := extractPayload(tgz, t.TempDir()); err == nil {
		t.Fatal("payload without bin/** accepted")
	}
}
