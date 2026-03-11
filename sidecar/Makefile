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

.PHONY: all build test vet clean dist npm-pack

all: test build

build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN_NAME) .

test:
	go test -v ./...

vet:
	go vet ./...

clean:
	rm -f $(BIN_NAME) $(BIN_NAME).exe
	rm -rf dist
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
	@# darwin-arm64
	mkdir -p npm/darwin-arm64/bin
	cp dist/darwin-arm64/$(BIN_NAME) npm/darwin-arm64/bin/
	@# darwin-x64
	mkdir -p npm/darwin-x64/bin
	cp dist/darwin-amd64/$(BIN_NAME) npm/darwin-x64/bin/
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
