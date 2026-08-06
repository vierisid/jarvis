package main

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// maxUncompressedBytes caps what a payload may inflate to. The download cap
// is on the COMPRESSED stream, so without this a hostile registry — the very
// adversary the signature pin defends against — could serve a small tarball
// that inflates to hundreds of gigabytes and fill the disk before
// verification ever runs.
const maxUncompressedBytes = 1 << 30 // 1 GiB

// errPayloadRejected marks failures that mean "this payload is not
// acceptable" (guard violations, malformed archive) as opposed to local I/O
// failures — the caller maps the two to different exit codes.
type errPayloadRejected struct{ err error }

func (e errPayloadRejected) Error() string { return e.err.Error() }
func (e errPayloadRejected) Unwrap() error { return e.err }

func rejected(format string, args ...any) error {
	return errPayloadRejected{fmt.Errorf(format, args...)}
}

// extractPayload unpacks the npm tarball into destDir, keeping only the
// package's bin/ subtree (where the sidecar binary / Jarvis.app lives).
// Guards: entries must stay under destDir (no absolute paths, no ..),
// symlinks/hardlinks are rejected outright (nothing in our packages uses
// them, so any occurrence is hostile), and the inflated size is bounded.
// Exec bits are preserved (the .app's Mach-Os need them).
func extractPayload(tgzPath, destDir string) error {
	f, err := os.Open(tgzPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return rejected("bad gzip: %v", err)
	}
	defer gz.Close()

	// One budget across the whole archive: an over-long entry or an
	// over-large total both trip it.
	budget := &io.LimitedReader{R: gz, N: maxUncompressedBytes + 1}
	tr := tar.NewReader(budget)
	extracted := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			if budget.N <= 0 {
				return rejected("payload inflates beyond %d bytes — refusing", int64(maxUncompressedBytes))
			}
			return rejected("bad tar: %v", err)
		}
		if hdr.Size > maxUncompressedBytes {
			return rejected("tarball entry %q declares %d bytes — refusing", hdr.Name, hdr.Size)
		}

		// npm tarballs root everything at "package/"; we only ship bin/**.
		rel, ok := strings.CutPrefix(filepath.ToSlash(hdr.Name), "package/")
		if !ok || !strings.HasPrefix(rel, "bin/") {
			continue
		}
		clean := filepath.Clean(filepath.FromSlash(rel))
		if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
			return rejected("tarball entry escapes destination: %q", hdr.Name)
		}
		target := filepath.Join(destDir, clean)

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			mode := os.FileMode(hdr.Mode) & 0777
			if mode == 0 {
				mode = 0644
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				if budget.N <= 0 {
					return rejected("payload inflates beyond %d bytes — refusing", int64(maxUncompressedBytes))
				}
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
			extracted++
		default:
			return rejected("tarball contains refused entry type %q: %q", hdr.Typeflag, hdr.Name)
		}
	}
	if extracted == 0 {
		return rejected("tarball contained no package/bin/** files")
	}
	return nil
}
