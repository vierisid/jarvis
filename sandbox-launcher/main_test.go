package main

import (
	"os"
	"reflect"
	"testing"
)

// The test binary doubles as the launcher: run with JARVIS_SANDBOX_HELPER=1,
// it is main() and nothing else.
func TestMain(m *testing.M) {
	if os.Getenv("JARVIS_SANDBOX_HELPER") == "1" {
		os.Args = append([]string{os.Args[0]}, os.Args[2:]...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestParseArgs(t *testing.T) {
	p, err := parseArgs([]string{"--ro", "/usr", "--rw", "/tmp/x", "--ro", "/etc/ssl", "--", "/bin/true", "-v"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(p.readOnly, []string{"/usr", "/etc/ssl"}) || !reflect.DeepEqual(p.readWrite, []string{"/tmp/x"}) {
		t.Fatalf("paths: %+v", p)
	}
	if !reflect.DeepEqual(p.argv, []string{"/bin/true", "-v"}) {
		t.Fatalf("argv: %v", p.argv)
	}

	if p, err := parseArgs([]string{"--abi"}); err != nil || !p.abiOnly {
		t.Fatalf("--abi: %+v %v", p, err)
	}

	for _, bad := range [][]string{
		{"--ro", "relative", "--", "/bin/true"},
		{"--rw"},
		{"--ro", "/usr"},
		{"--ro", "/usr", "--", "true"},
		{"--bogus", "--", "/bin/true"},
	} {
		if _, err := parseArgs(bad); err == nil {
			t.Errorf("parseArgs(%q) accepted", bad)
		}
	}
}
