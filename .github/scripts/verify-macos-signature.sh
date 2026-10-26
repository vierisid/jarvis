#!/usr/bin/env bash
# Check a signed macOS release artifact the way its users will (#921).
#
# Run by verify-sidecar-darwin (sidecar-release.yml) and verify-macos
# (installer-release.yml), jobs that hold no secret and no id-token, on the
# bytes that ship. The signer runs codesign --verify too, but that only says
# the seal is intact: it accepts a signature by ANY identity, so a signer
# that imported the wrong certificate would pass it. This asserts what the
# clients assert:
#   * codesign --verify --deep --strict, with the requirement the sidecar
#     self-updater pins (internal/update/platform_darwin.go):
#       anchor apple generic and certificate leaf[subject.OU] = "<team>"
#   * the TeamIdentifier codesign reports is exactly APPLE_TEAM_ID;
#   * a notarization ticket is stapled (xcrun stapler validate);
#   * Gatekeeper accepts it (spctl --assess), as an app to execute or, for
#     the DMG, a disk image to open, and says so as a notarized Developer ID
#     (source=Notarized Developer ID): spctl also exits 0 when assessments
#     are turned off on the host, saying override=security disabled, which
#     would check nothing (#921 review).
# For the DMG, the app inside is checked the same way: it is what runs.
#
# Usage: verify-macos-signature.sh app <path to the .app>
#        verify-macos-signature.sh dmg <path to the .dmg>
# Environment: APPLE_TEAM_ID, the Developer ID team. Its emptiness is decided
# before this runs, by require-signing-pin.sh in the same step (a real run
# fails on an empty pin unless ALLOW_UNPINNED_MACOS is exactly true, #922);
# empty here, only the team assertions are skipped, with a warning, and the
# artifact must still carry a team (no ad hoc signature).
set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 2 ] || { [ "$1" != app ] && [ "$1" != dmg ]; }; then
	echo "::error::usage: verify-macos-signature.sh app|dmg <path>"
	exit 2
fi
kind="$1"
target="$2"
team="${APPLE_TEAM_ID:-}"
# It is spliced into a requirement string, so it is a team id or nothing.
if [ -n "$team" ] && ! [[ "$team" =~ ^[A-Z0-9]{10}$ ]]; then
	echo "::error::APPLE_TEAM_ID is not a ten-character Apple team id"
	exit 1
fi
if [ ! -e "$target" ] || [ -L "$target" ]; then
	echo "::error::${target} is missing or a link"
	exit 1
fi
work="$(mktemp -d)"
mnt=""
cleanup() {
	if [ -n "$mnt" ]; then hdiutil detach -quiet "$mnt" || hdiutil detach -force -quiet "$mnt" || true; fi
	rm -rf "$work"
}
trap cleanup EXIT

# check <path> <execute|open>
check() {
	local path="$1" type="$2" got
	local args=(--verify --strict --verbose=2)
	if [ "$type" = execute ]; then args+=(--deep); fi
	if [ -n "$team" ]; then
		args+=("-R=anchor apple generic and certificate leaf[subject.OU] = \"${team}\"")
	else
		echo "::warning::APPLE_TEAM_ID is empty, so ${path} is checked for a valid Developer ID signature by any team, not ours."
	fi
	codesign "${args[@]}" "$path"
	# codesign -d writes its report to stderr.
	codesign -dv --verbose=2 "$path" 2>"${work}/info"
	got="$(sed -n 's/^TeamIdentifier=//p' "${work}/info")"
	if [ -z "$got" ] || [ "$got" = "not set" ]; then
		echo "::error::${path} carries no team identifier: it is unsigned or ad hoc signed"
		exit 1
	fi
	if [ -n "$team" ] && [ "$got" != "$team" ]; then
		printf '::error::%s is signed by team %q, not APPLE_TEAM_ID %s\n' "$path" "$got" "$team"
		exit 1
	fi
	xcrun stapler validate "$path"
	if [ "$type" = execute ]; then
		spctl --assess --type execute -vv "$path" >"${work}/spctl" 2>&1 || { cat "${work}/spctl"; exit 1; }
	else
		spctl --assess --type open --context context:primary-signature -vv "$path" >"${work}/spctl" 2>&1 || { cat "${work}/spctl"; exit 1; }
	fi
	cat "${work}/spctl"
	if ! grep -qx 'source=Notarized Developer ID' "${work}/spctl"; then
		echo "::error::Gatekeeper did not accept ${path} as a notarized Developer ID (see its answer above)"
		exit 1
	fi
	echo "${path}: Developer ID team ${got}, notarized and stapled"
}

if [ "$kind" = app ]; then
	if [ ! -d "$target" ]; then
		echo "::error::${target} is not an app bundle"
		exit 1
	fi
	check "$target" execute
	exit 0
fi

if [ ! -f "$target" ]; then
	echo "::error::${target} is not a disk image"
	exit 1
fi
check "$target" open
# The volume holds the app at its root, as hdiutil create -srcfolder on the
# app makes it (measured on the published Install-Jarvis.dmg).
mkdir "${work}/mnt"
mnt="${work}/mnt"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mnt" "$target" >/dev/null
app="${mnt}/Install Jarvis.app"
if [ ! -d "$app" ] || [ -L "$app" ]; then
	echo "::error::the disk image holds no Install Jarvis.app at its root"
	exit 1
fi
check "$app" execute
