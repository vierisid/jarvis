package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Finding a bun/npm install hands the whole machine to that package manager,
// so detection has to be sure: a directory left behind after the package was
// removed must not keep refusing the native install.
func TestHasSidecarPackage(t *testing.T) {
	root := t.TempDir()
	pkg := filepath.Join(root, "@usejarvis", "sidecar")

	if hasSidecarPackage(root) {
		t.Error("found the package in an empty node_modules")
	}
	if err := os.MkdirAll(pkg, 0755); err != nil {
		t.Fatal(err)
	}
	if hasSidecarPackage(root) {
		t.Error("an empty leftover directory was taken for an installed package")
	}
	if err := os.WriteFile(filepath.Join(pkg, "package.json"), []byte(`{"name":"@usejarvis/sidecar"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if !hasSidecarPackage(root) {
		t.Error("an installed package (package.json present) was not found")
	}
}
