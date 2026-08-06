package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A tarball whose entries inflate far beyond the cap must be refused before
// it can fill the disk — the download cap only bounds the COMPRESSED stream.
func TestExtractRejectsDecompressionBomb(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	// Highly compressible zero bytes: a few MB on disk, > 1 GiB inflated.
	chunk := make([]byte, 1<<20)
	entries := maxUncompressedBytes/int64(len(chunk)) + 8
	for i := int64(0); i < entries; i++ {
		hdr := &tar.Header{
			Name:     "package/bin/filler",
			Mode:     0644,
			Size:     int64(len(chunk)),
			Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()

	p := filepath.Join(t.TempDir(), "bomb.tgz")
	if err := os.WriteFile(p, buf.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("compressed bomb: %d bytes", buf.Len())

	err := extractPayload(p, t.TempDir())
	if err == nil {
		t.Fatal("decompression bomb accepted")
	}
	var rej errPayloadRejected
	if !errors.As(err, &rej) {
		t.Errorf("bomb should be classified as a payload rejection (exit 3), got %T: %v", err, err)
	}
}

// Guard violations classify as rejections (exit 3) so the frozen exit-code
// contract can distinguish them from local I/O failures (exit 5).
func TestGuardFailuresAreClassifiedAsRejections(t *testing.T) {
	cases := map[string][]tgzEntry{
		"traversal": {{name: "package/bin/../../evil", body: []byte("x")}},
		"symlink": {
			{name: "package/bin/jarvis", body: []byte("x"), mode: 0755},
			{name: "package/bin/link", typeflag: tar.TypeSymlink, linkname: "/etc/passwd"},
		},
		"empty": {{name: "package/package.json", body: []byte("{}")}},
	}
	for name, entries := range cases {
		err := extractPayload(writeTgz(t, entries), t.TempDir())
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		var rej errPayloadRejected
		if !errors.As(err, &rej) {
			t.Errorf("%s: got %T, want errPayloadRejected", name, err)
		}
	}
}
