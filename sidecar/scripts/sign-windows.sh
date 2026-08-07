#!/usr/bin/env bash
# Authenticode-sign Windows PE files with a Google Cloud KMS (Cloud HSM) key,
# via jsign.
#
# This is the ONE code path: both release workflows call it and so can you,
# locally. That is deliberate — the bugs that actually bite in signing are
# quoting and cleanup bugs in the shell around the signing call, and they are
# only catchable if CI and your laptop run the same script.
#
# jsign's GOOGLECLOUD storetype talks to Cloud KMS over its REST API, so this
# needs no native library, no PKCS#11 module and no Windows machine: it signs
# happily from the mingw cross-compile job on ubuntu.
#
# The private key lives in a Cloud HSM key we own and never leaves it; the
# certificate over it is an OV code-signing cert issued by Sectigo against a
# CSR from that key ("install on existing HSM"). Because Cloud KMS stores ONLY
# the key, the certificate chain has to be supplied separately — hence
# CODESIGN_CERT_FILE, which is not a secret.
#
# Credentials (environment):
#   GCP_KMS_KEYRING   full keyring path, projects/<p>/locations/<l>/keyRings/<r>
#                     (required — jsign validates this exact shape)
#   GCP_KMS_KEY_ALIAS key name inside that keyring, optionally pinned to a
#                     version: <key>/cryptoKeyVersions/1  (required)
#                     Without the suffix jsign picks an arbitrary ENABLED
#                     version, so pin it — a rotation would otherwise silently
#                     sign with a key the certificate does not cover.
#   GCP_ACCESS_TOKEN  OAuth access token for Cloud KMS. If unset, taken from
#                     `gcloud auth print-access-token` when gcloud is present.
#                     In CI this comes from google-github-actions/auth via
#                     Workload Identity Federation — keyless, no stored secret.
#
# Knobs (environment):
#   CODESIGN_CERT_FILE  PEM holding the full certificate chain (leaf first).
#                       Defaults to packaging/windows/codesign-chain.pem next
#                       to this script. PUBLIC data — commit it.
#   SIGNING_PUBLISHER_CN         if set, every signature must carry this CN
#   SIGN_REQUIRE_TRUSTED_CHAIN   1 (default) = also require the chain to verify
#                                locally. Sectigo's roots are publicly trusted,
#                                so a release must never relax this; set 0 only
#                                when experimenting with a self-signed cert.
#   CA_BUNDLE      CA file for verification (default: system bundle)
#   JSIGN_JAR      use this jar instead of downloading (local runs / tests)
#   JSIGN_VERSION  version to download                 (default below)
#   JSIGN_SHA256   pinned checksum of that download
#   TSA_URL        timestamp authority                 (default: Sectigo)
#
# Usage: sign-windows.sh <file.exe> [more.exe ...]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JSIGN_VERSION="${JSIGN_VERSION:-7.1}"
JSIGN_SHA256="${JSIGN_SHA256:-cfb48b07fdd2ee199bfc9e71d8dccdde67a799c4793602e446c7a101be62b3c4}"
# Sectigo's public TSA, matching the issuing CA: free, unauthenticated, no
# quota, and its root is in every Windows trust store. The TSA is independent
# of the signing CA — DigiCert's would work just as well — but keeping it with
# the issuer means one vendor to check when a timestamp starts failing.
TSA_URL="${TSA_URL:-http://timestamp.sectigo.com}"
# Strict by default: with a publicly trusted Sectigo chain there is no longer a
# legitimate reason for local verification to fail, so a failure is a defect.
SIGN_REQUIRE_TRUSTED_CHAIN="${SIGN_REQUIRE_TRUSTED_CHAIN:-1}"
CODESIGN_CERT_FILE="${CODESIGN_CERT_FILE:-${HERE}/../packaging/windows/codesign-chain.pem}"

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

# Everything registered here is removed on ANY exit path. Nothing secret is
# written to disk any more (the key is in Cloud HSM and the token stays in the
# environment), but the downloaded jar still has to go, and a `set -e` abort
# mid-run must not leave it behind.
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

# The access token is the one credential, and it is derivable locally: a
# developer with gcloud logged in should not have to export anything.
# gcloud's own stderr is kept: the overwhelmingly common local failure is
# "no active account", and reporting only "GCP_ACCESS_TOKEN is required" would
# send someone to set a variable when the fix is `gcloud auth login`.
gcloud_err=""
if [ -z "${GCP_ACCESS_TOKEN:-}" ] && command -v gcloud >/dev/null 2>&1; then
	if ! GCP_ACCESS_TOKEN="$(gcloud auth print-access-token 2>"${TMPDIR:-/tmp}/gcloud-err.$$")"; then
		GCP_ACCESS_TOKEN=""
		gcloud_err="$(cat "${TMPDIR:-/tmp}/gcloud-err.$$" 2>/dev/null || true)"
	fi
	rm -f "${TMPDIR:-/tmp}/gcloud-err.$$"
fi

for v in GCP_KMS_KEYRING GCP_KMS_KEY_ALIAS GCP_ACCESS_TOKEN; do
	if [ -z "${!v:-}" ]; then
		if [ "$v" = "GCP_ACCESS_TOKEN" ] && [ -n "$gcloud_err" ]; then
			fail "GCP_ACCESS_TOKEN is required and \`gcloud auth print-access-token\` failed: ${gcloud_err}"
		fi
		fail "$v is required (see code-signing/ci-pipeline.md in usejarvis-docs)"
	fi
done

# jsign rejects a keyring that is not exactly projects/<p>/locations/<l>/keyRings/<r>,
# but only after downloading the jar and starting a JVM, with a message that
# reads like a jsign bug rather than a typo in a repo variable. Mirror the
# check here — this is the shape of value people paste wrong (a full cryptoKey
# path, or the bare keyring name from the console). The pattern is jsign's own
# (KeyStoreType.GOOGLECLOUD.validate in the pinned 7.1 jar).
[[ "$GCP_KMS_KEYRING" =~ ^projects/[^/]+/locations/[^/]+/keyRings/[^/]+$ ]] ||
	fail "GCP_KMS_KEYRING must be projects/<project>/locations/<location>/keyRings/<keyring> — got '$GCP_KMS_KEYRING' (the key name belongs in GCP_KMS_KEY_ALIAS)"

# Cloud KMS stores the private key ONLY, so jsign cannot discover the
# certificate: --certfile is mandatory. Fail on it here rather than letting a
# missing file surface as a Java stack trace — before the certificate is
# issued this is the expected state, and it must read as "the cert isn't there
# yet", not as a broken pipeline.
[ -f "$CODESIGN_CERT_FILE" ] ||
	fail "certificate chain not found at ${CODESIGN_CERT_FILE} — Cloud KMS holds only the private key, so the Sectigo chain PEM must be committed at sidecar/packaging/windows/codesign-chain.pem (or pointed at with CODESIGN_CERT_FILE). See code-signing/windows-setup.md in usejarvis-docs."
grep -q 'BEGIN CERTIFICATE' "$CODESIGN_CERT_FILE" ||
	fail "${CODESIGN_CERT_FILE} contains no PEM certificate — is it still the placeholder?"

for f in "$@"; do
	[ -f "$f" ] || fail "file not found: $f"
done

# Pinned checksum: jsign runs with a live signing token in hand, so an
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

# verify_signature asserts, after the fact, that the signature actually landed
# on THESE bytes and came from US.
#
# The correctness assertions read osslsigncode's OUTPUT rather than its exit
# status, because a perfectly good signature exits 1 whenever the chain cannot
# be built (a runner without the CA, an OpenSSL/osslsigncode version skew) —
# so a bare `verify || fail` would break releases for reasons unrelated to the
# signature. Exit status is used only for the chain-trust verdict, where 0
# genuinely means "everything verified".
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

	# Publisher: the same identity the installer pins at runtime.
	#
	# Two rules, both load-bearing:
	#   * FIRST Subject line only. Everything after it belongs to the
	#     timestamp authority's chain — matching those would assert the TSA's
	#     identity instead of ours.
	#   * FIRST CN component only, matching installer/certsubject.go. Taking
	#     the last would let a DN that embeds "CN=<expected>" in a later RDN
	#     spoof the check.
	#
	# The separator is version-dependent and both are in the wild:
	#   osslsigncode 2.9  -> /C=US/O=Org/CN=Name        (OpenSSL oneline)
	#   osslsigncode 2.13 -> C=US,O=Org,CN=Name         (RFC 2253)
	# Assuming either one silently yields an empty CN on the other, which
	# fails every release with "signed by '<unknown>'".
	#
	# awk exits after the first Subject line; no `head` in the pipeline, whose
	# early exit would return 141 under `set -o pipefail` and abort a release.
	cn="$(printf '%s\n' "$out" | awk '
		/Subject:/ {
			sub(/^[ \t]*Subject:[ \t]*/, "")
			n = split($0, part, (substr($0, 1, 1) == "/") ? "/" : ",")
			for (i = 1; i <= n; i++) {
				if (part[i] ~ /^[ \t]*CN=/) {
					sub(/^[ \t]*CN=/, "", part[i])
					sub(/[ \t]+$/, "", part[i])
					print part[i]
					exit
				}
			}
			exit
		}')"
	if [ -n "${SIGNING_PUBLISHER_CN:-}" ]; then
		[ "$cn" = "$SIGNING_PUBLISHER_CN" ] ||
			fail "$f is signed by '${cn:-<unknown>}', expected '${SIGNING_PUBLISHER_CN}'"
	fi

	# Exit 0 means everything verified INCLUDING the certificate chain. That is
	# the strongest available assertion and, against a publicly trusted Sectigo
	# chain, the expected outcome — hence the default-on requirement. It stays
	# an opt-out because a machine without the issuing CA (or an old
	# osslsigncode) can still fail it for reasons unrelated to the signature.
	if [ "$rc" -eq 0 ]; then
		echo "verified $f — signed by '${cn:-?}', timestamped, chain trusted"
	else
		echo "verified $f — signed by '${cn:-?}', timestamped; chain NOT trusted by this machine (osslsigncode exit ${rc})" >&2
		[ "$SIGN_REQUIRE_TRUSTED_CHAIN" = "1" ] &&
			fail "SIGN_REQUIRE_TRUSTED_CHAIN=1 but osslsigncode did not fully verify $f (exit ${rc})"
	fi
	return 0
}

for f in "$@"; do
	echo "signing $f"
	# --storepass lands in this process's argv, visible in /proc on the local
	# machine. Acceptable on an ephemeral runner (and the token is short-lived
	# and scoped to Cloud KMS); do not run this on a shared host with untrusted
	# users.
	java -jar "$jar" \
		--storetype GOOGLECLOUD \
		--keystore "$GCP_KMS_KEYRING" \
		--storepass "$GCP_ACCESS_TOKEN" \
		--alias "$GCP_KMS_KEY_ALIAS" \
		--certfile "$CODESIGN_CERT_FILE" \
		--tsaurl "$TSA_URL" \
		--tsmode RFC3161 \
		"$f"
	verify_signature "$f"
done

echo "signed $# file(s) as '${GCP_KMS_KEY_ALIAS}' in ${GCP_KMS_KEYRING}"
