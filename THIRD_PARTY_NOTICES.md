# Third-Party Notices

## Scope

This file covers **third-party source vendored into this repository** -- code that ships in the Jarvis source tree at build time (today, just Activepieces under `src/workflows/activepieces/`). Each vendored project is distributed under its own license, reproduced below. The combined work (Jarvis) is distributed under the [Jarvis Source Available License 2.0](LICENSE); the third-party portions retain their original licenses for any party who extracts them as a standalone work.

**Not covered here:**

- **npm runtime dependencies** (e.g. `socket.io`, `nanoid`, `bun:sqlite`). These are listed in `package.json` and resolved into `node_modules` at install time; their licenses live next to the published packages and are not reproduced in this file.
- **Community Activepieces pieces** installed at runtime into `~/.jarvis/pieces/` from the curated catalog. Each piece carries its own license metadata; the catalog (`src/workflows/pieces-library/catalog.ts`) only lists semver pins, not vendored source.

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
