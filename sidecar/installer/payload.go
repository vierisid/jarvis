package main

// The payload pipeline (registry, download, extract, verify, swap) lives in
// internal/update, shared with the sidecar's self-update. These names keep the
// installer's flow reading as it always has.

import "github.com/jarvis/sidecar/internal/update"

type pkgRelease = update.Release

const (
	defaultRegistryURL       = update.DefaultRegistryURL
	minBundledSidecarVersion = update.MinBundledSidecarVersion
)

func init() { update.Logf = logf }

// fetchLatestRelease resolves dist-tags.latest: the installer always installs
// the newest published sidecar.
func fetchLatestRelease(registryURL string) (*pkgRelease, error) {
	return update.ResolveRelease(registryURL, update.LatestTag)
}

func versionLess(a, b string) bool { return update.VersionLess(a, b) }

func sidecarPackageManager() string { return update.InstalledPackageManager() }
