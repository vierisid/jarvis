# The toolchain image update-webview.yml's sealed build runs in (#1255).
#
# Built from no context (docker build - < this file), before any upstream
# code exists: the golang image of sidecar/go.mod's go line, by digest, plus
# what the native (GTK/WebKit, x11 for hotkeys_linux.go's #cgo pkg-config,
# #577) and windows (mingw) builds need, and patch for vendor-webview.sh.
# Only Debian's signed archive runs here. Upstream code then runs in
# containers of this image as the runner's uid, never as root, and the build
# itself with no network at all.
#
# The digest is the index digest of golang:1.25.0-bookworm, read from
# registry-1.docker.io on 2026-11-05. Bump it with sidecar/go.mod's go line;
# workflow-hardening.test.sh holds the two together.
FROM golang:1.25.0-bookworm@sha256:81dc45d05a7444ead8c92a389621fafabc8e40f8fd1a19d7e5df14e61e98bc1a
RUN set -eu; \
	export DEBIAN_FRONTEND=noninteractive; \
	apt-get update -qq; \
	apt-get install -y -qq --no-install-recommends \
		libwebkit2gtk-4.1-dev libgtk-3-dev pkg-config build-essential \
		libx11-dev libx11-xcb-dev libxcb1-dev \
		gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 patch >/dev/null; \
	rm -rf /var/lib/apt/lists/*; \
	for d in /usr/lib/*/pkgconfig; do \
		if [ -f "$d/webkit2gtk-4.1.pc" ]; then ln -sf "$d/webkit2gtk-4.1.pc" "$d/webkit2gtk-4.0.pc"; fi; \
		if [ -f "$d/javascriptcoregtk-4.1.pc" ]; then ln -sf "$d/javascriptcoregtk-4.1.pc" "$d/javascriptcoregtk-4.0.pc"; fi; \
	done
