package main

import (
	"fmt"
	"net/url"
	"strings"
	"testing"
)

func mustParse(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return u
}

// The scheme decision is the part of #526 that can be proven without a browser,
// so it is tested as a table: every shape that has been used to smuggle a
// scheme past a check like this, plus the ordinary URLs that must keep working.

func TestCheckNavigationURLAllows(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // exact string that must be handed to Page.navigate
	}{
		{"plain https", "https://example.com/", "https://example.com/"},
		{"http with query and fragment", "http://example.com/a?b=c#d", "http://example.com/a?b=c#d"},
		// The collapse lowercases an http(s) scheme, as `new URL().href` does:
		// Chrome is handed the scheme spelling this function checked.
		{"uppercase scheme", "HTTPS://Example.com/A", "https://Example.com/A"},
		{"about blank", "about:blank", "about:blank"},
		{"about blank with fragment", "about:blank#file:", "about:blank#file:"},
		{"about blank with query", "about:blank?x", "about:blank?x"},
		{"about blank mixed case", "about:BLANK", "about:BLANK"},
		// The parity fixture loads its page this way; the data payload must
		// reach Chrome byte for byte.
		{"data html", "data:text/html,%3Ch1%3Ehi%3C%2Fh1%3E", "data:text/html,%3Ch1%3Ehi%3C%2Fh1%3E"},
		{"data raw markup", "data:text/html,<h1>hi</h1>", "data:text/html,<h1>hi</h1>"},
		{"data base64", "data:text/html;base64,PGgxPmhpPC9oMT4=", "data:text/html;base64,PGgxPmhpPC9oMT4="},
		{"surrounding whitespace is trimmed", "  https://example.com/  ", "https://example.com/"},
		{"loopback on an ordinary port", "http://127.0.0.1:3000/", "http://127.0.0.1:3000/"},
		{"loopback on the default port", "http://localhost/", "http://localhost/"},
		// Userinfo that merely LOOKS like a DevTools endpoint: the host is
		// example.com, so this is an ordinary web page.
		{"devtools port as userinfo", "http://127.0.0.1:9222@example.com/", "http://127.0.0.1:9222@example.com/"},
		{"public host on a devtools port", "http://example.com:9222/", "http://example.com:9222/"},
		// WHATWG skips the slashes after a special scheme; so do we, and the
		// normalised form is what Chrome is handed.
		{"single slash authority", "http:/example.com/x", "http://example.com/x"},
		{"no slash authority", "http:example.com/x", "http://example.com/x"},
		{"backslash authority", "http:\\\\example.com/x", "http://example.com/x"},
		{"backslash inside path", "http://example.com\\a\\b", "http://example.com/a/b"},
		{"backslash kept in fragment", "http://example.com/a#b\\c", "http://example.com/a#b\\c"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := checkNavigationURL(tc.in)
			if err != nil {
				t.Fatalf("checkNavigationURL(%q) refused: %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("checkNavigationURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestCheckNavigationURLRefuses(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // substring the refusal must contain
	}{
		{"file", "file:///etc/passwd", "does not open local files"},
		{"file uppercase scheme", "FILE:///etc/passwd", "does not open local files"},
		{"file mixed case", "FiLe://localhost/etc/passwd", "does not open local files"},
		{"file no authority", "file:/etc/passwd", "does not open local files"},
		{"file backslashes", "file:\\\\server\\share", "does not open local files"},
		// Chrome strips leading whitespace and control bytes before parsing,
		// and removes TAB/CR/LF from anywhere in the URL: all of these ARE
		// file: to Chrome, so all of them must read as file: here.
		{"file leading space", " file:///etc/passwd", "does not open local files"},
		{"file leading tab", "\tfile:///etc/passwd", "does not open local files"},
		{"file leading newline", "\nfile:///etc/passwd", "does not open local files"},
		{"file leading NUL", "\x00file:///etc/passwd", "does not open local files"},
		{"file split by newline", "fi\nle:///etc/passwd", "does not open local files"},
		{"file split by tab", "fi\tle:///etc/passwd", "does not open local files"},
		{"file split by CR", "fi\rle:///etc/passwd", "does not open local files"},
		{"view-source of a file", "view-source:file:///etc/passwd", "is not a web address"},
		{"view-source of a page", "view-source:https://example.com", "is not a web address"},
		{"filesystem", "filesystem:http://example.com/temporary/x", "is not a web address"},
		{"chrome", "chrome://settings", "is not a web address"},
		{"chrome-extension", "chrome-extension://abc/page.html", "is not a web address"},
		{"devtools", "devtools://devtools/bundled/inspector.html", "is not a web address"},
		{"javascript", "javascript:alert(1)", "is not a web address"},
		{"blob", "blob:https://example.com/uuid", "is not a web address"},
		{"about settings", "about:settings", "about:blank"},
		{"about with authority", "about://blank", "about:blank"},
		{"about blank path suffix", "about:blank/../settings", "about:blank"},
		{"no scheme", "example.com/foo", "is not a valid URL"},
		{"scheme-relative", "//example.com/foo", "is not a valid URL"},
		{"empty", "", "No URL given"},
		{"whitespace only", "   \t\n ", "No URL given"},
		{"bare http", "http:", "is not a valid URL"},
		{"host-shaped scheme", "localhost:8080/x", "is not a web address"},
		// The DevTools endpoint of a Jarvis browser on this machine, in every
		// spelling net/url reads differently from Chrome.
		{"devtools port", "http://127.0.0.1:9222/json/list", "DevTools endpoint"},
		{"devtools port 9223", "http://127.0.0.1:9223/json/list", "DevTools endpoint"},
		{"devtools localhost", "http://localhost:9222/json/version", "DevTools endpoint"},
		{"devtools sub.localhost", "http://sub.localhost:9222/", "DevTools endpoint"},
		{"devtools ipv6", "http://[::1]:9222/", "DevTools endpoint"},
		{"devtools unspecified v4", "http://0.0.0.0:9222/", "DevTools endpoint"},
		{"devtools unspecified v6", "http://[::]:9222/", "DevTools endpoint"},
		{"devtools ipv4 mapped", "http://[::ffff:127.0.0.1]:9222/", "DevTools endpoint"},
		{"devtools shorthand 127.1", "http://127.1:9222/", "DevTools endpoint"},
		{"devtools shorthand octal", "http://0177.0.0.1:9222/", "DevTools endpoint"},
		{"devtools shorthand hex", "http://0x7f.1:9222/", "DevTools endpoint"},
		{"devtools shorthand zero", "http://0:9222/", "DevTools endpoint"},
		{"devtools shorthand decimal", "http://2130706433:9222/", "DevTools endpoint"},
		{"devtools trailing dot", "http://localhost.:9222/", "DevTools endpoint"},
		{"devtools uppercase host", "http://LOCALHOST:9222/", "DevTools endpoint"},
		{"devtools single slash", "http:/127.0.0.1:9222/json/list", "DevTools endpoint"},
		{"devtools no slash", "http:127.0.0.1:9222/json/list", "DevTools endpoint"},
		{"devtools mixed-case no slash", "hTtP:127.0.0.1:9222/x", "DevTools endpoint"},
		{"devtools backslashes", "http:\\\\127.0.0.1:9222/x", "DevTools endpoint"},
		{"devtools https single slash", "https:/127.0.0.1:9222/x", "DevTools endpoint"},
		// Chrome reads the authority up to the backslash, so this reaches the
		// DevTools port; the "@example.com" is path, not userinfo.
		{"devtools backslash before at", "http://127.0.0.1:9222\\@example.com/x", "DevTools endpoint"},
		// IDNA maps these onto 127.0.0.1 / localhost before Chrome resolves them.
		{"devtools fullwidth digits", "http://１２７.0.0.1:9222/", "DevTools endpoint"},
		{"devtools ideographic dots", "http://127。0。0。1:9222/", "DevTools endpoint"},
		{"devtools fullwidth localhost", "http://ｌｏｃａｌｈｏｓｔ:9222/", "DevTools endpoint"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := checkNavigationURL(tc.in)
			if err == nil {
				t.Fatalf("checkNavigationURL(%q) allowed it, returning %q", tc.in, got)
			}
			if got != "" {
				t.Fatalf("checkNavigationURL(%q) returned %q alongside its error", tc.in, got)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("checkNavigationURL(%q) error %q does not mention %q", tc.in, err, tc.want)
			}
		})
	}
}

// The refusal text is the user-visible half of this change and has to read like
// the daemon's (src/actions/browser/url-policy.ts), or the same URL refused by
// a local and a remote browser looks like two different rules.
func TestRefusalWordingMatchesDaemon(t *testing.T) {
	_, err := checkNavigationURL("file:///etc/passwd")
	if err == nil {
		t.Fatal("file: was allowed")
	}
	want := `Refusing to open file:///etc/passwd: the browser does not open local files. ` +
		`The browser only opens http://, https://, data: and about:blank URLs (got "file:").`
	if err.Error() != want {
		t.Fatalf("refusal text\n got: %s\nwant: %s", err, want)
	}

	_, err = checkNavigationURL("http://127.0.0.1:9222/json/list")
	if err == nil {
		t.Fatal("the DevTools endpoint was allowed")
	}
	want = "Refusing to open http://127.0.0.1:9222/json/list: that is a Jarvis browser's DevTools " +
		"endpoint, which can open local files in new tabs. Open a web page instead."
	if err.Error() != want {
		t.Fatalf("DevTools refusal text\n got: %s\nwant: %s", err, want)
	}

	_, err = checkNavigationURL("about:settings")
	if err == nil {
		t.Fatal("about:settings was allowed")
	}
	want = `Refusing to open about:settings: about: pages other than about:blank map to ` +
		`browser-internal chrome:// pages. The browser only opens http://, https://, data: and ` +
		`about:blank URLs (got "about:").`
	if err.Error() != want {
		t.Fatalf("about: refusal text\n got: %s\nwant: %s", err, want)
	}
}

// A refused URL is logged and returned to the model. An interior escape byte
// must not travel with it into a terminal.
func TestRefusalStripsControlCharacters(t *testing.T) {
	_, err := checkNavigationURL("file:///etc/\x1b[2Jpasswd\x07")
	if err == nil {
		t.Fatal("file: was allowed")
	}
	for _, bad := range []string{"\x1b", "\a"} {
		if strings.Contains(err.Error(), bad) {
			t.Fatalf("refusal %q still carries a control character", err.Error())
		}
	}
}

func TestRefusalTruncatesLongInput(t *testing.T) {
	long := "https://example.com/" + strings.Repeat("a", 500) + ":9222"
	_, err := checkNavigationURL("javascript:" + long)
	if err == nil {
		t.Fatal("javascript: was allowed")
	}
	if len(err.Error()) > 400 {
		t.Fatalf("refusal is %d bytes; it should truncate the URL", len(err.Error()))
	}
	if !strings.Contains(err.Error(), "...") {
		t.Fatalf("truncated refusal should end the URL with an ellipsis: %s", err)
	}
}

func TestIsLoopbackHost(t *testing.T) {
	loopback := []string{
		"localhost", "LOCALHOST", "localhost.", "sub.localhost", "a.b.localhost",
		"127.0.0.1", "127.0.0.2", "127.255.255.254", "0.0.0.0",
		"::1", "[::1]", "::", "::ffff:127.0.0.1",
		"127.1", "127.0.1", "0177.0.0.1", "0x7f.1", "0x7f.0.0.1", "0", "2130706433",
		"１２７.0.0.1", "127。0。0。1",
	}
	for _, h := range loopback {
		t.Run("loopback/"+h, func(t *testing.T) {
			if !isLoopbackHost(h) {
				t.Fatalf("isLoopbackHost(%q) = false, want true", h)
			}
		})
	}
	// Hosts that only LOOK local. 127.0.0.1.nip.io really does resolve to
	// loopback, but that is a DNS fact no string check can know: the Fetch
	// guard's port patterns are what stop it.
	notLoopback := []string{
		"example.com", "localhost.example.com", "notlocalhost", "localhost6",
		"128.0.0.1", "126.255.255.255", "1.2.3.4", "0.0.0.1", "::2", "2001:db8::1",
		"127.0.0.1.nip.io", "my-localhost", "08.0.0.1", "0x.0.0.1.example.com", "",
	}
	for _, h := range notLoopback {
		t.Run("public/"+h, func(t *testing.T) {
			if isLoopbackHost(h) {
				t.Fatalf("isLoopbackHost(%q) = true, want false", h)
			}
		})
	}
}

func TestIsLocalContentURL(t *testing.T) {
	local := []string{
		"file:///etc/passwd", "FILE:///etc/passwd", "file://localhost/etc/passwd",
		"view-source:file:///etc/passwd", "VIEW-SOURCE:https://example.com",
		"filesystem:http://example.com/temporary/x", " file:///etc/passwd",
		"fi\nle:///etc/passwd",
	}
	for _, u := range local {
		t.Run("local/"+u, func(t *testing.T) {
			if !isLocalContentURL(u) {
				t.Fatalf("isLocalContentURL(%q) = false, want true", u)
			}
		})
	}
	remote := []string{
		"https://example.com/file:", "http://example.com/?x=file:///etc/passwd",
		"about:blank", "data:text/html,hi", "", "https://files.example.com/",
	}
	for _, u := range remote {
		t.Run("remote/"+u, func(t *testing.T) {
			if isLocalContentURL(u) {
				t.Fatalf("isLocalContentURL(%q) = true, want false", u)
			}
		})
	}
}

func TestBlockedRequestReason(t *testing.T) {
	blocked := map[string]string{
		"file:///etc/passwd":               "does not load local files",
		"FILE:///etc/passwd":               "does not load local files",
		"file://localhost/etc/passwd":      "does not load local files",
		"http://127.0.0.1:9222/json/list":  "DevTools port",
		"http://example.com:9222/":         "DevTools port",
		"https://127.0.0.1:9223/json/new":  "DevTools port",
		"http://127.0.0.1.nip.io:9222/x":   "DevTools port",
		"ws://127.0.0.1:9222/devtools/abc": "DevTools port",
		"not a url":                        "unparseable",
	}
	for u, want := range blocked {
		t.Run("blocked/"+u, func(t *testing.T) {
			got := blockedRequestReason(u)
			if !strings.Contains(got, want) {
				t.Fatalf("blockedRequestReason(%q) = %q, want it to mention %q", u, got, want)
			}
		})
	}
	// Everything else MUST be continued, or the page hangs. The port patterns
	// are wildcards over the URL text, so a ":9222" that is not a port reaches
	// the handler and has to pass.
	allowed := []string{
		"https://example.com/", "http://example.com/", "https://example.com/a:9222/b",
		"https://example.com/?redirect=http://127.0.0.1:9222/", "data:text/html,hi",
		"about:blank", "blob:https://example.com/uuid", "https://example.com:443/",
	}
	for _, u := range allowed {
		t.Run("allowed/"+u, func(t *testing.T) {
			if got := blockedRequestReason(u); got != "" {
				t.Fatalf("blockedRequestReason(%q) = %q, want it to be continued", u, got)
			}
		})
	}
}

// The port branch of blockedRequestReason is only reachable if Fetch.enable
// actually asks Chrome to pause those requests.
func TestFetchGuardPatternsCoverEveryBlockedPort(t *testing.T) {
	patterns := fetchGuardPatterns()
	if len(patterns) != 1+len(devtoolsBlockedPorts) {
		t.Fatalf("got %d patterns for 1 file pattern + %d ports: %v",
			len(patterns), len(devtoolsBlockedPorts), patterns)
	}
	if patterns[0]["urlPattern"] != "file:*" {
		t.Fatalf("first pattern is %v, want file:*", patterns[0]["urlPattern"])
	}
	for _, port := range devtoolsBlockedPorts {
		want := fmt.Sprintf("*://*:%d/*", port)
		found := false
		for _, p := range patterns {
			if p["urlPattern"] == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("no Fetch pattern for blocked port %d: %v", port, patterns)
		}
	}
}

func TestEffectiveURLPortDefaults(t *testing.T) {
	cases := map[string]int{
		"http://example.com/":       80,
		"https://example.com/":      443,
		"http://example.com:8080/":  8080,
		"https://example.com:9222/": 9222,
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) {
			u := mustParse(t, raw)
			if got := effectiveURLPort(u); got != want {
				t.Fatalf("effectiveURLPort(%q) = %d, want %d", raw, got, want)
			}
		})
	}
}
