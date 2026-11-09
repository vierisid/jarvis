package notices

import (
	"os"
	"strings"
	"testing"
)

func TestTextIsTheNoticesFile(t *testing.T) {
	want, err := os.ReadFile("THIRD_PARTY_NOTICES.md")
	if err != nil {
		t.Fatal(err)
	}
	if Text != string(want) {
		t.Fatal("the embedded notices differ from THIRD_PARTY_NOTICES.md")
	}
	if !strings.Contains(Text, "### Go standard library and runtime") {
		t.Fatal("the embedded notices do not cover the Go standard library")
	}
}
