# Third-Party Notices

## Scope

This file is the index of the third-party notices for everything Jarvis distributes, and it reproduces the licenses of the **third-party source vendored into this repository**: Activepieces under `src/workflows/activepieces/` and Unicode's confusables mapping data in `src/authority/confusables-data.ts`. Each third-party project is distributed under its own license. The combined work (Jarvis) is distributed under the [Jarvis Source Available License 2.0](LICENSE); the third-party portions retain their original licenses for any party who extracts them as a standalone work.

The npm package (`@usejarvis/brain`) and the Docker image carry this file and the generated files below.

| What ships | Third-party code in it | Notices |
| --- | --- | --- |
| `src/` (npm package, Docker image) | Vendored Activepieces, Unicode confusables data | This file, below |
| `ui/dist`, the web UI bundle (npm package, Docker image) | The npm packages the UI build compiles in | [`THIRD_PARTY_NOTICES-ui.md`](THIRD_PARTY_NOTICES-ui.md), generated |
| The vendored pieces' bundles (`src/workflows/activepieces/packages/pieces/{jarvis,core}/*/dist`, npm package and Docker image) and the engine bundle (Docker image) | The npm packages of the engine staging install, among them LGPL-3.0 `openpgp` and MPL-2.0 `exifreader`, used unmodified | [`THIRD_PARTY_NOTICES-engine.md`](THIRD_PARTY_NOTICES-engine.md), generated, with the GPL-3.0 text the LGPL-3.0 refers to |
| `ui/public` (npm package, Docker image) | The ONNX runtime's WebAssembly, copied from its npm package | [Web UI assets](#web-ui-assets-uipublic), below |
| The sidecar and its installer (`@usejarvis/sidecar`, release archives, desktop installers) | Go modules, the Go standard library, and on Windows the MinGW-w64 runtime | Embedded in both binaries, which print it with `-third-party-notices`; the source is [`sidecar/internal/notices/THIRD_PARTY_NOTICES.md`](https://github.com/vierisid/jarvis/blob/main/sidecar/internal/notices/THIRD_PARTY_NOTICES.md), which the npm package and the Docker image do not carry |
| Hosted shared pieces tree | Community pieces and their dependencies | Generated per build (below) |

The two generated files list each package with its license and reproduce the license and notice files it ships. `bun run scripts/third-party-notices.ts` regenerates them; tests fail when the UI build compiles in a package the UI notices do not list, or when the engine staging lock pins a package the engine notices do not list, so neither can drift. `sidecar/internal/notices` is held to `sidecar/go.mod` the same way (`scripts/sidecar-notices.test.ts`).

**Not covered here:**

- **npm runtime dependencies installed next to the package** (e.g. `socket.io`, `nanoid`). An install from npm resolves them into `node_modules`, each with its own license files. Every package the locked install puts in `node_modules`, dev dependencies included (the Docker image ships them), is held to the same license policy as the pieces trees below by `scripts/check-root-licenses.ts`, which a test runs. The check allows no exceptions: the one former violation, `edge-tts-universal` (AGPL-3.0), was replaced by an in-repo Edge text-to-speech client (#1166). An install from npm resolves the version ranges afresh, so the check vouches for the locked versions only.
- **Community Activepieces pieces** installed at runtime into `~/.jarvis/pieces/` from the curated catalog. Each piece carries its own license metadata; the catalog (`src/workflows/pieces-library/catalog.ts`) only lists semver pins, not vendored source. Each install is checked against the same license policy as the hosted tree below, and a piece it denies is refused and removed (at install) or held: removed from `node_modules` and not loaded (at boot).

**Hosted shared pieces tree.** On hosted installs we build the community catalog once per version and run it for every tenant, so that tree is covered by its own generated file: `scripts/build-shared-runtime.ts` writes `<out>/pieces/THIRD_PARTY_NOTICES.md` next to it, listing every installed package with its license and reproducing the license and notice files each package ships. LGPL and MPL packages, used unmodified, are listed in their own section. The build refuses the tree when the license policy (`src/workflows/pieces-library/license-policy.ts`) denies any package in it: only permissive licenses, LGPL and MPL are allowed, and a package with no usable license declaration needs a reviewed entry. Pieces left out for that reason are listed, with the reason, in `src/workflows/pieces-library/catalog-overrides.ts`: `EXCLUDED` for pieces not offered anywhere (today Actual Budget, whose `@actual-app/core` dependency pulls GPL-3.0-only `hyperformula` and AGPL-3.0-or-later `ua-parser-js`), and `SHARED_BUILD_EXCLUDED` for pieces left out of the hosted tree only. The weekly catalog sync runs the same check first.

---

## Activepieces

- **Project:** Activepieces -- https://github.com/activepieces/activepieces
- **Vendored under:** `src/workflows/activepieces/`
- **Pinned commit:** `d04e6807c485ecd788a72af0d04abffba78563c7` (tag `0.82.1`)
- **Vendored portions:** MIT-licensed core only. The Activepieces Enterprise License directories (`packages/ee/**`, `packages/server/api/src/app/ee/**`) are explicitly excluded and never copied into this repository. See `src/workflows/activepieces/UPSTREAM.md` for details.

License (MIT):

```
MIT License

Copyright (c) 2022-present Activepieces Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Web UI assets (`ui/public`)

`bun run copy:models` (package.json, run on install and before publishing; the Docker build runs the same copy) puts these files from npm packages into `ui/public`, which the npm package and the Docker image ship and the brain serves to the browser. `UI_PUBLIC_ASSETS` in `src/workflows/pieces-library/bundle-notices.ts` records each one, and a test fails when `copy:models` copies an ONNX runtime file it does not record.

| File | Upstream | License |
| --- | --- | --- |
| `ort/ort-wasm-simd-threaded.wasm`, `ort/ort-wasm-simd-threaded.mjs`, `ort/ort-wasm-simd-threaded.jsep.wasm`, `ort/ort-wasm-simd-threaded.jsep.mjs` | ONNX Runtime Web (`onnxruntime-web`), https://github.com/microsoft/onnxruntime | MIT |

The `onnxruntime-web` package ships no license file (it is listed in `THIRD_PARTY_NOTICES-ui.md` too, since the UI bundle compiles in its JavaScript). Its license, from https://github.com/microsoft/onnxruntime:

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Unicode confusables data (UTS #39)

- **Project:** Unicode Security Mechanisms (UTS #39) -- https://www.unicode.org/reports/tr39/
- **Vendored under:** `src/authority/confusables-data.ts` (generated by `scripts/gen-confusables.ts`)
- **Source:** `confusables.txt`, Unicode 18.0.0, https://www.unicode.org/Public/18.0.0/security/confusables.txt (sha256 `6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92`)
- **Vendored portions:** the whole `MA` mapping table.

License (Unicode License v3):

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```
