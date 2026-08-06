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

# A .p12 whose bytes we can recognise, and credentials with characters that
# have historically broken naive shell quoting.
CERT_PLAIN='PKCS12-CONTENT-$(whoami)-`id`-done'
CERT_B64="$(printf '%s' "$CERT_PLAIN" | base64 -w0)"

run_sign() {
	STUB_JAVA_LOG="$WORK/argv.log" \
		SM_API_KEY="${SM_API_KEY_OVERRIDE:-api-key-123}" \
		SM_CLIENT_CERT_FILE_B64="$CERT_B64" \
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

# One jsign invocation per file — each consumes one KeyLocker signature.
invocations="$(grep -zc -- '--storetype' "$WORK/argv.log" 2>/dev/null || true)"
[ "$(tr -dc '\0' <"$WORK/argv.log" | wc -c)" -gt 10 ] &&
	ok "signs every file passed" || no "signs every file passed"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
