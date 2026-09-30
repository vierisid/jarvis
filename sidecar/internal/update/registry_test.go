package update

import (
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeRegistry serves abbreviated npm metadata + the tarball for this
// platform's package name.
func fakeRegistry(t *testing.T, version string, tgz []byte, tamperIntegrity bool) *httptest.Server {
	t.Helper()
	platform, err := PlatformPackage()
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

	rel, err := ResolveRelease(srv.URL, LatestTag)
	if err != nil {
		t.Fatalf("ResolveRelease: %v", err)
	}
	if rel.Version != "1.2.3" {
		t.Errorf("version = %q, want 1.2.3", rel.Version)
	}
	path, err := Download(rel, t.TempDir())
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if err := Extract(path, t.TempDir()); err != nil {
		t.Errorf("extract of downloaded payload: %v", err)
	}
}

func TestDownloadRejectsHashMismatch(t *testing.T) {
	tgz := buildTgz(t, []tgzEntry{{name: "package/bin/jarvis", body: []byte("fake"), mode: 0755}})
	srv := fakeRegistry(t, "1.2.3", tgz, true)

	rel, err := ResolveRelease(srv.URL, LatestTag)
	if err != nil {
		t.Fatalf("ResolveRelease: %v", err)
	}
	if _, err := Download(rel, t.TempDir()); err == nil {
		t.Fatal("tampered integrity accepted")
	}
}

func TestFetchRejectsMissingLatest(t *testing.T) {
	platform, err := PlatformPackage()
	if err != nil {
		t.Skipf("platform unsupported: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"dist-tags":{},"versions":{}}`)
	}))
	t.Cleanup(srv.Close)
	if _, err := ResolveRelease(srv.URL, LatestTag); err == nil {
		t.Fatalf("missing latest dist-tag accepted for %s", platform)
	}
}

func TestFetchRejectsRegistryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	if _, err := ResolveRelease(srv.URL, LatestTag); err == nil {
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

// A self-updating sidecar asks for the exact version its brain ships with,
// not whatever `latest` says: a brain a few hours behind must not be handed a
// sidecar newer than it knows.
func TestResolveExactVersion(t *testing.T) {
	tgz := buildTgz(t, []tgzEntry{{name: "package/bin/jarvis", body: []byte("fake"), mode: 0755}})
	srv := fakeRegistry(t, "1.2.3", tgz, false)

	rel, err := ResolveRelease(srv.URL, "1.2.3")
	if err != nil {
		t.Fatalf("ResolveRelease: %v", err)
	}
	if rel.Version != "1.2.3" {
		t.Errorf("version = %q, want 1.2.3", rel.Version)
	}
}

// A version the registry does not carry yet (the brain published before its
// paired sidecar) is ErrVersionNotFound, which the updater treats as "retry
// later" rather than as a failure.
func TestResolveMissingExactVersion(t *testing.T) {
	tgz := buildTgz(t, []tgzEntry{{name: "package/bin/jarvis", body: []byte("fake"), mode: 0755}})
	srv := fakeRegistry(t, "1.2.3", tgz, false)

	_, err := ResolveRelease(srv.URL, "1.3.0")
	if !errors.Is(err, ErrVersionNotFound) {
		t.Fatalf("err = %v, want ErrVersionNotFound", err)
	}
}

// Only a canonical version is looked up: "v1.2.3" or "1.2.3 " would miss the
// registry key and read as "not published yet" forever.
func TestResolveRejectsNonCanonicalVersion(t *testing.T) {
	tgz := buildTgz(t, []tgzEntry{{name: "package/bin/jarvis", body: []byte("fake"), mode: 0755}})
	srv := fakeRegistry(t, "1.2.3", tgz, false)
	for _, v := range []string{"v1.2.3", "1.2.3 ", "1.2.3+b", ""} {
		if _, err := ResolveRelease(srv.URL, v); err == nil || errors.Is(err, ErrVersionNotFound) {
			t.Errorf("ResolveRelease(%q) = %v, want a validation error", v, err)
		}
	}
}
