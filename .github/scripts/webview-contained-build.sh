#!/usr/bin/env bash
#
# The part of update-webview.yml's build job that touches upstream code, run
# INSIDE containers of the toolchain image (webview-toolchain.Dockerfile),
# never on a host (#1255).
#
# That job re-vendors github.com/webview/webview_go at a new version and then
# compiles, vets and tests the sidecar against it, so it runs code nobody here
# has reviewed. It used to run on the host runner, which has passwordless sudo:
# with root, that code could read the job's Actions runtime token out of the
# runner process and write main-scoped cache entries at a key test.yml later
# restores (#1047). In the container it has no runner process, no token, no
# docker socket, no variable of the job, no root and no capabilities (the
# workflow runs it with --user, --cap-drop ALL and no-new-privileges), and one
# writable mount: a copy of the checkout in $RUNNER_TEMP, which the host then
# reads as data.
#
# Two phases, one container each:
#   fetch <version>  with network: re-vendor (download, copy, patch, tidy)
#                    and download every module the build needs into
#                    /work/.webview-gomodcache. Nothing here runs module code.
#   build            with --network none: vet, build and test against the
#                    vendored code, and the windows cross-build. This is where
#                    upstream code runs, with no network to fetch more or to
#                    reach anything the runner can reach.
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
	echo "refusing to run as root: the workflow passes --user" >&2
	exit 2
fi
[ -d /work/sidecar ] && [ -x /work/scripts/vendor-webview.sh ] || {
	echo "/work is not a copy of the repository" >&2
	exit 2
}

export HOME=/tmp/webview-build-home
mkdir -p "$HOME"
export GOMODCACHE=/work/.webview-gomodcache
# The image's Go, and no toolchain download a go or toolchain line could ask for.
export GOTOOLCHAIN=local
cd /work

case "${1:-}" in
fetch)
	version="${2:-}"
	# A Go module version: v, a digit, then [A-Za-z0-9.+_-] only. The check
	# job refused anything else already; this keeps the script safe alone.
	case "$version" in
	v[0-9]*) ;;
	*)
		echo "refusing version: '$version'" >&2
		exit 2
		;;
	esac
	case "$version" in
	*[!A-Za-z0-9.+_-]*)
		echo "refusing version: '$version'" >&2
		exit 2
		;;
	esac
	# A writable module cache, so the copy can be removed again by the uid
	# that owns it (Go writes it read-only by default).
	export GOFLAGS=-modcacherw
	scripts/vendor-webview.sh "$version"
	# Everything the build phase will need, for every platform go.mod lists.
	(cd sidecar && go mod download)
	;;
build)
	export GOPROXY=off GOFLAGS=-mod=readonly
	# The vendor script asserts every patch marker; these two are the ones
	# the job has always named.
	h=sidecar/third_party/webview_go/libs/webview/include/webview.h
	grep -q "PATCHED (jarvis)" "$h"
	grep -q "ShowWindow(m_window, SW_HIDE)" "$h"
	cd sidecar
	# Compatibility gate: linux/amd64 with cgo, the same set as test.yml's
	# sidecar-build.
	CGO_ENABLED=1 go vet ./...
	CGO_ENABLED=1 go build ./...
	CGO_ENABLED=1 go test ./...
	# The windows cross-build exercises the patched win32 path.
	GOOS=windows GOARCH=amd64 CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++ \
		CGO_CFLAGS="-I$(pwd)/include" CGO_CXXFLAGS="-I$(pwd)/include" \
		go build -o "$HOME/jarvis-sidecar.exe" .
	;;
*)
	echo "usage: webview-contained-build.sh fetch <version> | build" >&2
	exit 2
	;;
esac
