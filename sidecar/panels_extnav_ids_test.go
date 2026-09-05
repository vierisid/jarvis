package main

// The vtable slots and IID in panels_extnav_ids.go are ABI magic numbers that
// no compiler checks and no Windows-only test could reach on this host: get one
// wrong and the panel's new-window handler calls through the wrong function
// pointer on a user's machine. So re-derive them from the vendored SDK header
// on every run, on every host — the same guard winchrome's webview2_ids_test.go
// gives the accelerator-key path.

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const panelWebView2Header = "third_party/webview_go/libs/mswebview2/include/WebView2.h"

func readPanelWebView2Header(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.FromSlash(panelWebView2Header))
	if err != nil {
		// Never Skip: a missing header means the vendored SDK moved, and
		// silently passing would leave the slots unchecked from then on.
		t.Fatalf("cannot read the vendored WebView2 header: %v", err)
	}
	return strings.ReplaceAll(string(b), "\r", "")
}

var panelVtblMethodRe = regexp.MustCompile(`\*\s*(\w+)\s*\)\s*\(`)

func panelVtableMethods(t *testing.T, src, iface string) []string {
	t.Helper()
	// The trailing \b matters: without it "ICoreWebView2Vtbl" also matches
	// inside "ICoreWebView2ControllerVtbl" and the parse reads the wrong struct.
	open := regexp.MustCompile(`typedef struct ` + iface + `Vtbl\b`)
	loc := open.FindStringIndex(src)
	if loc == nil {
		t.Fatalf("%s: no Vtbl struct in the vendored header", iface)
	}
	rest := src[loc[1]:]
	end := strings.Index(rest, "} "+iface+"Vtbl;")
	if end < 0 {
		t.Fatalf("%s: unterminated Vtbl struct", iface)
	}
	var methods []string
	for _, m := range panelVtblMethodRe.FindAllStringSubmatch(rest[:end], -1) {
		methods = append(methods, m[1])
	}
	if len(methods) < 3 || methods[0] != "QueryInterface" || methods[1] != "AddRef" || methods[2] != "Release" {
		t.Fatalf("%s: parse looks wrong — first slots are %v, want QueryInterface/AddRef/Release", iface, methods)
	}
	return methods
}

func TestPanelExtNavVtableIndicesMatchTheVendoredSDK(t *testing.T) {
	src := readPanelWebView2Header(t)
	for _, c := range []struct {
		iface  string
		method string
		want   int
	}{
		{"ICoreWebView2Controller", "get_CoreWebView2", idxPanelControllerGetCoreWebView2},
		{"ICoreWebView2", "add_NewWindowRequested", idxPanelCoreWebView2AddNewWindowRequested},
		{"ICoreWebView2NewWindowRequestedEventArgs", "get_Uri", idxPanelNewWindowArgsGetUri},
		{"ICoreWebView2NewWindowRequestedEventArgs", "put_Handled", idxPanelNewWindowArgsPutHandled},
		// Pinned through the same parser so a bad derivation shows up here.
		{"ICoreWebView2NewWindowRequestedEventArgs", "Release", idxPanelIUnknownRelease},
	} {
		methods := panelVtableMethods(t, src, c.iface)
		got := -1
		for i, m := range methods {
			if m == c.method {
				got = i
				break
			}
		}
		if got < 0 {
			t.Errorf("%s::%s is not in the vendored header at all", c.iface, c.method)
			continue
		}
		if got != c.want {
			at := "past the end of the vtable"
			if c.want >= 0 && c.want < len(methods) {
				at = strconv.Quote(methods[c.want])
			}
			t.Errorf("%s::%s is vtable slot %d, but panels_extnav_ids.go says %d — slot %d is %s",
				c.iface, c.method, got, c.want, c.want, at)
		}
	}
}

var panelHandlerIIDDecl = regexp.MustCompile(
	`IID_ICoreWebView2NewWindowRequestedEventHandler\s*=\s*\{\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*\{([^}]*)\}`)

func TestPanelHandlerIIDMatchesTheVendoredSDK(t *testing.T) {
	m := panelHandlerIIDDecl.FindStringSubmatch(readPanelWebView2Header(t))
	if m == nil {
		t.Fatal("IID_ICoreWebView2NewWindowRequestedEventHandler is not declared in the vendored header")
	}
	hex := func(s string) uint64 {
		v, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimSpace(s), "0x"), 16, 64)
		if err != nil {
			t.Fatalf("bad literal %q: %v", s, err)
		}
		return v
	}
	var want comGUID
	want.Data1 = uint32(hex(m[1]))
	want.Data2 = uint16(hex(m[2]))
	want.Data3 = uint16(hex(m[3]))
	parts := strings.Split(m[4], ",")
	if len(parts) != 8 {
		t.Fatalf("Data4 has %d bytes, want 8", len(parts))
	}
	for i, p := range parts {
		want.Data4[i] = byte(hex(p))
	}
	if want != iidNewWindowRequestedHandler {
		t.Errorf("IID drift:\n  header: %#v\n  ours:   %#v", want, iidNewWindowRequestedHandler)
	}
}
