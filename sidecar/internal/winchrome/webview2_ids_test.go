package winchrome

// The vtable slots in webview2_ids.go are magic numbers that no compiler
// checks and no Linux test could otherwise reach: get them wrong and the code
// calls through the wrong function pointer on a user's machine, with the
// arguments of a different method. So rather than trusting the constants, this
// re-derives them from the vendored SDK header on every run, on every host.
//
// It also catches the case that would otherwise be invisible: Microsoft adding
// a method to an interface in a header bump, which shifts every slot after it.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const webView2Header = "../../third_party/webview_go/libs/mswebview2/include/WebView2.h"

func readWebView2Header(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.FromSlash(webView2Header))
	if err != nil {
		// Never Skip: a missing header means the vendored SDK moved, and
		// silently passing would leave the slots unchecked from then on.
		t.Fatalf("cannot read the vendored WebView2 header: %v", err)
	}
	// .gitattributes forces eol=lf, but the file arrives from Microsoft with
	// CRLF; strip defensively so the parse never depends on that holding.
	return strings.ReplaceAll(string(b), "\r", "")
}

// vtableMethods returns an interface's vtable slots in declaration order.
var vtblMethod = regexp.MustCompile(`\*\s*(\w+)\s*\)\s*\(`)

func vtableMethods(t *testing.T, src, iface string) []string {
	t.Helper()
	// The trailing boundary matters: without it "ICoreWebView2Vtbl" also
	// matches inside "ICoreWebView2ControllerVtbl" and the whole parse silently
	// reads the wrong interface.
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
	for _, m := range vtblMethod.FindAllStringSubmatch(rest[:end], -1) {
		methods = append(methods, m[1])
	}
	// Self-check the parser before trusting a single index off it. Every COM
	// vtable starts with IUnknown; a parse that does not see those three has
	// mis-aligned, and mis-aligned indices are worse than no test at all.
	if len(methods) < 3 || methods[0] != "QueryInterface" || methods[1] != "AddRef" || methods[2] != "Release" {
		t.Fatalf("%s: parse looks wrong — first slots are %v, want QueryInterface/AddRef/Release", iface, methods)
	}
	return methods
}

func TestVtableIndicesMatchTheVendoredSDK(t *testing.T) {
	src := readWebView2Header(t)
	for _, c := range []struct {
		iface  string
		method string
		want   int
	}{
		{"ICoreWebView2Controller", "get_CoreWebView2", idxControllerGetCoreWebView2},
		{"ICoreWebView2", "get_Settings", idxCoreWebView2GetSettings},
		{"ICoreWebView2Settings3", "put_AreBrowserAcceleratorKeysEnabled", idxSettings3PutBrowserAcceleratorKeys},
		// Pinned through the same parser so a bad derivation shows up here
		// rather than as a wrong answer for the three above.
		{"ICoreWebView2Settings3", "Release", idxIUnknownRelease},
	} {
		methods := vtableMethods(t, src, c.iface)
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
			// Name what the wrong slot actually holds: that is the call the
			// shipped binary would make, and it is the fastest way to see how
			// far the vtable has shifted.
			at := "past the end of the vtable"
			if c.want >= 0 && c.want < len(methods) {
				at = strconv.Quote(methods[c.want])
			}
			t.Errorf("%s::%s is vtable slot %d, but webview2_ids.go says %d — slot %d is %s",
				c.iface, c.method, got, c.want, c.want, at)
		}
	}
}

// iidDecl matches the header's EXTERN_C IID definition, e.g.
// const IID IID_ICoreWebView2Settings3 = {0xfdb5ab74,0xaf33,0x4854,{0x84,...}};
var iidDecl = regexp.MustCompile(
	`IID_ICoreWebView2Settings3\s*=\s*\{\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*\{([^}]*)\}`)

func TestSettings3IIDMatchesTheVendoredSDK(t *testing.T) {
	m := iidDecl.FindStringSubmatch(readWebView2Header(t))
	if m == nil {
		t.Fatal("IID_ICoreWebView2Settings3 is not declared in the vendored header")
	}
	hex := func(s string) uint64 {
		v, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimSpace(s), "0x"), 16, 64)
		if err != nil {
			t.Fatalf("bad literal %q: %v", s, err)
		}
		return v
	}
	var want guid
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
	if want != iidCoreWebView2Settings3 {
		t.Errorf("IID drift:\n  header: %s\n  ours:   %s", fmtGUID(want), fmtGUID(iidCoreWebView2Settings3))
	}
}

func fmtGUID(g guid) string {
	return fmt.Sprintf("{%#x,%#x,%#x,%#v}", g.Data1, g.Data2, g.Data3, g.Data4)
}
