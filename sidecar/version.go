package main

// sidecarVersion is the sidecar's own semantic version, decoupled from the
// brain's. It is the single source of truth held in the sibling VERSION file
// and injected at build time via:
//
//	go build -ldflags "-X main.sidecarVersion=$(cat VERSION)"
//
// (see the Makefile and .github/workflows/release.yml). When unset — local
// `go run`/`go build` without the ldflag — it stays "dev", which the brain
// treats as a never-blocked development build during the register handshake.
//
// Versioning discipline (enforced by the CI PR gate): any shipping sidecar code
// change bumps this at least a patch. patch = back-compatible bugfix/internal;
// minor = new sidecar capability older brains can ignore; major = breaking
// protocol/behaviour change. The brain enforces its own MIN/RECOMMENDED floors
// against this value — see src/sidecar/compat.ts.
var sidecarVersion = "dev"
