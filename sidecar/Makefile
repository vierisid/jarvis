MODULE   := github.com/jarvis/sidecar
VERSION  := 0.1.0
BIN_NAME := jarvis-sidecar
LDFLAGS  := -s -w

PLATFORMS := \
	darwin/arm64 \
	darwin/amd64 \
	linux/amd64 \
	linux/arm64 \
	windows/amd64

# Map Go os/arch to npm package names
npm_dir = $(subst darwin/arm64,darwin-arm64,$(subst darwin/amd64,darwin-x64,$(subst linux/amd64,linux-x64,$(subst linux/arm64,linux-arm64,$(subst windows/amd64,win32-x64,$1)))))

.PHONY: all build test vet clean dist npm-pack build-ocr-helper build-test dist-test

all: test build

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
		GOOS=$$os GOARCH=$$arch go build -tags sidecartest -ldflags "$(LDFLAGS)" \
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
		GOOS=$$os GOARCH=$$arch go build -ldflags "$(LDFLAGS)" \
			-o "dist/$${os}-$${arch}/$(BIN_NAME)$${ext}" . || exit 1; \
	done

# Copy binaries into npm platform packages and pack them
npm-pack: dist
	@if [ ! -f helpers/ocr-helper ]; then \
		echo "WARN: helpers/ocr-helper not built — darwin packages will ship without OCR (run 'make build-ocr-helper' on a Mac)"; \
	fi
	@# darwin-arm64
	mkdir -p npm/darwin-arm64/bin
	cp dist/darwin-arm64/$(BIN_NAME) npm/darwin-arm64/bin/
	@if [ -f helpers/ocr-helper ]; then cp helpers/ocr-helper npm/darwin-arm64/bin/; fi
	@# darwin-x64
	mkdir -p npm/darwin-x64/bin
	cp dist/darwin-amd64/$(BIN_NAME) npm/darwin-x64/bin/
	@if [ -f helpers/ocr-helper ]; then cp helpers/ocr-helper npm/darwin-x64/bin/; fi
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

# Update version across all package.json files
set-version:
	@if [ -z "$(V)" ]; then echo "Usage: make set-version V=0.2.0"; exit 1; fi
	@for f in npm/*/package.json; do \
		sed -i 's/"version": ".*"/"version": "$(V)"/' $$f; \
	done
	@sed -i 's/"@jarvis\/sidecar-\(.*\)": ".*"/"@jarvis\/sidecar-\1": "$(V)"/g' npm/jarvis-sidecar/package.json
	@echo "Version set to $(V)"
