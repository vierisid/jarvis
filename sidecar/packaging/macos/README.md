# macOS `.app` bundle

The macOS sidecar must run from inside a `.app` bundle: `UNUserNotificationCenter`
(the native notification API) is unavailable to a bare binary, and a bundle also
gives the menu-bar agent a stable identity + icon and the TCC usage strings it
needs once it's no longer borrowing its parent process's permissions.

## What's here

| File | Purpose |
|---|---|
| `Info.plist` | Bundle manifest — `com.jarvis.sidecar`, `LSUIElement` (menu-bar agent, no Dock icon), mic + AppleEvents usage strings. `__VERSION__` is filled in by the Makefile. |
| `entitlements.plist` | Hardened-runtime entitlements (mic, AppleEvents) applied when the bundle is Developer ID-signed for notarization. |
| `AppIcon.svg` | Vector source for the app icon (Monochrome Lab: ink tile, paper drop). |
| `AppIcon.png` | 1024×1024 raster of the SVG (committed so the icon step needs only Mac built-ins). |
| `make-icns.sh` | `AppIcon.png` → `AppIcon.icns` via `sips` + `iconutil` (run on a Mac). |

## Build (on a Mac — cgo needs the macOS SDK)

```bash
cd sidecar
make build                        # produces ./jarvis (native, cgo)
make build-ocr-helper             # optional: helpers/ocr-helper (Vision OCR)
packaging/macos/make-icns.sh      # optional: AppIcon.icns (else generic icon)
make app-macos                    # assembles dist/macos/Jarvis.app
```

`make app-macos` lays out:

```
Jarvis.app/Contents/
  MacOS/jarvis          the sidecar (must live here so it's bundle-associated)
  MacOS/ocr-helper      if helpers/ocr-helper was built (sits beside the binary)
  Resources/AppIcon.icns
  Info.plist
  PkgInfo
```

Override the inputs for a specific arch / output path (used by `npm-pack`):

```bash
make app-macos BIN=dist/darwin-arm64/jarvis APP_DIR=npm/darwin-arm64/bin/Jarvis.app
```

## Sign + notarize (required for real distribution)

An unsigned bundle can be tested locally, but notifications + TCC prompts are
reliable only when signed (and Gatekeeper needs notarization for other machines).
Release builds are signed and notarized in CI (`sidecar-release.yml`); the
credential setup lives in code-signing/macos-setup.md in the usejarvis-docs
repo. To reproduce it
manually, sign inside-out (nested Mach-Os first, never `--deep`) with the
hardened runtime:

```bash
APP=dist/macos/Jarvis.app
ID="Developer ID Application: <COMPANY> (<TEAMID>)"
codesign --force --options runtime --timestamp --sign "$ID" "$APP/Contents/MacOS/ocr-helper"
codesign --force --options runtime --timestamp \
  --entitlements packaging/macos/entitlements.plist --sign "$ID" "$APP"
ditto -c -k --keepParent "$APP" /tmp/Jarvis.zip
xcrun notarytool submit /tmp/Jarvis.zip --key <key.p8> --key-id <KEY_ID> --issuer <ISSUER_ID> --wait
xcrun stapler staple "$APP"
spctl --assess --type execute -vv "$APP"   # must say: accepted, Notarized Developer ID
```

## Runtime permissions (TCC)

As a bundle the sidecar prompts for its own permissions the first time it needs
them — grant these in System Settings › Privacy & Security:

- **Notifications** — requested on launch (`requestAuthorization`).
- **Microphone** — voice + wake word (`NSMicrophoneUsageDescription`).
- **Screen Recording** — ambient screen awareness (prompted at runtime, no plist key).
- **Accessibility** — global hotkeys (Ctrl+Space) (prompted at runtime).

## How it's launched

The npm `bin/jarvis` launcher (`npm/jarvis-sidecar/bin/jarvis`) prefers
`bin/Jarvis.app/Contents/MacOS/jarvis` on darwin when present, falling back to a
bare `bin/jarvis`. `make npm-pack` builds the `.app` into the darwin packages.
Running the inner binary directly still associates the process with the bundle,
so notifications work.
