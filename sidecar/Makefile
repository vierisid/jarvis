MODULE   := github.com/jarvis/sidecar
# Single source of truth for the sidecar's own (brain-decoupled) version. The
# VERSION file is read here and injected into the binary via -X; CI asserts the
# `sidecar-v*` release tag matches it.
VERSION  := $(shell cat VERSION 2>/dev/null || echo dev)
# The installer is INDEPENDENT software: it resolves whichever sidecar the npm
# registry currently tags `latest` at run time and embeds no sidecar version,
# so it versions and ships on its own cadence. Never reuse VERSION here.
INSTALLER_VERSION := $(shell cat installer/VERSION 2>/dev/null || echo dev)
BIN_NAME := jarvis
LDFLAGS  := -s -w -X main.sidecarVersion=$(VERSION)

# macOS: build against the 11.0 deployment target (same as CI's
# `clang -target <arch>-apple-macos11`) so APIs that newer SDKs mark obsoleted --
# e.g. CGWindowListCreateImage, made unavailable in the macOS 15 SDK -- stay
# compilable. Without this, `make build` on a macOS 15+ host fails to build.
ifeq ($(shell uname),Darwin)
export MACOSX_DEPLOYMENT_TARGET := 11.0
endif

# Windows ships as a GUI-subsystem app (no console window): the cross-compile
# loops below append `-H windowsgui` to LDFLAGS when $$os = windows.

PLATFORMS := \
	darwin/arm64 \
	darwin/amd64 \
	linux/amd64 \
	linux/arm64 \
	windows/amd64

# Map Go os/arch to npm package names
npm_dir = $(subst darwin/arm64,darwin-arm64,$(subst darwin/amd64,darwin-x64,$(subst linux/amd64,linux-x64,$(subst linux/arm64,linux-arm64,$(subst windows/amd64,win32-x64,$1)))))

.PHONY: all build test vet clean dist npm-pack build-ocr-helper build-test dist-test manifest app-macos \
	build-installer manifest-installer app-macos-installer dmg-installer

# macOS .app bundle. Run on a Mac (cgo needs the macOS SDK). Wraps a built
# darwin binary so UNUserNotification works (unavailable to a bare binary) and
# the menu-bar agent gets a stable identity + icon. See packaging/macos/README.md.
#   make app-macos                                              # ./jarvis -> dist/macos/Jarvis.app
#   make app-macos BIN=dist/darwin-arm64/jarvis APP_DIR=...     # override inputs
BIN     ?= ./$(BIN_NAME)
APP_DIR ?= dist/macos/Jarvis.app
app-macos:
	@test -f "$(BIN)" || { echo "binary '$(BIN)' not found — run 'make build' on a Mac (or pass BIN=dist/darwin-arm64/jarvis)"; exit 1; }
	rm -rf "$(APP_DIR)"
	mkdir -p "$(APP_DIR)/Contents/MacOS" "$(APP_DIR)/Contents/Resources"
	cp "$(BIN)" "$(APP_DIR)/Contents/MacOS/$(BIN_NAME)"
	@if [ -f helpers/ocr-helper ]; then cp helpers/ocr-helper "$(APP_DIR)/Contents/MacOS/ocr-helper"; else echo "note: helpers/ocr-helper absent — OCR disabled in the bundle (make build-ocr-helper on a Mac)"; fi
	sed 's/__VERSION__/$(VERSION)/g' packaging/macos/Info.plist > "$(APP_DIR)/Contents/Info.plist"
	@if [ -f packaging/macos/AppIcon.icns ]; then cp packaging/macos/AppIcon.icns "$(APP_DIR)/Contents/Resources/AppIcon.icns"; else echo "note: AppIcon.icns absent — run packaging/macos/make-icns.sh on a Mac for a branded icon"; fi
	@printf 'APPL????' > "$(APP_DIR)/Contents/PkgInfo"
	@echo "Built $(APP_DIR) (version $(VERSION)). For distribution, sign inside-out (never --deep) + notarize — see packaging/macos/README.md"

# macOS installer app bundle: wraps a built installer binary (BIN_INSTALLER)
# as "Install Jarvis.app" with its own bundle id (com.jarvis.installer) so TCC
# and notarization identities never blur with the sidecar's. CI signs and
# notarizes the result, then wraps it in a DMG via dmg-installer.
BIN_INSTALLER     ?= ./jarvis-setup
INSTALLER_APP_DIR ?= dist/macos/Install Jarvis.app
app-macos-installer:
	@test -f "$(BIN_INSTALLER)" || { echo "binary '$(BIN_INSTALLER)' not found — run 'make build-installer' on a Mac first"; exit 1; }
	rm -rf "$(INSTALLER_APP_DIR)"
	mkdir -p "$(INSTALLER_APP_DIR)/Contents/MacOS" "$(INSTALLER_APP_DIR)/Contents/Resources"
	cp "$(BIN_INSTALLER)" "$(INSTALLER_APP_DIR)/Contents/MacOS/install-jarvis"
	sed 's/__VERSION__/$(INSTALLER_VERSION)/g' packaging/macos/Installer-Info.plist > "$(INSTALLER_APP_DIR)/Contents/Info.plist"
	@if [ -f packaging/macos/AppIcon.icns ]; then cp packaging/macos/AppIcon.icns "$(INSTALLER_APP_DIR)/Contents/Resources/AppIcon.icns"; else echo "note: AppIcon.icns absent — run packaging/macos/make-icns.sh for a branded icon"; fi
	@printf 'APPL????' > "$(INSTALLER_APP_DIR)/Contents/PkgInfo"
	@echo "Built $(INSTALLER_APP_DIR) (installer version $(INSTALLER_VERSION))"

# Wrap the (signed) installer app in a compressed DMG. CI signs + notarizes
# + staples the DMG afterwards; this target only assembles.
INSTALLER_DMG ?= dist/macos/Install-Jarvis.dmg
dmg-installer:
	@test -d "$(INSTALLER_APP_DIR)" || { echo "'$(INSTALLER_APP_DIR)' not found — run 'make app-macos-installer' first"; exit 1; }
	rm -f "$(INSTALLER_DMG)"
	hdiutil create -volname "Install Jarvis" -srcfolder "$(INSTALLER_APP_DIR)" -format UDZO -ov "$(INSTALLER_DMG)"
	@echo "Built $(INSTALLER_DMG)"

all: test build

# Regenerate the embedded Windows application manifest resource from
# jarvis.manifest. Go auto-links rsrc_windows_amd64.syso into windows/amd64
# builds. The manifest declares OS compatibility so the Program Compatibility
# Assistant doesn't flag the app as a (failed) installer. Requires mingw windres.
manifest:
	@# The version is substituted from VERSION so the resource cannot drift from
	@# the binary. A prerelease suffix (0.9.1-rc.1) is stripped for the numeric
	@# FILEVERSION, which must be four integers.
	@v="$(VERSION)"; vc="$$(echo "$$v" | sed 's/-.*//' | tr '.' ',')"; \
	sed -e "s/__VERSION_COMMA__/$$vc,0/g" -e "s/__VERSION__/$$v/g" jarvis.rc > .jarvis.rc.gen
	x86_64-w64-mingw32-windres --input .jarvis.rc.gen --output rsrc_windows_amd64.syso --output-format=coff
	@rm -f .jarvis.rc.gen

# Same, for the installer binary (icon + asInvoker manifest). CI runs this in
# the windows-cross job before building the installer.
manifest-installer:
	@v="$(INSTALLER_VERSION)"; vc="$$(echo "$$v" | sed 's/-.*//' | tr '.' ',')"; \
	sed -e "s/__VERSION_COMMA__/$$vc,0/g" -e "s/__VERSION__/$$v/g" \
	  installer/installer.rc > installer/.installer.rc.gen
	cd installer && x86_64-w64-mingw32-windres --input .installer.rc.gen --output rsrc_windows_amd64.syso --output-format=coff
	@rm -f installer/.installer.rc.gen

# Build the installer for the host platform: ./jarvis-setup(.exe), stamped
# with installer/VERSION (its own, independent of the sidecar's).
build-installer:
	go build -ldflags "-s -w -X main.installerVersion=$(INSTALLER_VERSION)" -o jarvis-setup$(shell go env GOEXE) ./installer/

build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN_NAME) .

# Build a sidecar with platform-test capabilities enabled. The `--test` flag on
# this binary runs checks that CI cannot run (Vision on macOS, WinRT on
# Windows, real screen capture). Ship to the target machine and invoke:
#   ./$(BIN_NAME)-test --test help
build-test:
	go build -tags sidecartest -ldflags "$(LDFLAGS)" -o $(BIN_NAME)-test .

# Cross-compile the test-enabled binary for every platform we ship. Useful
# when the host doing the build is not the host doing the platform validation.
dist-test:
	@for platform in $(PLATFORMS); do \
		os=$${platform%%/*}; \
		arch=$${platform##*/}; \
		ext=""; \
		[ "$$os" = "windows" ] && ext=".exe"; \
		echo "Building $$os/$$arch test-enabled..."; \
		lf="$(LDFLAGS)"; [ "$$os" = "windows" ] && lf="$$lf -H windowsgui"; \
		GOOS=$$os GOARCH=$$arch go build -tags sidecartest -ldflags "$$lf" \
			-o "dist/$${os}-$${arch}/$(BIN_NAME)-test$${ext}" . || exit 1; \
	done

# Build the macOS Vision OCR helper. Requires `swiftc` (Xcode CLT). Must be
# run on a Mac; cross-compiling Swift from other hosts is not supported.
# Without this binary present, macOS sidecars run with OCR disabled.
build-ocr-helper:
	@if ! command -v swiftc >/dev/null 2>&1; then \
		echo "swiftc not found — run this target on a Mac with Xcode command line tools installed"; \
		exit 1; \
	fi
	swiftc -O helpers/ocr-helper.swift -o helpers/ocr-helper

# Cross-compile tester binaries for all platforms and run unit tests.
test: vet
	@echo "=== Unit tests ==="
	go test -v ./...
	@echo ""
	@echo "=== Building tester binaries ==="
	@mkdir -p tester/bin
	@for platform in $(PLATFORMS); do \
		os=$${platform%%/*}; \
		arch=$${platform##*/}; \
		ext=""; \
		[ "$$os" = "windows" ] && ext=".exe"; \
		echo "  tester/$${os}_$${arch}$${ext}"; \
		GOOS=$$os GOARCH=$$arch go build -ldflags "$(LDFLAGS)" \
			-o "tester/bin/tester_$${os}_$${arch}$${ext}" ./tester/ || exit 1; \
	done
	@echo ""
	@echo "Tester binaries ready in tester/bin/"
	@ls -lh tester/bin/tester_*

vet:
	go vet ./...

clean:
	rm -f $(BIN_NAME) $(BIN_NAME).exe $(BIN_NAME)-test $(BIN_NAME)-test.exe
	rm -rf dist
	rm -f tester/bin/tester_*
	rm -f helpers/ocr-helper
	rm -f npm/*/*.tgz
	rm -rf npm/darwin-arm64/bin npm/darwin-x64/bin npm/linux-x64/bin npm/linux-arm64/bin npm/win32-x64/bin
	rm -f npm/jarvis-sidecar/*.tgz

# Cross-compile all platforms into dist/
dist: test vet
	@for platform in $(PLATFORMS); do \
		os=$${platform%%/*}; \
		arch=$${platform##*/}; \
		ext=""; \
		[ "$$os" = "windows" ] && ext=".exe"; \
		echo "Building $$os/$$arch..."; \
		lf="$(LDFLAGS)"; [ "$$os" = "windows" ] && lf="$$lf -H windowsgui"; \
		GOOS=$$os GOARCH=$$arch go build -ldflags "$$lf" \
			-o "dist/$${os}-$${arch}/$(BIN_NAME)$${ext}" . || exit 1; \
	done

# Copy binaries into npm platform packages and pack them
npm-pack: dist
	@if [ ! -f helpers/ocr-helper ]; then \
		echo "WARN: helpers/ocr-helper not built — darwin packages will ship without OCR (run 'make build-ocr-helper' on a Mac)"; \
	fi
	@# darwin-arm64 — ship the .app bundle (UNUserNotification needs it); the
	@# launcher runs bin/Jarvis.app/Contents/MacOS/jarvis. ocr-helper is placed
	@# beside the binary inside the bundle by app-macos.
	mkdir -p npm/darwin-arm64/bin
	rm -f npm/darwin-arm64/bin/$(BIN_NAME)
	$(MAKE) app-macos BIN=dist/darwin-arm64/$(BIN_NAME) APP_DIR=npm/darwin-arm64/bin/Jarvis.app
	@# darwin-x64
	mkdir -p npm/darwin-x64/bin
	rm -f npm/darwin-x64/bin/$(BIN_NAME)
	$(MAKE) app-macos BIN=dist/darwin-amd64/$(BIN_NAME) APP_DIR=npm/darwin-x64/bin/Jarvis.app
	@# linux-x64
	mkdir -p npm/linux-x64/bin
	cp dist/linux-amd64/$(BIN_NAME) npm/linux-x64/bin/
	@# linux-arm64
	mkdir -p npm/linux-arm64/bin
	cp dist/linux-arm64/$(BIN_NAME) npm/linux-arm64/bin/
	@# win32-x64
	mkdir -p npm/win32-x64/bin
	cp dist/windows-amd64/$(BIN_NAME).exe npm/win32-x64/bin/
	@# Pack all platform packages + main package
	@for dir in npm/darwin-arm64 npm/darwin-x64 npm/linux-x64 npm/linux-arm64 npm/win32-x64 npm/jarvis-sidecar; do \
		echo "Packing $$dir..."; \
		cd $$dir && npm pack && cd ../..; \
	done
	@echo "Done. Tarballs are in npm/*/*.tgz"

# Publish all packages to npm
npm-publish: npm-pack
	@for dir in npm/darwin-arm64 npm/darwin-x64 npm/linux-x64 npm/linux-arm64 npm/win32-x64; do \
		echo "Publishing $$dir..."; \
		cd $$dir && npm publish --access public && cd ../..; \
	done
	@echo "Publishing main package..."
	cd npm/jarvis-sidecar && npm publish --access public

# Update version across the VERSION file (source of truth) + all package.json
set-version:
	@if [ -z "$(V)" ]; then echo "Usage: make set-version V=0.2.0"; exit 1; fi
	@printf '%s\n' "$(V)" > VERSION
	@for f in npm/*/package.json; do \
		sed -i 's/"version": ".*"/"version": "$(V)"/' $$f; \
	done
	@sed -i 's/"@jarvis\/sidecar-\(.*\)": ".*"/"@jarvis\/sidecar-\1": "$(V)"/g' npm/jarvis-sidecar/package.json
	@echo "Version set to $(V)"
