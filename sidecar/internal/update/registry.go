package update

// npm registry client. The registry's abbreviated install metadata
// (Accept: application/vnd.npm.install-v1+json) carries exactly what we need:
// the dist-tags, per-version tarball URLs, and sha512 integrity. No npm
// client involved — two HTTPS GETs.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"
)

// DefaultRegistryURL is the only payload source release builds use.
const DefaultRegistryURL = "https://registry.npmjs.org"

// LatestTag asks ResolveRelease for whatever dist-tags.latest points at (the
// installer's behaviour). A self-updating sidecar passes an exact version.
const LatestTag = "latest"

// ErrVersionNotFound means the registry answered but does not (yet) carry
// the requested version, e.g. a brain released moments before its paired
// sidecar finished publishing. Callers treat it as "not available yet", not
// as a failure.
var ErrVersionNotFound = errors.New("version not published")

// PlatformPackage maps GOOS/GOARCH to the platform package suffix —
// mirrors the sidecar Makefile's npm_dir mapping.
func PlatformPackage() (string, error) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "darwin/arm64":
		return "darwin-arm64", nil
	case "darwin/amd64":
		return "darwin-x64", nil
	case "windows/amd64":
		return "win32-x64", nil
	case "linux/amd64":
		return "linux-x64", nil
	case "linux/arm64":
		return "linux-arm64", nil
	}
	return "", fmt.Errorf("unsupported platform %s/%s", runtime.GOOS, runtime.GOARCH)
}

// Release describes one published platform package.
type Release struct {
	Name       string // @usejarvis/sidecar-<platform>
	Version    string
	TarballURL string
	SHA512     string // base64, from dist.integrity ("sha512-<b64>")
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

// secureTarballURL requires HTTPS, excepting loopback (the test suite's fake
// registry) — sha512 pinning covers integrity either way; TLS is about not
// leaking what we fetch.
func secureTarballURL(raw string) bool {
	if strings.HasPrefix(raw, "https://") {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return u.Scheme == "http" && (host == "127.0.0.1" || host == "::1" || host == "localhost")
}

// ResolveRelease returns the tarball coordinates of this platform's package
// at version, which is either LatestTag (resolved through dist-tags) or an
// exact version. A version the registry does not carry wraps
// ErrVersionNotFound.
func ResolveRelease(registryBase, version string) (*Release, error) {
	if version != LatestTag && !ValidVersion(version) {
		return nil, fmt.Errorf("not a sidecar version: %q", version)
	}
	platform, err := PlatformPackage()
	if err != nil {
		return nil, err
	}
	name := "@usejarvis/sidecar-" + platform

	req, err := http.NewRequest("GET", strings.TrimRight(registryBase, "/")+"/"+name, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.npm.install-v1+json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("registry unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("registry returned %s for %s", resp.Status, name)
	}

	var meta struct {
		DistTags map[string]string `json:"dist-tags"`
		Versions map[string]struct {
			Dist struct {
				Tarball   string `json:"tarball"`
				Integrity string `json:"integrity"`
			} `json:"dist"`
		} `json:"versions"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&meta); err != nil {
		return nil, fmt.Errorf("registry metadata for %s: %w", name, err)
	}

	want := version
	if want == LatestTag {
		want = meta.DistTags[LatestTag]
		if want == "" {
			return nil, fmt.Errorf("no latest dist-tag for %s", name)
		}
	}
	v, ok := meta.Versions[want]
	if !ok {
		if version == LatestTag {
			return nil, fmt.Errorf("registry metadata for %s lacks version %s", name, want)
		}
		return nil, fmt.Errorf("%s@%s: %w", name, want, ErrVersionNotFound)
	}
	sha, ok := strings.CutPrefix(v.Dist.Integrity, "sha512-")
	if !ok {
		return nil, fmt.Errorf("unexpected integrity format %q for %s@%s (want sha512-…)", v.Dist.Integrity, name, want)
	}
	if !secureTarballURL(v.Dist.Tarball) {
		return nil, fmt.Errorf("refusing non-HTTPS tarball URL %q", v.Dist.Tarball)
	}
	return &Release{Name: name, Version: want, TarballURL: v.Dist.Tarball, SHA512: sha}, nil
}
