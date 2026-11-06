#!/usr/bin/env bash
# sign-windows.sh --verify-only against a REAL osslsigncode (#1165). Opt-in:
# it runs only with SIGN_WINDOWS_REAL_OSSLSIGNCODE=1, and then needs
# osslsigncode, openssl and x86_64-w64-mingw32-gcc on PATH (CI installs all
# three in the sidecar job and sets the flag).
#
# sign-windows.test.sh drives the script against stub osslsigncodes that print
# what osslsigncode 2.7 to 2.13 print. That holds the script to those strings,
# not the strings to the tool: an osslsigncode that changed a line the script
# reads would pass every stub test and fail, or worse pass, a release. Here the
# signatures are made and read by the real tool, with a throwaway CA, leaf and
# built-in timestamp authority (osslsigncode -TSA-certs, 2.6 and later), on a
# PE that mingw builds:
#   * our leaf, timestamped: verified;
#   * another certificate with the SAME subject from the same CA: refused as
#     not our leaf (#871), which is what a CN pin alone would accept;
#   * unsigned, untimestamped, a byte changed after signing, nested a second
#     time, and a CN other than the pinned one: each refused for its reason.
set -uo pipefail

if [ "${SIGN_WINDOWS_REAL_OSSLSIGNCODE:-}" != "1" ]; then
	echo "skipped: set SIGN_WINDOWS_REAL_OSSLSIGNCODE=1 to run sign-windows.sh against a real osslsigncode"
	exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/sign-windows.sh"
for tool in osslsigncode openssl x86_64-w64-mingw32-gcc; do
	command -v "$tool" >/dev/null || {
		echo "FAIL: ${tool} is required when SIGN_WINDOWS_REAL_OSSLSIGNCODE=1" >&2
		exit 1
	}
done
echo "$(osslsigncode --version 2>&1 | head -n 1)"

pass=0
fail=0
ok() {
	pass=$((pass + 1))
	echo "  ok   - $1"
}
no() {
	fail=$((fail + 1))
	echo "  FAIL - $1"
	[ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/         /'
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 1

SUBJ="/C=US/O=Jarvis Technologies Inc/CN=Jarvis Technologies Inc"
CN="Jarvis Technologies Inc"
quiet() { "$@" >/dev/null 2>&1 || {
	echo "FAIL: setup step failed: $*" >&2
	exit 1
}; }

# A root, our leaf and an impostor leaf with the same subject, both issued by
# that root, and a timestamp authority under its own root.
cat >ext.cnf <<'EOF'
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[tsa]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
CAEXT=(-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign")
quiet openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key -out root.pem -days 3 -subj "/CN=Test Code Signing Root" "${CAEXT[@]}"
for n in leaf other; do
	quiet openssl req -newkey rsa:2048 -nodes -keyout "${n}.key" -out "${n}.csr" -subj "$SUBJ"
	quiet openssl x509 -req -in "${n}.csr" -CA root.pem -CAkey root.key -CAcreateserial -out "${n}.pem" -days 2 -extfile ext.cnf -extensions leaf
	cat "${n}.pem" root.pem >"${n}-chain.pem"
done
quiet openssl req -x509 -newkey rsa:2048 -nodes -keyout tsaroot.key -out tsaroot.pem -days 3 -subj "/CN=Test TSA Root" "${CAEXT[@]}"
quiet openssl req -newkey rsa:2048 -nodes -keyout tsa.key -out tsa.csr -subj "/CN=Test TSA"
quiet openssl x509 -req -in tsa.csr -CA tsaroot.pem -CAkey tsaroot.key -CAcreateserial -out tsa.pem -days 2 -extfile ext.cnf -extensions tsa
cat tsa.pem tsaroot.pem >tsa-chain.pem
cat root.pem tsaroot.pem >bundle.pem

printf 'int main(void) { return 0; }\n' >t.c
quiet x86_64-w64-mingw32-gcc -o t.exe t.c

NOW="$(date +%s)"
# sign <out> <chain> <key> [extra osslsigncode options...]
sign() {
	local out="$1" chain="$2" key="$3"
	shift 3
	quiet osslsigncode sign -certs "$chain" -key "$key" -n "Jarvis" "$@" -in t.exe -out "$out"
}
TSA=(-TSA-certs tsa-chain.pem -TSA-key tsa.key -TSA-time "$NOW")
sign ours.exe leaf-chain.pem leaf.key "${TSA[@]}"
sign other.exe other-chain.pem other.key "${TSA[@]}"
sign nots.exe leaf-chain.pem leaf.key
quiet osslsigncode sign -certs leaf-chain.pem -key leaf.key -nest "${TSA[@]}" -in ours.exe -out nested.exe
cp ours.exe tampered.exe
# One byte of the code section, well inside the file and outside the
# signature, which sits at the end.
printf '\x90' | dd of=tampered.exe bs=1 seek=1100 conv=notrunc status=none

# verify <file> [CN]: the script exactly as verify-sidecar-windows runs it,
# with this CA as the trusted bundle.
verify() {
	CODESIGN_CERT_FILE="${WORK}/leaf-chain.pem" CA_BUNDLE="${WORK}/bundle.pem" SIGN_REQUIRE_TRUSTED_CHAIN=1 \
		SIGNING_PUBLISHER_CN="${2:-$CN}" "$SCRIPT" --verify-only "$1" 2>&1
}
expect_pass() {
	local out
	if out="$(verify "$2")"; then ok "$1"; else no "$1" "$out"; fi
}
expect_fail() {
	local out
	if out="$(verify "$2" "${4:-}")"; then
		no "$1" "verified, but should have been refused: ${out}"
	elif grep -qF -- "$3" <<<"$out"; then
		ok "$1"
	else
		no "$1, for the reason it exists" "wanted '$3', got: ${out}"
	fi
}

expect_pass "our leaf, timestamped, chain trusted: verified" ours.exe
expect_fail "a same-subject certificate from the same CA is not our leaf (#871)" other.exe "a matching CN does not make it ours"
expect_fail "an unsigned file" t.exe "no Authenticode signature found"
expect_fail "a signature with no timestamp" nots.exe "carries no trusted timestamp"
expect_fail "a byte changed after signing" tampered.exe "does not cover its contents"
expect_fail "a second, nested signature" nested.exe "more than one Authenticode signature"
expect_fail "our leaf, but another publisher CN pinned" ours.exe "expected 'Someone Else Inc'" "Someone Else Inc"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
