#!/usr/bin/env bash
# Print the Windows signer key pin list the release build stamps into the
# installer and the sidecar self-updater (#1165): the lower-case hex SHA-256
# of the SubjectPublicKeyInfo of the leaf of the committed chain, then, when
# a key rotation is under way, of the next leaf, comma-separated.
#
# The clients pin the publisher CN as well, but a CN is not an identity: any
# publicly trusted certificate with the same CN passes it. The key of the
# Cloud KMS signing key passes only for us, and it survives a certificate
# renewal on the same key. A new KMS key does not: installed clients refuse
# what it signs until they carry its pin, so a rotation ships in two releases
# (sidecar/packaging/windows/README.md): first one with the new leaf
# committed as codesign-next-leaf.pem, then the switch.
#
# Usage: codesign-spki-pins.sh <packaging/windows dir>
# Fails, printing nothing on stdout, if the chain is missing or a key cannot
# be read, so a build never stamps an empty or partial list.
set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 1 ]; then
	echo "::error::usage: codesign-spki-pins.sh <packaging/windows dir>" >&2
	exit 2
fi
dir="$1"
chain="${dir}/codesign-chain.pem"
next="${dir}/codesign-next-leaf.pem"

spki() {
	local key sum
	# The first certificate in the file: the leaf.
	key="$(openssl x509 -in "$1" -noout -pubkey)" || return 1
	sum="$(printf '%s\n' "$key" | openssl pkey -pubin -outform DER | sha256sum)" || return 1
	sum="${sum%% *}"
	[[ "$sum" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$sum"
}

[ -f "$chain" ] || {
	echo "::error::${chain} is missing, so the Windows signer key cannot be pinned" >&2
	exit 1
}
pins="$(spki "$chain")" || {
	echo "::error::could not read the leaf key of ${chain}" >&2
	exit 1
}
if [ -e "$next" ]; then
	n="$(spki "$next")" || {
		echo "::error::could not read the leaf key of ${next}" >&2
		exit 1
	}
	[ "$n" = "$pins" ] || pins="${pins},${n}"
fi
printf '%s\n' "$pins"
