#!/usr/bin/env bash
# Tests for sign-windows.sh — no DigiCert account required.
#
# The signing call itself is one line; everything around it (credential
# assembly, temp-file hygiene, fail-fast validation) is where the bugs live,
# and all of it is testable by putting a stub `java` on PATH that records its
# argv instead of signing. Two release-breaking quoting bugs on this branch
# were of exactly this shape, so these assertions are not ceremony.
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
export PATH="$WORK/bin:$PATH"

touch "$WORK/fake-jsign.jar"
export JSIGN_JAR="$WORK/fake-jsign.jar"
# (tests that exercise the download branch pass JSIGN_JAR= to blank it; the
#  script checks ${JSIGN_JAR:-} so empty behaves as unset)

# A .p12 whose bytes we can recognise, and credentials with characters that
# have historically broken naive shell quoting.
CERT_PLAIN='PKCS12-CONTENT-$(whoami)-`id`-done'
CERT_B64="$(printf '%s' "$CERT_PLAIN" | base64 -w0)"

run_sign() {
	STUB_JAVA_LOG="$WORK/argv.log" \
		SM_API_KEY="${SM_API_KEY_OVERRIDE:-api-key-123}" \
		SM_CLIENT_CERT_FILE_B64="${SM_CERT_B64_OVERRIDE:-$CERT_B64}" \
		SM_CLIENT_CERT_PASSWORD="${SM_PW_OVERRIDE:-p@ss w0rd \$X \`y\`}" \
		SM_KEYPAIR_ALIAS="${SM_ALIAS_OVERRIDE-jarvis-keypair}" \
		SM_HOST="${SM_HOST_OVERRIDE-}" \
		STUB_JAVA_EXIT="${STUB_JAVA_EXIT:-0}" \
		bash "$SCRIPT" "$@"
}

argv_field() { # argv_field <index-of-flag> -> value following that flag
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

[ "$(argv_field --storetype)" = "DIGICERTONE" ] &&
	ok "uses the DIGICERTONE storetype" || no "uses the DIGICERTONE storetype"

[ "$(argv_field --keystore)" = "https://clientauth.one.digicert.com" ] &&
	ok "defaults SM_HOST to the US production client-auth host" ||
	no "defaults SM_HOST to production" "got: $(argv_field --keystore)"

[ "$(argv_field --alias)" = "jarvis-keypair" ] &&
	ok "passes the keypair alias" || no "passes the keypair alias"

[ "$(argv_field --tsaurl)" = "http://timestamp.digicert.com" ] &&
	ok "timestamps against DigiCert's TSA" || no "timestamps against DigiCert's TSA"

[ "$(argv_field --tsmode)" = "RFC3161" ] &&
	ok "uses RFC3161 timestamping" || no "uses RFC3161 timestamping"

# storepass = <api-key>|<p12 path>|<password>. The password here contains
# spaces, a $ and backticks; if any layer re-evaluated it, this breaks.
storepass="$(argv_field --storepass)"
case "$storepass" in
'api-key-123|'*'|p@ss w0rd $X `y`')
	ok "assembles storepass with a shell-hostile password intact"
	;;
*)
	no "assembles storepass correctly" "got: $storepass"
	;;
esac

# The middle field must be a real file at signing time, holding the decoded
# certificate — this is what proves the base64 round-trip.
p12_path="${storepass#*|}"
p12_path="${p12_path%|*}"
case "$p12_path" in
*/sm_client_cert-*.p12) ok "points jsign at the decoded client certificate" ;;
*) no "points jsign at the decoded client certificate" "got: $p12_path" ;;
esac

# ── temp-file hygiene ─────────────────────────────────────────────────────
[ ! -e "$p12_path" ] &&
	ok "removes the client certificate after a successful run" ||
	no "removes the client certificate after a successful run" "$p12_path still exists"

: >"$WORK/argv.log"
STUB_JAVA_EXIT=9 run_sign "$WORK/app.exe" >/dev/null 2>&1
sp="$(argv_field --storepass)"
leaked="${sp#*|}"
leaked="${leaked%|*}"
[ ! -e "$leaked" ] &&
	ok "removes the client certificate even when signing FAILS" ||
	no "removes the client certificate when signing fails" "$leaked still exists"

# The decoded certificate must never be world-readable while it exists. Verify
# by having the stub record the mode it sees.
cat >"$WORK/bin/java" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" >> "${STUB_JAVA_LOG}"
sp=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--storepass" ]; then sp="$2"; fi
  shift
done
p12="${sp#*|}"; p12="${p12%|*}"
stat -c '%a' "$p12" > "${STUB_JAVA_LOG}.mode"
exit 0
STUB
chmod +x "$WORK/bin/java"
: >"$WORK/argv.log"
run_sign "$WORK/app.exe" >/dev/null 2>&1
[ "$(cat "$WORK/argv.log.mode" 2>/dev/null)" = "600" ] &&
	ok "writes the client certificate 0600" ||
	no "writes the client certificate 0600" "mode: $(cat "$WORK/argv.log.mode" 2>/dev/null)"

cat >"$WORK/bin/java" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" >> "${STUB_JAVA_LOG}"
exit "${STUB_JAVA_EXIT:-0}"
STUB
chmod +x "$WORK/bin/java"

# ── exit status ───────────────────────────────────────────────────────────
STUB_JAVA_EXIT=9 run_sign "$WORK/app.exe" >/dev/null 2>&1
[ "$?" -ne 0 ] && ok "propagates a signing failure" || no "propagates a signing failure"

# ── fail-fast validation ──────────────────────────────────────────────────
out="$(SM_ALIAS_OVERRIDE= run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *SM_KEYPAIR_ALIAS* ]]; then
	ok "fails fast and names the missing credential"
else
	no "fails fast on a missing credential" "$out"
fi

out="$(SM_PW_OVERRIDE='has|pipe' run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"separator"* ]]; then
	ok "rejects a credential containing jsign's '|' field separator"
else
	no "rejects a credential containing '|'" "$out"
fi

out="$(run_sign "$WORK/does-not-exist.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"file not found"* ]]; then
	ok "refuses a missing input file before touching credentials"
else
	no "refuses a missing input file" "$out"
fi

out="$(run_sign 2>&1)"
[ $? -ne 0 ] && ok "requires at least one file argument" || no "requires at least one file argument"

# ── demo host + multiple files ────────────────────────────────────────────
: >"$WORK/argv.log"
printf 'MZ' >"$WORK/second.exe"
SM_HOST_OVERRIDE="https://clientauth.demo.one.digicert.com" \
	run_sign "$WORK/app.exe" "$WORK/second.exe" >/dev/null 2>&1
[ "$(argv_field --keystore)" = "https://clientauth.demo.one.digicert.com" ] &&
	ok "honours SM_HOST (demo account)" || no "honours SM_HOST (demo account)"

# One jsign invocation per file — each consumes one KeyLocker signature, so a
# regression here silently ships an unsigned second binary. Count invocations
# by counting --storetype occurrences; a NUL-byte count would be satisfied by
# a single invocation and could never fail.
invocations="$(grep -zc -- '--storetype' "$WORK/argv.log" 2>/dev/null || true)"
[ "${invocations:-0}" -eq 2 ] &&
	ok "signs every file passed (one jsign invocation each)" ||
	no "signs every file passed" "expected 2 jsign invocations, got ${invocations:-0}"

# ── payload / download integrity ──────────────────────────────────────────
out="$(SM_CERT_B64_OVERRIDE='!!!not base64!!!' run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"base64"* ]]; then
	ok "rejects a client certificate that is not valid base64"
else
	no "rejects invalid base64" "$out"
fi

# The jar download branch is skipped whenever JSIGN_JAR is set, so exercise it
# explicitly with a stub curl — the pinned checksum is the security control on
# an artifact we then execute with live credentials in hand.
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

out="$(JSIGN_JAR= JSIGN_SHA256="0000000000000000000000000000000000000000000000000000000000000000" \
	run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"checksum mismatch"* ]]; then
	ok "refuses to run a jsign download whose checksum does not match"
else
	no "refuses a bad jsign checksum" "$out"
fi
rm -f "$WORK/bin/curl"

# Credentials must never reach the logs — CI output is retained and often public.
: >"$WORK/argv.log"
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [[ "$out" != *"api-key-123"* && "$out" != *"p@ss w0rd"* ]]; then
	ok "keeps credentials out of stdout/stderr"
else
	no "keeps credentials out of stdout/stderr" "$out"
fi

# ── post-sign verification ────────────────────────────────────────────────
# The stub replays REAL osslsigncode 2.9 output (captured from a container
# signing a mingw-built PE), so these assertions are pinned to the actual
# format rather than a guess. Note osslsigncode exits 1 for an untrusted
# chain even when the signature is perfect — hence verify_signature asserts
# on output, not exit status.
make_osslsigncode() { # make_osslsigncode <digest-state> <cn> <timestamp> <chain>
	cat >"$WORK/bin/osslsigncode" <<STUB
#!/usr/bin/env bash
cat <<'OUT'
PE checksum   : 0001FB65

Signature Index: 0  (Primary Signature)

Message digest algorithm  : SHA256
Current message digest    : C40CC1ABF65CC1E86B6090E9E6DBC3FB6FA36D2CB82B8ECB987F2BEFC49086A1
Calculated message digest : ${1}
Signer's certificate:
	Signer #0:
		Subject: /C=US/O=Jarvis Technologies Inc/CN=${2}
		Issuer : /CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1
${3}
Number of verified signatures: 1
${4}
OUT
exit ${5}
STUB
	chmod +x "$WORK/bin/osslsigncode"
}

GOOD_DIGEST="C40CC1ABF65CC1E86B6090E9E6DBC3FB6FA36D2CB82B8ECB987F2BEFC49086A1"
TS_OK="Timestamp: Aug  6 10:47:31 2026 GMT"
CHAIN_OK="Signing certificate chain verified using:"

# happy path: digests match, timestamped, trusted chain, expected publisher
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 0
out="$(SIGNING_PUBLISHER_CN="Jarvis Technologies Inc" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -eq 0 ] && [[ "$out" == *"chain trusted"* ]]; then
	ok "verifies the signature after signing"
else
	no "verifies the signature after signing" "$out"
fi

# a digest mismatch means the signature does not cover these bytes
make_osslsigncode "DEADBEEF     MISMATCH!!!" "Jarvis Technologies Inc" "$TS_OK" "$CHAIN_OK" 1
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"does not match its contents"* ]]; then
	ok "fails when the signature does not match the file's contents"
else
	no "fails on a digest MISMATCH" "$out"
fi

# wrong publisher — the same identity the installer pins at runtime
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
if [ $? -ne 0 ] && [[ "$out" == *"WITHOUT a trusted timestamp"* ]]; then
	ok "fails when the signature carries no timestamp"
else
	no "fails on a missing timestamp" "$out"
fi

# untrusted chain (a demo account, by design) must NOT fail the run...
make_osslsigncode "$GOOD_DIGEST" "Jarvis Technologies Inc" "$TS_OK" "" 1
out="$(run_sign "$WORK/app.exe" 2>&1)"
if [ $? -eq 0 ] && [[ "$out" == *"chain NOT trusted"* ]]; then
	ok "tolerates an untrusted chain (demo accounts) but says so"
else
	no "tolerates an untrusted chain" "$out"
fi

# ...unless explicitly required
out="$(SIGN_REQUIRE_TRUSTED_CHAIN=1 run_sign "$WORK/app.exe" 2>&1)"
if [ $? -ne 0 ] && [[ "$out" == *"did not verify"* ]]; then
	ok "enforces chain trust when SIGN_REQUIRE_TRUSTED_CHAIN=1"
else
	no "enforces chain trust on demand" "$out"
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

# absent tooling degrades to a warning rather than blocking a local run
rm -f "$WORK/bin/osslsigncode"
out="$(PATH="$WORK/bin:/usr/bin:/bin" run_sign "$WORK/app.exe" 2>&1)"
if [ $? -eq 0 ] && [[ "$out" == *"skipping post-sign verification"* ]]; then
	ok "warns (not fails) when osslsigncode is unavailable"
else
	no "warns when osslsigncode is unavailable" "$out"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
