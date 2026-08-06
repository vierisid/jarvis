#!/usr/bin/env bash
# Authenticode-sign Windows PE files with DigiCert KeyLocker, via jsign.
#
# This is the ONE code path: both release workflows call it and so can you,
# locally. That is deliberate — the bugs that actually bite in signing are
# quoting and cleanup bugs in the shell around the signing call, and they are
# only catchable if CI and your laptop run the same script.
#
# jsign's DIGICERTONE storetype talks to KeyLocker over REST, so this needs no
# native library and no Windows machine: it signs happily from the mingw
# cross-compile job on ubuntu.
#
# Credentials (environment):
#   SM_API_KEY               DigiCert ONE API token                 (required)
#   SM_CLIENT_CERT_FILE_B64  base64 of the client-auth .p12         (required)
#   SM_CLIENT_CERT_PASSWORD  password for that .p12                 (required)
#   SM_KEYPAIR_ALIAS         keypair alias from KeyLocker           (required)
#   SM_HOST                  client-auth host; defaults to US prod.
#                            Demo accounts have their own host:
#                            https://clientauth.demo.one.digicert.com
#                            (demo certs are NOT publicly trusted — they prove
#                            the pipeline works, never ship what they sign)
#
# Knobs (environment):
#   JSIGN_JAR      use this jar instead of downloading (local runs / tests)
#   JSIGN_VERSION  version to download                 (default below)
#   JSIGN_SHA256   pinned checksum of that download
#   TSA_URL        timestamp authority                 (default: DigiCert)
#
# Usage: sign-windows.sh <file.exe> [more.exe ...]
set -euo pipefail

JSIGN_VERSION="${JSIGN_VERSION:-7.1}"
JSIGN_SHA256="${JSIGN_SHA256:-cfb48b07fdd2ee199bfc9e71d8dccdde67a799c4793602e446c7a101be62b3c4}"
SM_HOST="${SM_HOST:-https://clientauth.one.digicert.com}"
TSA_URL="${TSA_URL:-http://timestamp.digicert.com}"

# fail emits a GitHub annotation under Actions and a plain message elsewhere,
# so the same script reads well in both places.
fail() {
	if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
		echo "::error::$*" >&2
	else
		echo "error: $*" >&2
	fi
	exit 1
}

# Everything registered here is removed on ANY exit path — a `set -e` abort
# between writing the client certificate and signing must not leave private
# credentials on the runner.
CLEANUP=()
cleanup() {
	if [ "${#CLEANUP[@]}" -gt 0 ]; then
		rm -f "${CLEANUP[@]}"
	fi
	return 0
}
trap cleanup EXIT

[ "$#" -ge 1 ] || fail "usage: $(basename "$0") <file.exe> [more.exe ...]"

for v in SM_API_KEY SM_CLIENT_CERT_FILE_B64 SM_CLIENT_CERT_PASSWORD SM_KEYPAIR_ALIAS; do
	[ -n "${!v:-}" ] || fail "$v is required (see the internal code-signing runbook)"
done

# jsign packs three fields into --storepass separated by '|'. A credential
# containing that character would silently corrupt the other fields and fail
# with an unrelated-looking auth error, so refuse it up front.
case "${SM_API_KEY}${SM_CLIENT_CERT_PASSWORD}" in
*"|"*)
	fail "SM_API_KEY / SM_CLIENT_CERT_PASSWORD must not contain '|' — jsign uses it as the storepass field separator; regenerate the credential"
	;;
esac

for f in "$@"; do
	[ -f "$f" ] || fail "file not found: $f"
done

# Pinned checksum: jsign runs with live signing credentials in hand, so an
# unverified download is never acceptable here.
if [ -n "${JSIGN_JAR:-}" ]; then
	jar="${JSIGN_JAR}"
	[ -f "$jar" ] || fail "JSIGN_JAR=$jar does not exist"
else
	jar="$(mktemp "${TMPDIR:-/tmp}/jsign-XXXXXX.jar")"
	CLEANUP+=("$jar")
	curl -fsSL -o "$jar" \
		"https://github.com/ebourg/jsign/releases/download/${JSIGN_VERSION}/jsign-${JSIGN_VERSION}.jar"
	echo "${JSIGN_SHA256}  ${jar}" | sha256sum -c - >/dev/null ||
		fail "jsign ${JSIGN_VERSION} checksum mismatch — refusing to run it"
fi

# KeyLocker authenticates with the API token AND a client certificate.
# mktemp creates at 0600; keep it that way and register it for cleanup before
# anything is written into it.
p12="$(mktemp "${TMPDIR:-/tmp}/sm_client_cert-XXXXXX.p12")"
CLEANUP+=("$p12")
chmod 600 "$p12"
printf '%s' "$SM_CLIENT_CERT_FILE_B64" | base64 -d >"$p12" ||
	fail "SM_CLIENT_CERT_FILE_B64 is not valid base64"

for f in "$@"; do
	echo "signing $f"
	# --storepass lands in this process's argv, visible in /proc on the local
	# machine. Acceptable on an ephemeral runner; do not run this on a shared
	# host with untrusted users.
	java -jar "$jar" \
		--storetype DIGICERTONE \
		--keystore "$SM_HOST" \
		--storepass "${SM_API_KEY}|${p12}|${SM_CLIENT_CERT_PASSWORD}" \
		--alias "$SM_KEYPAIR_ALIAS" \
		--tsaurl "$TSA_URL" \
		--tsmode RFC3161 \
		"$f"
done

echo "signed $# file(s) as '${SM_KEYPAIR_ALIAS}' via ${SM_HOST}"
