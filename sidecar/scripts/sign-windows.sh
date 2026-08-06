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
#   SIGNING_PUBLISHER_CN         if set, every signature must carry this CN
#   SIGN_REQUIRE_TRUSTED_CHAIN   1 = also require the chain to verify locally
#                                (leave off for demo accounts: their root is
#                                not publicly trusted, so it never will)
#   CA_BUNDLE      CA file for verification (default: system bundle)
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
	# ${arr[@]+"${arr[@]}"} rather than a length test: bash 3.2 (still
	# /bin/bash on macOS) treats an empty array as unset under `set -u`, and a
	# local run should not die with "unbound variable" instead of the real
	# error. `return 0` keeps a no-op cleanup from touching the exit status.
	rm -f ${CLEANUP[@]+"${CLEANUP[@]}"}
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
	# Retry: a CDN blip must not fail a release whose binaries are already built.
	curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 -o "$jar" \
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
# The path becomes the middle storepass field, so it is subject to the same
# separator constraint as the credentials — a TMPDIR containing '|' would
# corrupt the split with an error as opaque as the one guarded above.
case "$p12" in
*"|"*) fail "temp directory path contains '|' ($p12) — set TMPDIR somewhere without it" ;;
esac
printf '%s' "$SM_CLIENT_CERT_FILE_B64" | base64 -d >"$p12" ||
	fail "SM_CLIENT_CERT_FILE_B64 is not valid base64"

# verify_signature asserts, after the fact, that the signature actually landed
# on THESE bytes and came from US.
#
# The correctness assertions read osslsigncode's OUTPUT rather than its exit
# status, because a perfectly good signature exits 1 whenever the chain cannot
# be built (an untrusted demo root, a runner without the CA, an
# OpenSSL/osslsigncode version skew) — so a bare `verify || fail` would break
# releases for reasons unrelated to the signature. Exit status is used only for
# the chain-trust verdict, where 0 genuinely means "everything verified".
#
# Every string matched below was observed from osslsigncode 2.9 signing a real
# mingw-built PE; in particular a cryptographically BROKEN signature still
# reports "Number of verified signatures: 1", so that line proves only that a
# signature exists — the CMS errors are what prove it is sound.
verify_signature() {
	local f="$1" out rc cn bundle
	if ! command -v osslsigncode >/dev/null 2>&1; then
		echo "warning: osslsigncode not installed — skipping post-sign verification of $f" >&2
		return 0
	fi

	# Distro-dependent CA bundle; without one osslsigncode can bail before it
	# prints anything useful. If none is found, verify without -CAfile: the
	# chain simply won't build, which the trust branch below already tolerates.
	bundle="${CA_BUNDLE:-}"
	if [ -z "$bundle" ]; then
		for candidate in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt \
			/etc/ssl/cert.pem /usr/local/etc/openssl/cert.pem; do
			[ -f "$candidate" ] && bundle="$candidate" && break
		done
	fi
	if [ -n "$bundle" ]; then
		out="$(osslsigncode verify -CAfile "$bundle" "$f" 2>&1)" && rc=0 || rc=$?
	else
		out="$(osslsigncode verify "$f" 2>&1)" && rc=0 || rc=$?
	fi

	# A signature must exist at all. NOTE: "Number of verified signatures" is a
	# count of signature SLOTS, not a verification result — a cryptographically
	# broken signature still reports 1 (verified against osslsigncode 2.9), so
	# this only rules out "unsigned", never "badly signed".
	case "$out" in
	*"Number of verified signatures: "[1-9]*) ;;
	*) fail "no Authenticode signature found on $f after signing" ;;
	esac

	# Real failure markers, each observed from osslsigncode 2.9:
	#   MISMATCH                  digest does not cover these bytes (tampered)
	#   CMS_verify error          signature blob does not verify cryptographically
	#   verification: failed      ditto, including the timestamp countersignature
	case "$out" in
	*MISMATCH*)
		fail "signature on $f does not cover its contents (digest MISMATCH)"
		;;
	*"CMS_verify error"* | *"verification: failed"* | *"verification failure"*)
		fail "signature on $f does not verify cryptographically — refusing to ship it"
		;;
	esac

	# An untimestamped signature stops validating the day the certificate
	# expires. Allowlist rather than denylist: require the positive marker, so
	# a future osslsigncode that simply omits the "not available" line cannot
	# produce a silent pass.
	case "$out" in
	*"Timestamp time:"*) ;;
	*) fail "$f carries no trusted timestamp — it would stop validating when the certificate expires" ;;
	esac

	# Publisher: the same identity the installer pins at runtime. Take the
	# FIRST CN on the Subject line, matching installer/certsubject.go — a
	# greedy match would anchor on the LAST /CN=, letting a DN that embeds
	# "/CN=<expected>" in a later RDN spoof the check.
	# awk exits after the first Subject line; no `head` in the pipeline, whose
	# early exit would return 141 under `set -o pipefail` and abort a release.
	cn="$(printf '%s\n' "$out" | awk -F'/CN=' '/Subject:/ {split($2, a, "/"); sub(/[ \t]+$/, "", a[1]); print a[1]; exit}')"
	if [ -n "${SIGNING_PUBLISHER_CN:-}" ]; then
		[ "$cn" = "$SIGNING_PUBLISHER_CN" ] ||
			fail "$f is signed by '${cn:-<unknown>}', expected '${SIGNING_PUBLISHER_CN}'"
	fi

	# Exit 0 means everything verified INCLUDING the certificate chain. That is
	# the strongest available assertion, but it cannot be required against a
	# demo account (its root is not publicly trusted) or on a machine without
	# the issuing CA — hence the opt-in.
	if [ "$rc" -eq 0 ]; then
		echo "verified $f — signed by '${cn:-?}', timestamped, chain trusted"
	else
		echo "verified $f — signed by '${cn:-?}', timestamped; chain NOT trusted by this machine (osslsigncode exit ${rc})" >&2
		[ "${SIGN_REQUIRE_TRUSTED_CHAIN:-0}" = "1" ] &&
			fail "SIGN_REQUIRE_TRUSTED_CHAIN=1 but osslsigncode did not fully verify $f (exit ${rc})"
	fi
	return 0
}

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
	verify_signature "$f"
done

echo "signed $# file(s) as '${SM_KEYPAIR_ALIAS}' via ${SM_HOST}"
