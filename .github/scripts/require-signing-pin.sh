#!/usr/bin/env bash
# Refuse a real release whose signer pin is empty (#922).
#
# The installer and the sidecar self-updater link in the publisher whose
# payloads they will accept: SIGNING_PUBLISHER_CN (Authenticode CN) on
# Windows, APPLE_TEAM_ID (Developer ID team) on macOS. Empty, the client
# accepts a payload from ANY signer the operating system trusts
# (internal/update verifysig_windows.go and platform_darwin.go), and the
# post-sign check asserts no publisher. Both repository variables are set
# today; this is what keeps a deleted or renamed one from shipping that
# silently, where it used to be a warning in a green run.
#
# So, the shape #869 gave ALLOW_UNSIGNED_WINDOWS:
#   pin set              pass (and point out an escape hatch left set)
#   empty, dry run       warn and pass: a rehearsal needs no pin
#   empty, hatch "true"  warn and pass: shipping unpinned is a recorded choice
#   empty, otherwise     fail
# The hatch must be exactly the string true. Only "" is empty: clients treat
# exactly that as unpinned, and link anything else verbatim. So a pin that is
# not empty must also be well formed, on every run and whatever the hatch
# says (#922 review): no leading or trailing whitespace (a padded or
# whitespace-only pin pins nothing anyone signs as, and macOS would refuse
# every payload), nothing but printable ASCII (a no-break or zero-width
# space would pass a whitespace check), no quote or backslash (they break the
# -ldflags quoting, and APPLE_TEAM_ID is spliced into a codesign requirement
# string), and APPLE_TEAM_ID is a ten-character Apple team id.
#
# Usage: require-signing-pin.sh <pin variable> <escape hatch variable> <what is built>
#   require-signing-pin.sh SIGNING_PUBLISHER_CN ALLOW_UNPINNED_WINDOWS Jarvis-Setup.exe
#   require-signing-pin.sh APPLE_TEAM_ID ALLOW_UNPINNED_MACOS "Install Jarvis.app"
# The two variables are read by name from the environment, with DRY_RUN.
# Only those two pairs are accepted, so a caller cannot name some other
# variable as the hatch.
set -euo pipefail
# Byte-wise classes: under a UTF-8 locale [A-Z] can match non-ASCII capitals.
export LC_ALL=C

if [ "$#" -ne 3 ]; then
	echo "::error::usage: require-signing-pin.sh <pin variable> <escape hatch variable> <what is built>"
	exit 2
fi
pin_var="$1"
hatch_var="$2"
what="$3"
case "${pin_var}:${hatch_var}" in
SIGNING_PUBLISHER_CN:ALLOW_UNPINNED_WINDOWS | APPLE_TEAM_ID:ALLOW_UNPINNED_MACOS) ;;
*)
	echo "::error::require-signing-pin.sh does not know the pair ${pin_var} / ${hatch_var}"
	exit 2
	;;
esac
pin="${!pin_var:-}"
hatch="${!hatch_var:-}"

if [ -n "$pin" ]; then
	bad=""
	if [[ "$pin" =~ ^[[:space:]] || "$pin" =~ [[:space:]]$ ]]; then
		bad="it has leading or trailing whitespace"
	elif [[ "$pin" == *[\"\'\\]* ]] || ! [[ "$pin" =~ ^[\ -~]+$ ]]; then
		bad="it holds a quote, a backslash, or a character that is not printable ASCII"
	elif [ "$pin_var" = APPLE_TEAM_ID ] && ! [[ "$pin" =~ ^[A-Z0-9]{10}$ ]]; then
		bad="an Apple team id is ten upper-case letters and digits"
	fi
	if [ -n "$bad" ]; then
		echo "::error::${pin_var} is set but malformed (${bad}), so ${what} would be linked with a pin no signature matches. Fix the ${pin_var} repository variable."
		exit 1
	fi
	if [ "$hatch" = "true" ]; then
		echo "::warning::${hatch_var} is set but ${pin_var} is configured, so it changed nothing this run. Delete the variable, or the next empty ${pin_var} ships ${what} with no publisher pin instead of failing."
	fi
	exit 0
fi

consequence="${what} would accept a payload from any signer the operating system trusts"
if [ "${DRY_RUN:-}" = "true" ]; then
	echo "::warning::${pin_var} is empty, so ${consequence}. This dry run continues; a real release would stop here unless ${hatch_var} is true."
	exit 0
fi
if [ "$hatch" = "true" ]; then
	echo "::warning::${pin_var} is empty, so ${consequence}. Shipping it unpinned because ${hatch_var} is true."
	exit 0
fi
echo "::error::${pin_var} is empty, so ${consequence}. Set the ${pin_var} repository variable, or set the repository variable ${hatch_var} to true to ship unpinned on purpose."
exit 1
