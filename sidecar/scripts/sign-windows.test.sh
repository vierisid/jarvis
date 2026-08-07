#!/usr/bin/env bash
# Tests for sign-windows.sh — no GCP project and no certificate required.
#
# The signing call itself is one line; everything around it (credential
# resolution, argument assembly, temp-file hygiene, fail-fast validation) is
# where the bugs live, and all of it is testable by putting a stub `java` on
# PATH that records its argv instead of signing. Two release-breaking quoting
# bugs on this branch were of exactly this shape, so these assertions are not
# ceremony.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/sign-windows.sh"

pass=0
fail=0
ok() {
	pass=$((pass + 1))
	echo "  ok   — $1"
}
no() {
	fail=$((fail + 1))
	echo "  FAIL — $1"
	[ -n "${2:-}" ] && echo "         $2"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Stub java: records argv (NUL-separated, so arguments containing spaces or
# newlines survive) and exits with ${STUB_JAVA_EXIT:-0}.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/java" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" >> "${STUB_JAVA_LOG}"
exit "${STUB_JAVA_EXIT:-0}"
STUB
chmod +x "$WORK/bin/java"

# A permissive default osslsigncode stub, installed BEFORE any test runs.
# Without it the suite is not hermetic: on a machine that has the real
# osslsigncode (any developer who followed the runbook) it would run against
# the fake .exe fixtures and fail for environmental reasons. Individual tests
# overwrite this via make_osslsigncode.
cat >"$WORK/bin/osslsigncode" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" >> "${VERIFY_LOG:-/dev/null}"
cat <<'OUT'
Message digest algorithm  : SHA256
Current message digest    : AAAA
Calculated message digest : AAAA
	Signer #0:
		Subject: /C=US/O=Jarvis Technologies Inc/CN=Jarvis Technologies Inc
	Timestamp time: Aug  7 10:00:00 2026 GMT
Number of verified signatures: 1
Signing certificate chain verified using:
Succeeded
OUT
exit 0
STUB
chmod +x "$WORK/bin/osslsigncode"

export PATH="$WORK/bin:$PATH"

touch "$WORK/fake-jsign.jar"
export JSIGN_JAR="$WORK/fake-jsign.jar"
# (tests that exercise the download branch pass JSIGN_JAR= to blank it; the
#  script checks ${JSIGN_JAR:-} so empty behaves as unset)

# A stand-in certificate chain. Only its existence and the PEM marker matter to
# the script — Cloud KMS holds the key, this file holds the public chain.
printf -- '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n' >"$WORK/chain.pem"

# An OAuth access token containing characters that have historically broken
# naive shell quoting — including '|', which the DigiCert storetype used as a
# field separator and GOOGLECLOUD does not (jsign 7.1 hands --storepass to
# GoogleCloudSigningService whole; verified by decompiling the pinned jar).
TOKEN='ya29.a0-token $X `y` |not|a|separator| end'
KEYRING='projects/jarvis-signing/locations/global/keyRings/codesign'
ALIAS='jarvis-authenticode/cryptoKeyVersions/1'

run_sign() {
	STUB_JAVA_LOG="$WORK/argv.log" \
		GCP_KMS_KEYRING="${KEYRING_OVERRIDE-$KEYRING}" \
		GCP_KMS_KEY_ALIAS="${ALIAS_OVERRIDE-$ALIAS}" \
		GCP_ACCESS_TOKEN="${TOKEN_OVERRIDE-$TOKEN}" \
		CODESIGN_CERT_FILE="${CERTFILE_OVERRIDE-$WORK/chain.pem}" \
		STUB_JAVA_EXIT="${STUB_JAVA_EXIT:-0}" \
		VERIFY_LOG="${VERIFY_LOG:-/dev/null}" \
		bash "$SCRIPT" "$@"
}

argv_field() { # argv_field <flag> -> value following that flag
	local want="$1" prev="" cur
	while IFS= read -r -d '' cur; do
		if [ "$prev" = "$want" ]; then
			printf '%s' "$cur"
			return 0
		fi
		prev="$cur"
	done <"$WORK/argv.log"
	return 1
}

echo "sign-windows.sh"

# ── happy path ────────────────────────────────────────────────────────────
: >"$WORK/argv.log"
printf 'MZ-fake-exe' >"$WORK/app.exe"
if out="$(run_sign "$WORK/app.exe" 2>&1)"; then
	ok "signs a file successfully"
else
	no "signs a file successfully" "$out"
fi

[ "$(argv_field --storetype)" = "GOOGLECLOUD" ] &&
	ok "uses the GOOGLECLOUD storetype" ||
	no "uses the GOOGLECLOUD storetype" "got: $(argv_field --storetype)"

[ "$(argv_field --keystore)" = "$KEYRING" ] &&
	ok "passes the KMS keyring as the keystore" ||
	no "passes the KMS keyring as the keystore" "got: $(argv_field --keystore)"

[ "$(argv_field --alias)" = "$ALIAS" ] &&
	ok "passes the key alias, version suffix intact" ||
	no "passes the key alias" "got: $(argv_field --alias)"

# Cloud KMS stores only the private key: without --certfile jsign has no
# certificate to embed and the signature cannot be built at all.
[ "$(argv_field --certfile)" = "$WORK/chain.pem" ] &&
	ok "passes the certificate chain with --certfile" ||
	no "passes the certificate chain with --certfile" "got: $(argv_field --certfile)"

# The whole token, verbatim: GOOGLECLOUD's storepass is a single value, so a
# token containing spaces, '$', backticks or '|' must arrive unmangled.
storepass="$(argv_field --storepass)"
[ "$storepass" = "$TOKEN" ] &&
	ok "passes the access token as storepass, unmangled" ||
	no "passes the access token as storepass" "got: $storepass"

[ "$(argv_field --tsaurl)" = "http://timestamp.sectigo.com" ] &&
	ok "timestamps against Sectigo's TSA" ||
	no "timestamps against Sectigo's TSA" "got: $(argv_field --tsaurl)"

[ "$(argv_field --tsmode)" = "RFC3161" ] &&
	ok "uses RFC3161 timestamping" || no "uses RFC3161 timestamping"

# ── credential resolution ─────────────────────────────────────────────────
# A developer with gcloud logged in should not have to export anything.
cat >"$WORK/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
[ "$*" = "auth print-access-token" ] || exit 2
printf 'ya29.from-gcloud\n'
STUB
chmod +x "$WORK/bin/gcloud"
: >"$WORK/argv.log"
TOKEN_OVERRIDE= run_sign "$WORK/app.exe" >/dev/null 2>&1
[ "$(argv_field --storepass)" = "ya29.from-gcloud" ] &&
	ok "falls back to 'gcloud auth print-access-token'" ||
	no "falls back to gcloud for the token" "got: $(argv_field --storepass)"

# ...and a gcloud that cannot mint one must fail by NAME, not with a raw
# gcloud error or an empty Bearer token.
cat >"$WORK/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
echo "ERROR: (gcloud.auth) You do not currently have an active account" >&2
exit 1
STUB
chmod +x "$WORK/bin/gcloud"
out="$(TOKEN_OVERRIDE= run_sign "$WORK/app.exe" 2>&1)"
# gcloud's OWN message must survive: the overwhelmingly common local failure is
# "no active account", and reporting only "GCP_ACCESS_TOKEN is required" sends
# someone to set a variable when the fix is `gcloud auth login`.
if [ $? -ne 0 ] && [[ "$out" == *GCP_ACCESS_TOKEN* && "$out" == *"active account"* ]]; then
	ok "fails fast and surfaces gcloud's reason when it cannot mint a token"
else
	no "fails fast when gcloud cannot mint a token" "$out"
fi
rm -f "$WORK/bin/gcloud"

# ── temp-file hygiene ─────────────────────────────────────────────────────
# Only the downloaded jar hits disk now (the key is in Cloud HSM, the token
# stays in the environment) — but it is executed with a live token in hand, so
# it must not survive the run.
cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2;; *) shift;; esac
done
printf 'pretend-jsign-jar' > "$out"
STUB
chmod +x "$WORK/bin/curl"
GOOD_SHA="$(printf 'pretend-jsign-jar' | sha256sum | cut -d' ' -f1)"

: >"$WORK/argv.log"
out="$(JSIGN_JAR= JSIGN_SHA256="$GOOD_SHA" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -eq 0 ]; then
	ok "downloads jsign and accepts a matching checksum"
else
	no "downloads jsign and accepts a matching checksum" "$out"
fi
downloaded="$(argv_field -jar)"
case "$downloaded" in
*/jsign-*.jar) ok "runs the jar it just downloaded" ;;
*) no "runs the downloaded jar" "got: $downloaded" ;;
esac
[ ! -e "$downloaded" ] &&
	ok "removes the downloaded jar after a successful run" ||
	no "removes the downloaded jar" "$downloaded still exists"

: >"$WORK/argv.log"
STUB_JAVA_EXIT=9 JSIGN_JAR= JSIGN_SHA256="$GOOD_SHA" run_sign "$WORK/app.exe" >/dev/null 2>&1
leaked="$(argv_field -jar)"
[ -n "$leaked" ] && [ ! -e "$leaked" ] &&
	ok "removes the downloaded jar even when signing FAILS" ||
	no "removes the downloaded jar when signing fails" "${leaked:-<no jar recorded>} still exists"

out="$(JSIGN_JAR= JSIGN_SHA256="0000000000000000000000000000000000000000000000000000000000000000" \
	run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"checksum mismatch"* ]]; then
	ok "refuses to run a jsign download whose checksum does not match"
else
	no "refuses a bad jsign checksum" "$out"
fi
rm -f "$WORK/bin/curl"

# ── exit status ───────────────────────────────────────────────────────────
STUB_JAVA_EXIT=9 run_sign "$WORK/app.exe" >/dev/null 2>&1
[ "$?" -ne 0 ] && ok "propagates a signing failure" || no "propagates a signing failure"

# ── fail-fast validation ──────────────────────────────────────────────────
out="$(ALIAS_OVERRIDE= run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *GCP_KMS_KEY_ALIAS* ]]; then
	ok "fails fast and names the missing key alias"
else
	no "fails fast on a missing key alias" "$out"
fi

out="$(KEYRING_OVERRIDE= run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *GCP_KMS_KEYRING* ]]; then
	ok "fails fast and names the missing keyring"
else
	no "fails fast on a missing keyring" "$out"
fi

# jsign only rejects a malformed keyring after a JVM start, with a message that
# reads like a jsign bug rather than a mistyped repo variable. The two shapes
# people actually paste: a full cryptoKey path, and the bare keyring name.
out="$(KEYRING_OVERRIDE="${KEYRING}/cryptoKeys/jarvis-authenticode" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *GCP_KMS_KEYRING* ]]; then
	ok "rejects a keyring path that reaches down to the key"
else
	no "rejects an over-specified keyring path" "$out"
fi

out="$(KEYRING_OVERRIDE="codesign" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *GCP_KMS_KEYRING* ]]; then
	ok "rejects a bare keyring name"
else
	no "rejects a bare keyring name" "$out"
fi

# The anchor at the end of the pattern: a copy-pasted trailing slash is the
# other shape people paste, and jsign's own matches() rejects it too — so
# without this the guard would silently stop pre-empting the JVM error.
out="$(KEYRING_OVERRIDE="${KEYRING}/" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *GCP_KMS_KEYRING* ]]; then
	ok "rejects a keyring path with a trailing slash"
else
	no "rejects a trailing slash" "$out"
fi

# Before the certificate is issued this is the EXPECTED state, so it has to
# read as "the cert isn't there yet" rather than a Java stack trace. Run from
# another directory: the default path is resolved relative to the script, not
# the caller's cwd.
# The "No such file" clause also asserts the existence check runs BEFORE the
# PEM sniff: reading a file that isn't there would spray a raw grep error into
# the release log next to our own message.
out="$(cd / && CERTFILE_OVERRIDE= run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"certificate chain not found"* ]] &&
	[[ "$out" == *"packaging/windows/codesign-chain.pem"* ]] &&
	[[ "$out" != *"No such file or directory"* ]]; then
	ok "names the default chain path when the certificate is not installed yet"
else
	no "names the default chain path when the cert is missing" "$out"
fi

printf 'TODO: paste the Sectigo chain here\n' >"$WORK/placeholder.pem"
out="$(CERTFILE_OVERRIDE="$WORK/placeholder.pem" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"no PEM certificate"* ]]; then
	ok "rejects a chain file that holds no certificate"
else
	no "rejects a placeholder chain file" "$out"
fi

out="$(run_sign "$WORK/does-not-exist.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"file not found"* ]]; then
	ok "refuses a missing input file before touching credentials"
else
	no "refuses a missing input file" "$out"
fi

out="$(run_sign 2>&1)"
[ $? -ne 0 ] && ok "requires at least one file argument" || no "requires at least one file argument"

# ── multiple files ────────────────────────────────────────────────────────
: >"$WORK/argv.log"
printf 'MZ' >"$WORK/second.exe"
run_sign "$WORK/app.exe" "$WORK/second.exe" >/dev/null 2>&1

# One jsign invocation per file — a regression here silently ships an unsigned
# second binary. Count invocations by counting --storetype occurrences; a
# NUL-byte count would be satisfied by a single invocation and could never fail.
invocations="$(grep -zc -- '--storetype' "$WORK/argv.log" 2>/dev/null || true)"
[ "${invocations:-0}" -eq 2 ] &&
	ok "signs every file passed (one jsign invocation each)" ||
	no "signs every file passed" "expected 2 jsign invocations, got ${invocations:-0}"

# The access token must never reach the logs — CI output is retained and often
# public, and this token is live for the next hour.
: >"$WORK/argv.log"
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [[ "$out" != *"ya29.a0-token"* ]]; then
	ok "keeps the access token out of stdout/stderr"
else
	no "keeps the access token out of stdout/stderr" "$out"
fi

# ── post-sign verification ────────────────────────────────────────────────
# The stub replays REAL osslsigncode 2.9 output (captured from a container
# signing a mingw-built PE), so these assertions are pinned to the actual
# format rather than a guess. Note osslsigncode exits 1 for an untrusted
# chain even when the signature is perfect — hence verify_signature asserts
# on output, not exit status.
# make_osslsigncode <digest> <cn> <timestamp> <chain> <exit> [subject-format]
# subject-format: "slash" (osslsigncode 2.9, OpenSSL oneline) or "rfc2253"
# (2.13). Both are in the wild; assuming one silently breaks the publisher
# assertion on the other, which is a release-stopping bug.
make_osslsigncode() {
	local subject
	if [ "${6:-slash}" = "rfc2253" ]; then
		subject="C=US,ST=Delaware,L=Claymont,O=Jarvis Technologies Inc,CN=${2}"
	else
		subject="/C=US/O=Jarvis Technologies Inc/CN=${2}"
	fi
	cat >"$WORK/bin/osslsigncode" <<STUB
#!/usr/bin/env bash
printf '%s\0' "\$@" >> "\${VERIFY_LOG:-/dev/null}"
cat <<'OUT'
PE checksum   : 0001FB65

Signature Index: 0  (Primary Signature)

Message digest algorithm  : SHA256
Current message digest    : C40CC1ABF65CC1E86B6090E9E6DBC3FB6FA36D2CB82B8ECB987F2BEFC49086A1
Calculated message digest : ${1}
Signer's certificate:
	Signer #0:
		Subject: ${subject}
		Issuer : /C=GB/O=Sectigo Limited/CN=Sectigo Public Code Signing CA R36
${3}
Number of verified signatures: 1
${4}
OUT
exit ${5}
STUB
	chmod +x "$WORK/bin/osslsigncode"
}

GOOD_DIGEST="C40CC1ABF65CC1E86B6090E9E6DBC3FB6FA36D2CB82B8ECB987F2BEFC49086A1"
TS_OK="\tTimestamp time: Aug  6 10:47:31 2026 GMT"
CHAIN_OK="Signing certificate chain verified using:"

# happy path: digests match, timestamped, trusted chain, expected publisher
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 0
out="$(SIGNING_PUBLISHER_CN="Jarvis Technologies Inc" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -eq 0 ] && [[ "$out" == *"chain trusted"* ]]; then
	ok "verifies the signature after signing"
else
	no "verifies the signature after signing" "$out"
fi

# A corrupted signature blob: the file's digest still matches (the bytes were
# not touched) and the slot count still reads 1 — verified against real
# osslsigncode 2.9 output — so ONLY the CMS error distinguishes it.
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "CMS_verify error" 1
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"does not verify cryptographically"* ]]; then
	ok "refuses a signature that does not verify cryptographically"
else
	no "refuses a cryptographically broken signature" "$out"
fi

# osslsigncode 2.13 prints RFC 2253 subjects; 2.9 printed OpenSSL oneline.
# Both must yield the same CN, or the publisher assertion fails on whichever
# version the runner happens to ship.
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 0 rfc2253
out="$(SIGNING_PUBLISHER_CN="Jarvis Technologies Inc" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -eq 0 ] && [[ "$out" == *"signed by 'Jarvis Technologies Inc'"* ]]; then
	ok "reads the publisher CN from an RFC 2253 subject (osslsigncode 2.13+)"
else
	no "reads an RFC 2253 subject" "$out"
fi

# …and the anti-spoofing rule must hold in that format too.
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 0 rfc2253
sed -i 's/^\t\tSubject: C=US.*/\t\tSubject: C=US,CN=Attacker Ltd,OU=x,CN=Jarvis Technologies Inc/' "$WORK/bin/osslsigncode"
out="$(SIGNING_PUBLISHER_CN="Jarvis Technologies Inc" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"Attacker Ltd"* ]]; then
	ok "rejects a CN-spoofing DN in RFC 2253 form too"
else
	no "rejects CN spoofing in RFC 2253 form" "$out"
fi

# a digest mismatch means the signature does not cover these bytes
make_osslsigncode "DEADBEEF     MISMATCH!!!" "Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 1
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"does not cover its contents"* ]]; then
	ok "fails when the signature does not match the file's contents"
else
	no "fails on a digest MISMATCH" "$out"
fi

# wrong publisher — the same identity the installer pins at runtime
# A DN that embeds our expected CN in a LATER RDN must not satisfy the pin —
# that is why the extraction takes the FIRST /CN=, matching
# installer/certsubject.go. Without this case, changing $2 to $NF passes the
# entire suite while silently accepting an attacker-issued certificate.
make_osslsigncode "$GOOD_DIGEST" "Attacker Ltd/OU=x/CN=Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 0
out="$(SIGNING_PUBLISHER_CN="Jarvis Technologies Inc" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"Attacker Ltd"* ]]; then
	ok "rejects a DN hiding the expected CN in a later RDN"
else
	no "rejects a CN-spoofing DN" "$out"
fi

make_osslsigncode "$GOOD_DIGEST" "Someone Else Ltd" "$TS_OK" "$CHAIN_OK" 0
out="$(SIGNING_PUBLISHER_CN="Jarvis Technologies Inc" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"Someone Else Ltd"* ]]; then
	ok "fails when signed by an unexpected publisher"
else
	no "fails on a publisher CN mismatch" "$out"
fi

# an untimestamped signature dies when the certificate expires
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "Timestamp is not available" "$CHAIN_OK" 0
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"carries no trusted timestamp"* ]]; then
	ok "fails when the signature carries no timestamp"
else
	no "fails on a missing timestamp" "$out"
fi

# Sectigo's roots are publicly trusted, so a chain that does not verify is a
# real defect: strict is the DEFAULT now, with no demo account to excuse it.
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "" 1
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"did not fully verify"* ]]; then
	ok "rejects an untrusted chain by default"
else
	no "rejects an untrusted chain by default" "$out"
fi

# ...opt-out only, for a self-signed cert on a laptop
out="$(SIGN_REQUIRE_TRUSTED_CHAIN=0 run_sign "$WORK/app.exe" 2>&1)"
if [ $? -eq 0 ] && [[ "$out" == *"chain NOT trusted"* ]]; then
	ok "tolerates an untrusted chain under SIGN_REQUIRE_TRUSTED_CHAIN=0, but says so"
else
	no "tolerates an untrusted chain on request" "$out"
fi

# Verification must run per file, against the file just signed, with a CA
# bundle. Without argv logging these three could all regress unnoticed.
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 0
: >"$WORK/verify.log"
printf 'placeholder\n' >"$WORK/ca-bundle.pem"
CA_BUNDLE="$WORK/ca-bundle.pem" VERIFY_LOG="$WORK/verify.log" \
	run_sign "$WORK/app.exe" "$WORK/second.exe" >/dev/null 2>&1
verifications="$(grep -zc -- 'verify' "$WORK/verify.log" 2>/dev/null || true)"
[ "${verifications:-0}" -eq 2 ] &&
	ok "verifies every file, not just the last one" ||
	no "verifies every file" "expected 2 verify invocations, got ${verifications:-0}"

if grep -qz -- "$WORK/app.exe" "$WORK/verify.log" && grep -qz -- "$WORK/second.exe" "$WORK/verify.log"; then
	ok "verifies the exact files that were signed"
else
	no "verifies the exact files that were signed"
fi

# CA_BUNDLE is set explicitly: otherwise this depends on the host having a
# bundle at one of the probed paths, and fails for environmental reasons.
grep -qz -- '-CAfile' "$WORK/verify.log" &&
	ok "passes a CA bundle to osslsigncode" || no "passes a CA bundle to osslsigncode"

# Zero signature slots must not read as "a signature exists". The unsigned-file
# case below exercises a DIFFERENT osslsigncode output, so without this the
# [1-9] floor could be widened to [0-9] unnoticed.
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 1
sed -i 's/Number of verified signatures: 1/Number of verified signatures: 0/' "$WORK/bin/osslsigncode"
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"no Authenticode signature found"* ]]; then
	ok "rejects an output reporting zero verified signatures"
else
	no "rejects zero verified signatures" "$out"
fi

# an unsigned file produces no signature block at all
cat >"$WORK/bin/osslsigncode" <<'STUB'
#!/usr/bin/env bash
echo "Initialization error or unsupported input file type."
exit 1
STUB
chmod +x "$WORK/bin/osslsigncode"
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"no Authenticode signature found"* ]]; then
	ok "fails when no signature is present after signing"
else
	no "fails when no signature is present" "$out"
fi

# absent tooling degrades to a warning rather than blocking a local run.
# Build a minimal PATH holding only what the script needs, so this still
# exercises the absent case on a machine that HAS osslsigncode installed.
rm -f "$WORK/bin/osslsigncode"
mkdir -p "$WORK/nopath"
for b in bash env printf mktemp chmod rm grep sed awk cat curl sha256sum tr dirname basename; do
	src="$(command -v "$b" 2>/dev/null || true)"
	[ -n "$src" ] && ln -sf "$src" "$WORK/nopath/$b"
done
out="$(PATH="$WORK/bin:$WORK/nopath" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -eq 0 ] && [[ "$out" == *"skipping post-sign verification"* ]]; then
	ok "warns (not fails) when osslsigncode is unavailable"
else
	no "warns when osslsigncode is unavailable" "$out"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
