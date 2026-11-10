package update

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// selfSigned makes a certificate with the given CN and a fresh key, and
// returns it as signerCertScript prints it (base64 DER) with the SPKI pin of
// its key.
func selfSigned(t *testing.T, cn string) (b64, pin string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: cn, Organization: []string{cn}},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return base64.StdEncoding.EncodeToString(der), hex.EncodeToString(sum[:])
}

// #1165: the CN pin accepts any trusted certificate whose CN matches. The
// SPKI pin accepts only the pinned key, whatever the certificate says.
func TestSignerSPKIPinRefusesSameCNOtherKey(t *testing.T) {
	ours, ourPin := selfSigned(t, "Usejarvis Inc.")
	theirs, theirPin := selfSigned(t, "Usejarvis Inc.")
	if ourPin == theirPin {
		t.Fatal("two fresh keys hashed alike")
	}
	if err := checkSignerSPKI(ours, ourPin); err != nil {
		t.Errorf("our own certificate was refused: %v", err)
	}
	// What PowerShell prints ends in a CRLF.
	if err := checkSignerSPKI(ours+"\r\n", ourPin); err != nil {
		t.Errorf("our own certificate with a trailing CRLF was refused: %v", err)
	}
	if err := checkSignerSPKI(theirs, ourPin); err == nil || !strings.Contains(err.Error(), "not a pinned publisher key") {
		t.Errorf("a same-CN certificate with another key was accepted (err %v)", err)
	}
	// A rotation release carries both keys, and accepts either.
	both := ourPin + "," + theirPin
	for _, c := range []string{ours, theirs} {
		if err := checkSignerSPKI(c, both); err != nil {
			t.Errorf("a key on a two-key pin list was refused: %v", err)
		}
	}
}

func TestSignerSPKIPinRefusesWhatItCannotRead(t *testing.T) {
	ours, ourPin := selfSigned(t, "Usejarvis Inc.")
	for name, b64 := range map[string]string{
		"nothing printed (unsigned)": "",
		"not base64":                 "not base64 at all",
		"base64 of no certificate":   base64.StdEncoding.EncodeToString([]byte("hello")),
	} {
		if err := checkSignerSPKI(b64, ourPin); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A malformed pin refuses every payload, our own included: it must
	// never read as "no pin".
	for _, pins := range []string{
		strings.ToUpper(ourPin),
		ourPin + ",",
		"," + ourPin,
		ourPin + ", " + ourPin,
		ourPin[:63],
		ourPin + "0",
		" " + ourPin,
		"sha256:" + ourPin,
	} {
		if err := checkSignerSPKI(ours, pins); err == nil || !strings.Contains(err.Error(), "malformed signer key pin") {
			t.Errorf("pin list %q: our certificate was not refused as a malformed pin (err %v)", pins, err)
		}
	}
}

func TestParseSPKIPins(t *testing.T) {
	a, b := strings.Repeat("a", 64), strings.Repeat("0", 64)
	got, err := parseSPKIPins(a + "," + b)
	if err != nil || len(got) != 2 || got[0] != a || got[1] != b {
		t.Errorf("parseSPKIPins(two pins) = %v, %v", got, err)
	}
	if _, err := parseSPKIPins(""); err == nil {
		t.Error("an empty pin list parsed")
	}
}

// The certificate script quotes the path as the subject script does (#524).
func TestSignerCertScriptQuotesThePath(t *testing.T) {
	const prefix = "$c = (Get-AuthenticodeSignature -FilePath '"
	const suffix = "').SignerCertificate; if ($c) { [Convert]::ToBase64String($c.RawData) }"
	got := signerCertScript("C:\\x\u2019; Start-Process calc; '\\j.exe")
	want := prefix + "C:\\x\u2019\u2019; Start-Process calc; ''\\j.exe" + suffix
	if got != want {
		t.Errorf("signerCertScript\n got  %q\n want %q", got, want)
	}
}

// #1165: the team id is spliced into a codesign requirement string. A team
// id is ten upper-case letters and digits; anything else refuses every
// payload instead of rewriting the requirement.
func TestCodesignVerifyArgsPinsOnlyAWellFormedTeam(t *testing.T) {
	app := "/tmp/x/Jarvis.app"
	got, err := codesignVerifyArgs(app, "D99CATW2CS")
	want := []string{"--verify", "--deep", "--strict",
		`-R=anchor apple generic and certificate leaf[subject.OU] = "D99CATW2CS"`, app}
	if err != nil || strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("codesignVerifyArgs(team) = %q, %v; want %q", got, err, want)
	}
	got, err = codesignVerifyArgs(app, "")
	if err != nil || strings.Join(got, "\x00") != strings.Join([]string{"--verify", "--deep", "--strict", app}, "\x00") {
		t.Errorf("codesignVerifyArgs(no team) = %q, %v", got, err)
	}
	for _, team := range []string{
		`D99CATW2CS" or anchor apple`,
		`X" or identifier "a`,
		"d99catw2cs",
		"D99CATW2C",
		"D99CATW2CSX",
		" D99CATW2CS",
		"D99CATW2C\u0405",
	} {
		if args, err := codesignVerifyArgs(app, team); err == nil {
			t.Errorf("team %q was spliced into %q", team, args)
		}
	}
}

// The release build stamps what .github/scripts/codesign-spki-pins.sh prints
// for the committed chain (openssl). The client computes the key hash with
// crypto/x509. They must agree on the committed leaf, or every release
// refuses its own updates.
func TestCommittedChainKeyPinMatchesTheBuildScript(t *testing.T) {
	for _, tool := range []string{"bash", "openssl", "sha256sum"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not installed", tool)
		}
	}
	const chain = "../../packaging/windows/codesign-chain.pem"
	raw, err := os.ReadFile(chain)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		t.Fatal("no PEM block in the committed chain")
	}
	cmd := exec.Command("bash", "../../../.github/scripts/codesign-spki-pins.sh", "../../packaging/windows")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("codesign-spki-pins.sh: %v: %s", err, stderr.String())
	}
	pins := strings.TrimSpace(string(out))
	if err := checkSignerSPKI(base64.StdEncoding.EncodeToString(block.Bytes), pins); err != nil {
		t.Errorf("the committed leaf does not pass the pin the build would stamp (%q): %v", pins, err)
	}
}

// #1165 review: a CN pin never stands alone; with no key pin beside it the
// build refuses every payload instead of trusting any same-CN certificate.
func TestWindowsPinChecks(t *testing.T) {
	pin := strings.Repeat("a", 64)
	for _, c := range []struct {
		cn, spki     string
		spkiOn, cnOn bool
		refused      bool
	}{
		{"", "", false, false, false},
		{"Usejarvis Inc.", pin, true, true, false},
		{"", pin, true, false, false},
		{"Usejarvis Inc.", "", false, false, true},
	} {
		s, n, err := windowsPinChecks(c.cn, c.spki)
		if (err != nil) != c.refused || s != c.spkiOn || n != c.cnOn {
			t.Errorf("windowsPinChecks(%q, %q) = %v, %v, %v", c.cn, c.spki, s, n, err)
		}
	}
}
