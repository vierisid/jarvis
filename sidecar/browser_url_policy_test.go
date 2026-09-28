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
		// Canonicalised: Chrome compares about:blank's path case sensitively, so
		// the empty page has to be spelled the way it was checked.
		{"about blank mixed case", "about:BLANK", "about:blank"},
		{"about blank mixed case with fragment", "ABOUT:Blank#x", "about:blank#x"},
		{"about blank mixed case with query", "about:BLANK?x=1", "about:blank?x=1"},
		// The parity fixture loads its page this way; the data payload must
		// reach Chrome byte for byte.
		{"data html", "data:text/html,%3Ch1%3Ehi%3C%2Fh1%3E", "data:text/html,%3Ch1%3Ehi%3C%2Fh1%3E"},
		{"data raw markup", "data:text/html,<h1>hi</h1>", "data:text/html,<h1>hi</h1>"},
		{"data base64", "data:text/html;base64,PGgxPmhpPC9oMT4=", "data:text/html;base64,PGgxPmhpPC9oMT4="},
		{"surrounding whitespace is trimmed", "  https://example.com/  ", "https://example.com/"},
		// A `%` that starts no valid escape is literal to Chrome and fatal to
		// net/url. These must pass, and must reach Chrome untouched: escaping
		// them to %25 would change the path requested.
		{"stray percent in path", "https://example.com/discount-100%", "https://example.com/discount-100%"},
		{"stray percent in fragment", "https://example.com/#100%", "https://example.com/#100%"},
		{"invalid escape in path", "https://example.com/%zz", "https://example.com/%zz"},
		{"stray percent in query", "https://example.com/?off=50%&x=1", "https://example.com/?off=50%&x=1"},
		{"truncated escape at the end", "https://example.com/a%2", "https://example.com/a%2"},
		{"loopback on an ordinary port", "http://127.0.0.1:3000/", "http://127.0.0.1:3000/"},
		{"loopback on the default port", "http://localhost/", "http://localhost/"},
		// Userinfo that merely LOOKS like a DevTools endpoint: the host is
		// example.com, so this is an ordinary web page.
		{"devtools port as userinfo", "http://127.0.0.1:9222@example.com/", "http://127.0.0.1:9222@example.com/"},
		// Ordinary IDN browsing keeps working: a non-ASCII host is only folded
		// for the loopback comparison, never rewritten.
		{"idn host", "http://例.com/", "http://例.com/"},
		{"idn host with path", "https://münchen.de/x", "https://münchen.de/x"},
		{"punycode host", "http://xn--fsq.com/", "http://xn--fsq.com/"},
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
		// UTS46 DELETES these before Chrome resolves the host, so all three
		// reach the local endpoint. The fold catches them; the port refusal
		// below catches whatever the fold does not.
		{"devtools soft hyphen in localhost", "http://loc­alhost:9222/", "DevTools endpoint"},
		{"devtools zero-width joiner in an IP", "http://127.0.0‍.1:9222/", "DevTools endpoint"},
		{"devtools one dot leader", "http://127․0․0․1:9222/", "DevTools endpoint"},
		{"devtools circled digits", "http://①②⑦.0.0.1:9222/", "DevTools endpoint"},
		// A DevTools port is refused whatever the host resolves to -- unlike the
		// daemon, and on purpose: no enumeration of Chrome's host mappings is
		// complete, and the Fetch guard blocks these ports on any host anyway.
		{"devtools port on a public host", "http://example.com:9222/", "DevTools port"},
		{"devtools port on a resolving name", "http://127.0.0.1.nip.io:9222/", "DevTools port"},
		{"devtools port on an idn host", "https://例.com:9223/", "DevTools port"},
		// Refused today only because net/url rejects a host escape whose first
		// nibble is < 8. Pinned: if that ever relaxes, these become bypasses.
		{"percent-escaped dot in host", "http://127.0.0%2E1:9222/", "is not a valid URL"},
		{"percent-escaped letter in host", "http://%6Cocalhost:9222/", "is not a valid URL"},
		{"percent-escaped brackets in host", "http://%5B::1%5D:9222/", "is not a valid URL"},
		// A stray `%` in the AUTHORITY is refused, not tolerated: escaping it
		// leaves an escape net/url rejects in a host, so we cannot tell what
		// Chrome would connect to.
		{"stray percent in host", "http://exa%mple.com:9222/", "is not a valid URL"},
		// Interior control bytes: Chrome strips TAB/CR/LF (covered above) but
		// rejects the rest, and so do we.
		{"interior SOH in host", "http://127.0.0.1\x01:9222/", "control characters"},
		{"interior VT in host", "http://127.0.0.1\x0b:9222/", "control characters"},
		{"interior DEL in host", "http://127.0.0.1\x7f:9222/", "control characters"},
		{"interior SOH in path", "http://127.0.0.1:9222/a\x01b", "control characters"},
		// A TRAILING control byte is trimmed, exactly as Chrome trims it, so
		// this is the DevTools URL and is refused as one.
		{"trailing SOH", "http://127.0.0.1:9222/\x01", "DevTools endpoint"},
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

// The invariant the whole design rests on: the string handed to Page.navigate
// parses to the same scheme, host and port that were checked. Asserted as a
// property over the allow table rather than case by case, because that is what
// catches a normalisation bug as a class.
func TestAllowedURLsReparseToWhatWasChecked(t *testing.T) {
	for _, raw := range []string{
		"https://example.com/", "http://example.com/a?b=c#d", "HTTPS://Example.com/A",
		"about:blank", "about:BLANK#x", "data:text/html,<h1>hi</h1>",
		"http://127.0.0.1:3000/", "http://localhost/", "http://127.0.0.1:9222@example.com/",
		"http:/example.com/x", "http:example.com/x", "http:\\\\example.com/x",
		"http://example.com\\a\\b", "http://例.com/", "http://xn--fsq.com/",
		"  https://example.com/  ",
	} {
		t.Run(raw, func(t *testing.T) {
			got, err := checkNavigationURL(raw)
			if err != nil {
				t.Fatalf("checkNavigationURL(%q) refused: %v", raw, err)
			}
			// Re-checking the returned URL must reach the same verdict and the
			// same string: a URL that passed cannot become one that would not.
			again, err := checkNavigationURL(got)
			if err != nil {
				t.Fatalf("the returned %q would be refused on its own: %v", got, err)
			}
			if again != got {
				t.Fatalf("checkNavigationURL is not idempotent: %q -> %q -> %q", raw, got, again)
			}
			u, err := url.Parse(got)
			if err != nil {
				t.Fatalf("the returned %q does not parse: %v", got, err)
			}
			scheme := strings.ToLower(u.Scheme)
			if !allowedNavigationSchemes[scheme] && scheme != "about" {
				t.Fatalf("the returned %q has scheme %q, which is not on the allowlist", got, scheme)
			}
			if scheme == "http" || scheme == "https" {
				if u.Host == "" || u.Opaque != "" {
					t.Fatalf("the returned %q has no authority (host %q, opaque %q)", got, u.Host, u.Opaque)
				}
				if isDevtoolsPort(effectiveURLPort(u)) {
					t.Fatalf("the returned %q is on a DevTools port after being allowed", got)
				}
			}
			if isLocalContentURL(got) || isPrivilegedPageURL(got) {
				t.Fatalf("the returned %q would be refused as unreadable", got)
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

// The parity fixture's real spelling, not a hand-written approximation of it:
// browser_parity_test.go builds its data: URL this way and the page must reach
// Chrome byte for byte.
func TestParityFixtureDataURLSurvivesTheAllowlist(t *testing.T) {
	in := "data:text/html," + url.PathEscape(parityTestPage)
	got, err := checkNavigationURL(in)
	if err != nil {
		t.Fatalf("the parity fixture URL was refused: %v", err)
	}
	if got != in {
		t.Fatalf("the parity fixture URL was rewritten:\n got: %s\nwant: %s", got, in)
	}
}

// Chrome strips TAB/CR/LF from a URL wherever they appear, data: payloads
// included, so this is correct rather than surprising -- pinned because it is
// surprising.
func TestDataURLNewlinesAreStrippedLikeChromeDoes(t *testing.T) {
	got, err := checkNavigationURL("data:text/html,<p>a\nb</p>")
	if err != nil {
		t.Fatalf("data: with a newline was refused: %v", err)
	}
	if got != "data:text/html,<p>ab</p>" {
		t.Fatalf("got %q, want the newline removed", got)
	}
}

func TestWhatwgIPv4(t *testing.T) {
	ok := map[string]uint32{
		"127.0.0.1":  0x7f000001,
		"127.1":      0x7f000001,
		"127.0.1":    0x7f000001,
		"0177.0.0.1": 0x7f000001,
		"0x7f.1":     0x7f000001,
		"0x7f000001": 0x7f000001,
		"2130706433": 0x7f000001,
		"2130706432": 0x7f000000,
		"0":          0,
		"0x":         0,
		"1.2.3.4":    0x01020304,
		"127.0.0.1.": 0x7f000001, // one trailing dot is stripped
		// A single number covers all four bytes, so "256" is 0.0.1.0 -- an
		// address, just not a loopback one.
		"256": 0x00000100,
	}
	for host, want := range ok {
		t.Run("ipv4/"+host, func(t *testing.T) {
			got, isIP := whatwgIPv4(host)
			if !isIP {
				t.Fatalf("whatwgIPv4(%q) said it is not an address", host)
			}
			if got != want {
				t.Fatalf("whatwgIPv4(%q) = %#x, want %#x", host, got, want)
			}
		})
	}
	notIP := []string{
		"", "example.com", "127.0.0.1.nip.io", "08.0.0.1", "127.0.0.256",
		"1.2.3.4.5", "127.0.0.1..", "0x7f.0x0.0x0.0x1x", "99999999999999999999",
		"4294967296", "127.0.0.-1", "256.0.0.1",
	}
	for _, host := range notIP {
		t.Run("notip/"+host, func(t *testing.T) {
			if _, isIP := whatwgIPv4(host); isIP {
				t.Fatalf("whatwgIPv4(%q) claimed it is an address", host)
			}
		})
	}
}

// The browser's own pages are refused on the read paths (beyond #526's three
// prefixes), but an error page is not: a snapshot of one is how the model finds
// out why a page did not load.
func TestIsPrivilegedPageURL(t *testing.T) {
	privileged := []string{
		"chrome://settings/passwords", "CHROME://history", "chrome-untrusted://x",
		"chrome-extension://abcdef/page.html", "devtools://devtools/bundled/inspector.html",
		"chrome-search://local-ntp/local-ntp.html",
	}
	for _, u := range privileged {
		t.Run("privileged/"+u, func(t *testing.T) {
			if !isPrivilegedPageURL(u) {
				t.Fatalf("isPrivilegedPageURL(%q) = false, want true", u)
			}
		})
	}
	ordinary := []string{
		"https://example.com/", "about:blank", "data:text/html,hi", "",
		"chrome-error://chromewebdata/", "https://chrome.example.com/",
		"https://example.com/chrome://settings",
	}
	for _, u := range ordinary {
		t.Run("ordinary/"+u, func(t *testing.T) {
			if isPrivilegedPageURL(u) {
				t.Fatalf("isPrivilegedPageURL(%q) = true, want false", u)
			}
		})
	}
}

func TestIsDrivableURL(t *testing.T) {
	drivable := []string{"https://example.com/", "about:blank", "data:text/html,hi", "http://127.0.0.1:3000/"}
	for _, u := range drivable {
		if !isDrivableURL(u) {
			t.Fatalf("isDrivableURL(%q) = false, want true", u)
		}
	}
	notDrivable := []string{
		"file:///etc/passwd", "chrome://settings", "devtools://devtools/x",
		"view-source:https://example.com", "chrome-error://chromewebdata/",
		"http://127.0.0.1:9222/json/list", "", "about:settings",
	}
	for _, u := range notDrivable {
		if isDrivableURL(u) {
			t.Fatalf("isDrivableURL(%q) = true, want false", u)
		}
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
		"wss://127.0.0.1:9223/devtools":    "DevTools port",
		"http://0.0.0.0:9222/":             "DevTools port",
		"ftp://example.com:9222/x":         "DevTools port",
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
		// Chrome leaves a stray "%" literal in a path; net/url refuses to parse
		// it. These reach the guard because ":9222" matched the port pattern as
		// TEXT, and failing them would break a page over a punctuation mark.
		"https://example.com/x:9222/100%discount",
		"https://example.com/x:9222/a%zz",
		"https://example.com/x:9222/a%",
		"https://example.com/x:9222/a%2",
		"ftp://example.com/x", // no port: the default arm, not a DevTools port
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
		"ws://example.com/":         80,
		"wss://example.com/":        443,
		"ftp://example.com/":        80,
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) {
			u := mustParse(t, raw)
			if got := effectiveURLPort(u); got != want {
				t.Fatalf("effectiveURLPort(%q) = %d, want %d", raw, got, want)
			}
		})
	}

	// url.URL.Port() only ever returns digits (a non-numeric ":suffix" is part
	// of the host), so effectiveURLPort's -1 arm is unreachable today. Pin the
	// direction it fails in, for whoever makes it reachable.
	if !isDevtoolsPort(-1) {
		t.Fatal("isDevtoolsPort(-1) = false: an unreadable port must fail closed")
	}
}

// A refusal must not echo a string that looks like a valid URL, or the model
// retries the same bytes. Chrome rejects interior control bytes in a host, and
// so do we -- but the message has to say that is why.
func TestControlCharacterRefusalSaysSo(t *testing.T) {
	_, err := checkNavigationURL("http://127.0.0.1\x01:9222/")
	if err == nil {
		t.Fatal("a URL with a control byte in the host was allowed")
	}
	if !strings.Contains(err.Error(), "control characters") {
		t.Fatalf("refusal %q does not mention the control characters", err)
	}
	if strings.Contains(err.Error(), "is not a valid URL") {
		t.Fatalf("refusal %q still shows the stripped URL as if it were the problem", err)
	}
}

// truncateURL counts runes, so a multibyte URL is not cut mid-character.
func TestTruncateURLIsRuneSafe(t *testing.T) {
	long := "https://example.com/" + strings.Repeat("例", 200)
	got := truncateURL(long, 120)
	if len([]rune(got)) != 120 {
		t.Fatalf("truncateURL returned %d runes, want 120", len([]rune(got)))
	}
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("truncateURL(%q...) = %q, want an ellipsis", long[:20], got)
	}
	if strings.ContainsRune(got, '�') {
		t.Fatalf("truncateURL cut a rune in half: %q", got)
	}
}
