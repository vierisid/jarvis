package main

import (
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeRegistry serves abbreviated npm metadata + the tarball for this
// platform's package name.
func fakeRegistry(t *testing.T, version string, tgz []byte, tamperIntegrity bool) *httptest.Server {
	t.Helper()
	platform, err := npmPlatformPackage()
	if err != nil {
		t.Skipf("platform unsupported: %v", err)
	}
	pkgPath := "/@usejarvis/sidecar-" + platform

	sum := sha512.Sum512(tgz)
	integrity := "sha512-" + base64.StdEncoding.EncodeToString(sum[:])
	if tamperIntegrity {
		integrity = "sha512-" + base64.StdEncoding.EncodeToString(make([]byte, sha512.Size))
	}

	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc(pkgPath, func(w http.ResponseWriter, r *http.Request) {
		meta := map[string]any{
			"dist-tags": map[string]string{"latest": version},
			"versions": map[string]any{
				version: map[string]any{
					"dist": map[string]string{
						"tarball":   srv.URL + pkgPath + "/-/pkg.tgz",
						"integrity": integrity,
					},
				},
			},
		}
		json.NewEncoder(w).Encode(meta)
	})
	mux.HandleFunc(pkgPath+"/-/pkg.tgz", func(w http.ResponseWriter, r *http.Request) {
		w.Write(tgz)
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchAndDownloadHappyPath(t *testing.T) {
	tgz := buildTgz(t, []tgzEntry{{name: "package/bin/jarvis", body: []byte("fake"), mode: 0755}})
	srv := fakeRegistry(t, "1.2.3", tgz, false)

	rel, err := fetchLatestRelease(srv.URL)
	if err != nil {
		t.Fatalf("fetchLatestRelease: %v", err)
	}
	if rel.Version != "1.2.3" {
		t.Errorf("version = %q, want 1.2.3", rel.Version)
	}
	path, err := downloadTarball(rel, t.TempDir())
	if err != nil {
		t.Fatalf("downloadTarball: %v", err)
	}
	if err := extractPayload(path, t.TempDir()); err != nil {
		t.Errorf("extract of downloaded payload: %v", err)
	}
}

func TestDownloadRejectsHashMismatch(t *testing.T) {
	tgz := buildTgz(t, []tgzEntry{{name: "package/bin/jarvis", body: []byte("fake"), mode: 0755}})
	srv := fakeRegistry(t, "1.2.3", tgz, true)

	rel, err := fetchLatestRelease(srv.URL)
	if err != nil {
		t.Fatalf("fetchLatestRelease: %v", err)
	}
	if _, err := downloadTarball(rel, t.TempDir()); err == nil {
		t.Fatal("tampered integrity accepted")
	}
}

func TestFetchRejectsMissingLatest(t *testing.T) {
	platform, err := npmPlatformPackage()
	if err != nil {
		t.Skipf("platform unsupported: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"dist-tags":{},"versions":{}}`)
	}))
	t.Cleanup(srv.Close)
	if _, err := fetchLatestRelease(srv.URL); err == nil {
		t.Fatalf("missing latest dist-tag accepted for %s", platform)
	}
}

func TestFetchRejectsRegistryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	if _, err := fetchLatestRelease(srv.URL); err == nil {
		t.Fatal("HTTP 500 accepted")
	}
}

func TestSecureTarballURL(t *testing.T) {
	cases := map[string]bool{
		"https://registry.npmjs.org/x/-/x.tgz": true,
		"http://127.0.0.1:8080/x.tgz":          true, // tests only
		"http://localhost:8080/x.tgz":          true,
		"http://evil.example.com/x.tgz":        false,
		"ftp://registry.npmjs.org/x.tgz":       false,
		"://bad":                               false,
	}
	for u, want := range cases {
		if got := secureTarballURL(u); got != want {
			t.Errorf("secureTarballURL(%q) = %v, want %v", u, got, want)
		}
	}
}
