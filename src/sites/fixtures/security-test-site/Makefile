.PHONY: dev build clean install

PORT ?= 3000

install:
	bun install

dev:
	BUN_PORT=$(PORT) bun --hot index.ts

build:
	bun build index.html --outdir=dist

clean:
	rm -rf dist node_modules
