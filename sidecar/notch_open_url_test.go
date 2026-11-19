package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestNotchOpenURLAllowed(t *testing.T) {
	good := []string{
		"https://collab.example/authorize?client_id=collab-mcp&state=abc&code_challenge=x_y-z",
		"https://collab.example:8443/a/b",
	}
	for _, raw := range good {
		if got, ok := notchOpenURLAllowed(raw); !ok || got != raw {
			t.Errorf("%q: got %q, %v", raw, got, ok)
		}
	}
	bad := []string{
		"",
		"http://collab.example/authorize",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"ms-settings:privacy-microphone",
		"https://",
		"https:///path",
		"https://user:secret@collab.example/",
		"https://user@collab.example/",
		"https:collab.example",
		" https://collab.example/",
		"https://collab.example/ --flag",
		"https://collab.example/\nhttps://other.example/",
		"https://collab.example/\x00",
		"HTTPS-ish://collab.example/",
		"https://collab.example/" + strings.Repeat("a", notchOpenURLMax),
	}
	for _, raw := range bad {
		if got, ok := notchOpenURLAllowed(raw); ok {
			t.Errorf("%q was allowed as %q", raw, got)
		}
	}
}

func TestNotchOpenURLHandler(t *testing.T) {
	var opened []string
	handler := makeNotchOpenURLHandler(func(_ context.Context, url string) error {
		opened = append(opened, url)
		return nil
	})
	result, err := handler(map[string]any{"url": "https://collab.example/authorize?state=1"})
	if err != nil || result.Result.(map[string]any)["opened"] != true {
		t.Fatalf("got %v, %v", result, err)
	}
	if len(opened) != 1 || opened[0] != "https://collab.example/authorize?state=1" {
		t.Fatalf("opened %v", opened)
	}
	// What is not an address to open reaches no browser.
	for _, params := range []map[string]any{{}, {"url": 7}, {"url": "http://collab.example/"}, {"url": "file:///c:/windows/system32/calc.exe"}} {
		if _, err := handler(params); err == nil {
			t.Errorf("%v was not refused", params)
		}
	}
	if len(opened) != 1 {
		t.Fatalf("something else was opened: %v", opened)
	}
	failing := makeNotchOpenURLHandler(func(context.Context, string) error { return errors.New("no browser") })
	if _, err := failing(map[string]any{"url": "https://collab.example/"}); err == nil {
		t.Fatal("a browser that did not take it was reported as opened")
	}
}
