package main

import (
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// maxTarballBytes caps the download — the sidecar packages are tens of MB; a
// registry response claiming gigabytes is wrong or hostile.
const maxTarballBytes = 512 << 20

// downloadTarball streams the package tarball into workDir, hashing while it
// writes, and fails unless the sha512 matches the registry's integrity value.
// fetchLatestRelease already required the tarball URL to be HTTPS.
func downloadTarball(rel *pkgRelease, workDir string) (string, error) {
	resp, err := httpClient.Get(rel.TarballURL)
	if err != nil {
		return "", fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download returned %s", resp.Status)
	}

	dst := filepath.Join(workDir, "payload.tgz")
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	h := sha512.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxTarballBytes+1))
	closeErr := f.Close()
	if err != nil {
		return "", fmt.Errorf("download interrupted: %w", err)
	}
	if closeErr != nil {
		return "", closeErr
	}
	if n > maxTarballBytes {
		return "", fmt.Errorf("tarball exceeds %d bytes — refusing", int64(maxTarballBytes))
	}

	want, err := base64.StdEncoding.DecodeString(rel.SHA512)
	if err != nil {
		return "", fmt.Errorf("registry integrity value is not valid base64: %w", err)
	}
	got := h.Sum(nil)
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return "", fmt.Errorf("sha512 mismatch for %s@%s — refusing the payload", rel.Name, rel.Version)
	}
	return dst, nil
}
