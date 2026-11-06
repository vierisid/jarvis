package update

// The platform-neutral pieces of the two extra signer pins (#1165), kept here
// so they can be unit-tested on any runner:
//   - the Windows SPKI pin: the SHA-256 of the Authenticode signer
//     certificate's SubjectPublicKeyInfo, which a certificate from another
//     publisher with the same CN cannot carry (the CN pin alone accepts any
//     publicly trusted certificate whose CN matches);
//   - the macOS team id, which is spliced into a codesign requirement string
//     and so must be a team id and nothing else.

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"

	"github.com/jarvis/sidecar/internal/psquote"
)

var (
	spkiPinRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
	teamIDRe  = regexp.MustCompile(`^[A-Z0-9]{10}$`)
)

// parseSPKIPins reads a comma-separated list of lower-case hex SHA-256
// digests, as the release build stamps it. More than one is how a signing key
// rotation is shipped: one release accepts the old and the new key before the
// new key signs anything (sidecar/packaging/windows/README.md). Anything that
// is not such a list is an error, never an empty pin: a malformed pin must
// refuse every payload rather than pin nothing.
func parseSPKIPins(s string) ([]string, error) {
	if s == "" {
		return nil, fmt.Errorf("no SPKI pin")
	}
	var pins []string
	for _, p := range strings.Split(s, ",") {
		if !spkiPinRe.MatchString(p) {
			return nil, fmt.Errorf("SPKI pin %q is not a lower-case hex SHA-256", p)
		}
		pins = append(pins, p)
	}
	return pins, nil
}

// signerCertScript is the PowerShell that prints the DER of the signer
// certificate of the executable at exe, base64-encoded, or nothing when the
// file carries no signer. The path is quoted as in signerSubjectScript.
func signerCertScript(exe string) string {
	return "$c = (Get-AuthenticodeSignature -FilePath " + psquote.SingleQuoted(exe) +
		").SignerCertificate; if ($c) { [Convert]::ToBase64String($c.RawData) }"
}

// checkSignerSPKI decodes the base64 DER certificate signerCertScript
// printed and requires the SHA-256 of its SubjectPublicKeyInfo to be one of
// the pins.
func checkSignerSPKI(b64, pinList string) error {
	pins, err := parseSPKIPins(pinList)
	if err != nil {
		return fmt.Errorf("this build carries a malformed signer key pin: %v", err)
	}
	der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(der) == 0 {
		return fmt.Errorf("could not read the signer certificate")
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return fmt.Errorf("could not parse the signer certificate: %v", err)
	}
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	got := hex.EncodeToString(sum[:])
	for _, p := range pins {
		if got == p {
			return nil
		}
	}
	return fmt.Errorf("signer key %s is not a pinned publisher key", got)
}

// teamRequirement is the codesign requirement that pins the Developer ID
// team. The team id is spliced into the requirement string, so it must be a
// ten-character Apple team id: a quote in it would end the string and let
// the rest rewrite the requirement. A release build is stamped only after
// require-signing-pin.sh checked the same shape, so an error here means a
// build that bypassed that check, and it refuses every payload.
func teamRequirement(team string) (string, error) {
	if !teamIDRe.MatchString(team) {
		return "", fmt.Errorf("this build carries a malformed team id pin %q", team)
	}
	return `anchor apple generic and certificate leaf[subject.OU] = "` + team + `"`, nil
}

// codesignVerifyArgs is the codesign command line VerifyPayloadSignature runs
// on macOS: with a team pin (release builds) the requirement pins the
// Developer ID team, so a valid-but-foreign signature is refused; empty (dev
// builds) verifies the signature chain only.
func codesignVerifyArgs(app, team string) ([]string, error) {
	if team == "" {
		return []string{"--verify", "--deep", "--strict", app}, nil
	}
	req, err := teamRequirement(team)
	if err != nil {
		return nil, err
	}
	return []string{"--verify", "--deep", "--strict", "-R=" + req, app}, nil
}

// windowsPinChecks says which publisher pins VerifyPayloadSignature applies
// on Windows. Neither pin (dev builds): the chain only. Both (release
// builds): both. A CN pin without the key pin is refused outright (#1165
// review): every release build stamps both (build-sidecar.sh and the
// installer build fail rather than ship one), so a build with only the CN
// was made some other way, and would fall back to the pin that any trusted
// certificate with the same CN passes. The key pin alone is applied alone.
func windowsPinChecks(cn, spki string) (checkSPKI, checkCN bool, err error) {
	if cn != "" && spki == "" {
		return false, false, fmt.Errorf("this build pins the publisher CN but not its key, so it refuses every payload")
	}
	return spki != "", cn != "", nil
}
