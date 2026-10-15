#!/usr/bin/env bash
# Build the sidecar for one target. Called by sidecar-release.yml from the
# sidecar/ directory, once per target: by each of the four build-sidecar-<leg>
# jobs (#781), and by build-sidecar-windows, which is split from its signer so
# only the signer holds id-token (#682). One script, so the jobs cannot drift
# apart in how they build or pin.
#
# Inputs (environment, never interpolated into this text):
#   GOOS, GOARCH          target
#   SETUP                 linux | windows-cross | darwin
#   OUT                   output file name (jarvis or jarvis.exe)
#   SIGNING_PUBLISHER_CN  Authenticode publisher pin (windows-cross)
#   APPLE_TEAM_ID         Developer ID team pin (darwin)
set -euo pipefail
: "${GOOS:?}" "${GOARCH:?}" "${SETUP:?}" "${OUT:?}"
export CGO_ENABLED=1
LDFLAGS="-s -w -X main.sidecarVersion=$(cat VERSION)"
PIN=""
case "$SETUP" in
	windows-cross)
		export CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++
		CGO_CFLAGS="-I$(pwd)/include"
		CGO_CXXFLAGS="-I$(pwd)/include"
		export CGO_CFLAGS CGO_CXXFLAGS
		# GUI subsystem: no console window when the .exe is launched.
		LDFLAGS="$LDFLAGS -H windowsgui"
		PIN="${SIGNING_PUBLISHER_CN:-}"
		# The go tool splits -ldflags on whitespace, so the CN (a company
		# name, always with spaces) carries its own quotes to the linker.
		LDFLAGS="$LDFLAGS -X 'github.com/jarvis/sidecar/internal/update.expectedPublisherCN=${PIN}'"
		;;
	darwin)
		if [ "$GOARCH" = "amd64" ]; then TARGET=x86_64-apple-macos11; else TARGET=arm64-apple-macos11; fi
		export CC="clang -target $TARGET" CXX="clang++ -target $TARGET"
		PIN="${APPLE_TEAM_ID:-}"
		LDFLAGS="$LDFLAGS -X 'github.com/jarvis/sidecar/internal/update.expectedTeamID=${PIN}'"
		;;
	linux) ;;
	*)
		echo "::error::unknown SETUP '$SETUP'"
		exit 1
		;;
esac
if [ "$SETUP" != "linux" ] && [ -z "${PIN}" ]; then
	echo "::warning::no signing pin for ${GOOS}; self-updates from this build will accept any validly signed payload."
fi
# -trimpath keeps -ldflags out of the embedded build info: without it
# the pin text is in the binary even when the -X target is wrong
# (a renamed variable), and the check below could never fail.
go build -trimpath -ldflags "$LDFLAGS" -o "$OUT" .
if [ -n "${PIN}" ]; then
	# Via a file, not a pipe: `grep -q` exiting early SIGPIPEs strings,
	# which pipefail would report as a missing pin.
	strings "$OUT" >/tmp/sidecar-strings.txt
	if ! grep -qF "${PIN}" /tmp/sidecar-strings.txt; then
		echo "::error::signing pin '${PIN}' is not present in the sidecar binary; check the -X path and the -ldflags quoting"
		exit 1
	fi
fi
