// Package notices carries the third-party license notices for the Go
// modules the sidecar and the installer link (#1166). Embedding them puts the
// text inside every artifact that ships either binary (npm packages, release
// archives, the macOS app, the installers) with no packaging step to forget.
package notices

import _ "embed"

// Text is THIRD_PARTY_NOTICES.md, verbatim.
//
//go:embed THIRD_PARTY_NOTICES.md
var Text string
