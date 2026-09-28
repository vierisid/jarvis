package main

// browser_url_policy.go — where the automation browser may be sent, and which
// requests it may make (#526, the sidecar half of #521).
//
// This is a port of the daemon's src/actions/browser/url-policy.ts and the
// decision half of browser-request-guard.ts. The wording of every refusal, the
// allowlist and the set of blocked ports are copied on purpose: a user who is
// told "the browser does not open local files" by the daemon must be told the
// same thing by a sidecar, or the two look like different products.
//
// `Page.navigate` is a BROWSER-initiated navigation: Chrome applies none of the
// checks it applies to a web page. Handed `file:///home/<user>/.ssh/id_rsa` it
// opens the file, and the next snapshot hands the contents to the model -- and
// to any page that talked the model into asking. The sidecar runs on the user's
// own desktop, so that view is worth more than the daemon's.
//
// ALLOWLIST, NOT DENYLIST. Chrome understands many schemes that reach local or
// privileged content -- `file:`, `filesystem:`, `view-source:file:`, `chrome:`,
// `chrome-extension:`, `devtools:`, and `about:` aliases such as
// `about:settings`, which Chrome rewrites to `chrome://settings`. Naming the
// few that are safe is shorter than predicting all the others:
//
//   - `http:` and `https:` -- the web.
//   - `about:blank` only -- the empty page. Not `about:` in general, because of
//     the `chrome://` aliases above.
//   - `data:` -- kept on purpose. A top-level `data:` document gets an opaque
//     origin: it cannot read `file:`, nor any site's cookies or storage. Its
//     content is whatever the caller wrote into the URL, and browser_evaluate
//     can already run arbitrary script in any page, so `data:` grants nothing
//     new. browser_parity_test.go loads its fixture page this way.
//
// Refused: everything else, `javascript:` and `blob:` included (evaluate covers
// the first; a `blob:` URL is only meaningful inside the page that made it).
//
// ── Go is not the WHATWG parser ──────────────────────────────────────
//
// The daemon gets normalisation free from `new URL()`. `net/url` gives none of
// it, and every difference is a way for our scheme/host to disagree with the
// one Chrome acts on. So the input is normalised the way Chrome's URL cleaner
// and the WHATWG parser do, and only then parsed and compared:
//
//   - TAB/CR/LF are removed from anywhere in the URL and leading/trailing C0
//     and space are trimmed -- Chrome does exactly this before parsing, so
//     "fi\nle:///etc/passwd" IS file: to Chrome, and " http://example.com" is
//     an ordinary web page.
//   - For http/https, the authority introducer is collapsed: a run of `/` or
//     `\` after `scheme:` becomes `//`, and `\` becomes `/` up to the first
//     `?`/`#`. WHATWG skips those slashes; `net/url` does not, and leaves the
//     authority in Opaque or Path with an empty Host -- which is how
//     `http:/127.0.0.1:9222/json/list` and `http://127.0.0.1:9222\@evil/` used
//     to read as hostless URLs here while Chrome connected to the DevTools
//     port. `http://127.0.0.1:9222@example.com/` is userinfo and stays allowed.
//   - Hosts are compared after folding the IDNA-mapped confusables that can
//     spell an address (fullwidth ASCII, ideographic full stops) and after
//     canonicalising WHATWG IPv4 shorthand (`127.1`, `0177.0.0.1`, `0x7f.1`).
//     Chrome does both; `net/url` does neither.
//
// What is NOT caught here: a DNS name that merely resolves to loopback
// (`127.0.0.1.nip.io`), and IDN spellings beyond the folded set. Those are the
// Fetch guard's job -- Chrome reports the canonical URL in
// `Fetch.requestPaused`, so the port patterns catch every spelling.

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// allowedNavigationSchemes are the schemes Page.navigate may be handed.
// `about:` is handled separately: only about:blank is allowed.
var allowedNavigationSchemes = map[string]bool{
	"http":  true,
	"https": true,
	"data":  true,
}

// allowedSchemesSummary matches url-policy.ts ALLOWED_SUMMARY word for word.
const allowedSchemesSummary = "http://, https://, data: and about:blank"

// devtoolsBlockedPorts are the DevTools ports of the browsers Jarvis drives.
// The sidecar's own browser has none -- it speaks CDP over an inherited pipe --
// so this is the daemon's DEFAULT_DEVTOOLS_PORTS (main 9222, background agent
// 9223): a daemon on this same machine serves `PUT /json/new?<url>` there,
// which opens a tab at ANY url, `file:` included, and a page on that origin can
// call it with a plain same-origin fetch. So neither the model nor a page it
// loaded is allowed to reach one.
var devtoolsBlockedPorts = []int{9222, 9223}

// sanitizeURLInput applies Chrome's pre-parse cleanup: remove every TAB, CR and
// LF wherever they appear, then trim leading and trailing C0 controls and
// spaces. Returning the cleaned string (rather than reparsing later) is what
// makes our scheme and Chrome's the same string.
func sanitizeURLInput(raw string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\r', '\n':
			return -1
		}
		return r
	}, raw)
	return strings.Trim(cleaned, "\x00\x01\x02\x03\x04\x05\x06\a\b\v\f\x0e\x0f"+
		"\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f ")
}

// collapseSpecialAuthority rewrites an http/https URL so `net/url` sees the
// authority WHATWG sees. Non-http(s) input is returned untouched: for
// non-special schemes WHATWG does not skip slashes or fold backslashes either.
func collapseSpecialAuthority(in string) string {
	colon := strings.Index(in, ":")
	if colon < 0 {
		return in
	}
	scheme := strings.ToLower(in[:colon])
	if scheme != "http" && scheme != "https" {
		return in
	}
	rest := in[colon+1:]
	// `\` is `/` in the authority and path of a special scheme, but is literal
	// in the query and fragment.
	cut := len(rest)
	if i := strings.IndexAny(rest, "?#"); i >= 0 {
		cut = i
	}
	rest = strings.ReplaceAll(rest[:cut], "\\", "/") + rest[cut:]
	return scheme + "://" + strings.TrimLeft(rest, "/")
}

// foldHostConfusables approximates the UTS46 mapping Chrome runs a host through
// (ICU uidna_openUTS46, non-transitional, STD3 rules OFF) for the characters
// that can spell a host we care about: the code points UTS46 DELETES, the
// fullwidth ASCII block (fullwidth digits and letters), and the full-stop and
// digit variants it maps to ASCII. Anything else is left alone, so an ordinary
// IDN host is still browsable -- it simply is not a loopback spelling we
// recognise.
//
// This is an enumeration, so it is incomplete by construction: it decides which
// REFUSAL a DevTools-port URL gets, not whether it is refused. Refusing that
// port does not depend on the host at all (see checkNavigationURL), and the
// Fetch guard blocks it inside Chrome on any host, which is what makes an
// incomplete fold safe here.
func foldHostConfusables(host string) string {
	return strings.Map(func(r rune) rune {
		switch {
		// UTS46 `ignored`: deleted before the host is resolved, so
		// "loc<U+00AD>alhost" IS localhost to Chrome.
		case r == 0x00AD || r == 0x034F || r == 0x2060 || r == 0xFEFF,
			r >= 0x200B && r <= 0x200D,
			r >= 0x180B && r <= 0x180D,
			r >= 0xFE00 && r <= 0xFE0F:
			return -1
		case r >= 0xFF01 && r <= 0xFF5E:
			return r - 0xFEE0
		// Label separators Chrome accepts for ".".
		case r == 0x3002 || r == 0xFF61 || r == 0x2024 || r == 0xFE52:
			return '.'
		// Digit forms UTS46/NFKC maps to ASCII digits, which can spell an IP.
		case r >= 0x2460 && r <= 0x2468: // circled 1..9
			return '1' + (r - 0x2460)
		case r >= 0x1D7CE && r <= 0x1D7FF: // mathematical digits
			return '0' + (r-0x1D7CE)%10
		}
		return r
	}, host)
}

// whatwgIPv4 parses the IPv4 shorthands Chrome accepts and `net.ParseIP` does
// not: 1 to 4 dot-separated parts, each decimal, octal (leading 0) or hex
// (leading 0x), with the last part absorbing the remaining bytes. Reports false
// for anything that is a domain name rather than an address, which is what
// WHATWG does when the last part is not numeric.
func whatwgIPv4(host string) (uint32, bool) {
	if host == "" {
		return 0, false
	}
	parts := strings.Split(host, ".")
	// One trailing empty label is a trailing dot, which WHATWG strips.
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) == 0 || len(parts) > 4 {
		return 0, false
	}
	nums := make([]uint64, 0, len(parts))
	for _, p := range parts {
		n, ok := parseIPv4Part(p)
		if !ok {
			return 0, false
		}
		nums = append(nums, n)
	}
	last := nums[len(nums)-1]
	// Every part but the last is one byte; the last covers what is left.
	for _, n := range nums[:len(nums)-1] {
		if n > 255 {
			return 0, false
		}
	}
	// The last part absorbs the remaining bytes: with four parts it is one
	// byte, a bare number covers all four.
	if last >= uint64(1)<<uint(8*(5-len(nums))) {
		return 0, false
	}
	var ip uint32
	for i, n := range nums[:len(nums)-1] {
		ip |= uint32(n) << uint(8*(3-i))
	}
	ip |= uint32(last)
	return ip, true
}

func parseIPv4Part(p string) (uint64, bool) {
	if p == "" {
		return 0, false
	}
	base := 10
	digits := p
	switch {
	case len(p) > 2 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X'):
		base, digits = 16, p[2:]
	case p == "0x" || p == "0X":
		return 0, true
	case len(p) > 1 && p[0] == '0':
		base, digits = 8, p[1:]
	}
	n, err := strconv.ParseUint(digits, base, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// isLoopbackHost reports whether Chrome would send this hostname to this
// machine. Chrome resolves `localhost` and every `*.localhost` name to loopback
// itself; the unspecified addresses (0.0.0.0, ::) connect here too.
func isLoopbackHost(hostname string) bool {
	h := strings.ToLower(foldHostConfusables(strings.TrimSuffix(hostname, ".")))
	h = strings.TrimSuffix(h, ".")
	if h == "" {
		return false
	}
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	// Bracketed IPv6 reaches us unbracketed from url.Hostname(), but a raw
	// string may still carry the brackets.
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	if ip := net.ParseIP(h); ip != nil {
		// Covers 127.0.0.0/8, ::1, ::ffff:127.x.x.x, 0.0.0.0 and ::.
		return ip.IsLoopback() || ip.IsUnspecified()
	}
	if ip4, ok := whatwgIPv4(h); ok {
		return ip4>>24 == 127 || ip4 == 0
	}
	return false
}

// effectiveURLPort is url-policy.ts effectivePort: the port Chrome will
// connect to, default included. A port that is not a number is reported as -1,
// which isDevtoolsPort treats as blocked -- url.Parse does not currently let one
// through, and an unreadable port must not read as "some port that is fine".
func effectiveURLPort(u *url.URL) int {
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil {
			return -1
		}
		return n
	}
	switch u.Scheme {
	case "https", "wss":
		return 443
	default:
		return 80
	}
}

func isDevtoolsPort(port int) bool {
	if port < 0 {
		// Fail closed: see effectiveURLPort.
		return true
	}
	for _, p := range devtoolsBlockedPorts {
		if p == port {
			return true
		}
	}
	return false
}

// checkNavigationURL validates a URL the caller asked the browser to open and
// returns the exact string to hand to `Page.navigate`.
//
// The returned string is the NORMALISED input, not `url.URL.String()`:
// re-serialising would re-escape `data:` payloads and fragments, changing the
// document the caller asked for, while normalising already guarantees the
// property that matters -- Chrome parses the same scheme and authority this
// function checked.
//
// The error message is written for the model: what was refused, why, and what
// is allowed.
func checkNavigationURL(raw string) (string, error) {
	input := sanitizeURLInput(raw)
	if input == "" {
		return "", fmt.Errorf("No URL given. Pass a full URL such as https://example.com.")
	}

	normalized := collapseSpecialAuthority(input)
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Scheme == "" {
		return "", errNotAURL(input)
	}

	scheme := strings.ToLower(parsed.Scheme)

	if scheme == "about" {
		// `about:blank`, `about:blank#x` and `about:blank?x` are the empty page.
		// Canonicalised rather than echoed: Chrome does NOT lowercase the path
		// of a non-special scheme, and it compares `about:blank` case
		// sensitively, so "ABOUT:BLANK" is only the empty page if we spell it
		// that way. (The daemon gets this from `new URL().href`.)
		if strings.EqualFold(parsed.Opaque, "blank") {
			return "about:blank" + aboutBlankSuffix(normalized), nil
		}
		return "", refuseNavigation(input, scheme,
			"about: pages other than about:blank map to browser-internal chrome:// pages")
	}

	if !allowedNavigationSchemes[scheme] {
		// %q on a scheme is safe: a parsed scheme is ASCII letters, digits,
		// "+", "-" and ".", so it never grows an escape.
		why := fmt.Sprintf("%q is not a web address", scheme+":")
		if scheme == "file" {
			why = "the browser does not open local files"
		}
		return "", refuseNavigation(input, scheme, why)
	}

	if scheme == "http" || scheme == "https" {
		// After the collapse an http(s) URL always has an authority. No host
		// means the input was not a web address at all (e.g. bare "http:"), and
		// a leftover Opaque would mean a spelling this function did not
		// normalise -- refuse rather than guess what Chrome will make of it.
		if parsed.Opaque != "" || parsed.Host == "" {
			return "", errNotAURL(input)
		}
		// A DevTools port is refused WHATEVER the host, deliberately unlike the
		// daemon, which only refuses it on a loopback host. Chrome canonicalises
		// a host through UTS46 before resolving it -- deleting soft hyphens and
		// zero-width joiners, mapping circled digits and half a dozen full-stop
		// variants -- so "loc<U+00AD>alhost:9222" reaches the endpoint while any
		// enumeration of those mappings we do here says it is a foreign host.
		// The port is the part Chrome cannot rewrite, so the port is what this
		// refuses; the Fetch guard blocks those ports on any host too, so
		// refusing here only moves an inevitable failure earlier and explains
		// it. `isLoopbackHost` still chooses the wording, because "that is a
		// Jarvis browser's DevTools endpoint" is only true of a local one.
		if isDevtoolsPort(effectiveURLPort(parsed)) {
			if isLoopbackHost(parsed.Hostname()) {
				return "", fmt.Errorf("Refusing to open %s: that is a Jarvis browser's DevTools endpoint, "+
					"which can open local files in new tabs. Open a web page instead.", truncateURL(input, 120))
			}
			return "", fmt.Errorf("Refusing to open %s: port %d is a Jarvis browser's DevTools port, "+
				"which can open local files in new tabs, and requests to it are blocked whatever the "+
				"host resolves to. Open a web page on another port instead.",
				truncateURL(input, 120), effectiveURLPort(parsed))
		}
	}

	return normalized, nil
}

// aboutBlankSuffix keeps the query or fragment of an about:blank URL when the
// scheme and path are canonicalised, so `about:blank#x` stays `about:blank#x` --
// the same thing the daemon's `parsed.href` returns.
func aboutBlankSuffix(normalized string) string {
	if i := strings.IndexAny(normalized, "?#"); i >= 0 {
		return normalized[i:]
	}
	return ""
}

// isDrivableURL reports whether a page already showing this URL may be driven:
// the navigation allowlist applied to where a page IS rather than where it is
// asked to go. A tab can predate the guards -- opened by hand in a headed
// automation browser, or restored by a Chromium that found session state in the
// (persistent) automation profile. Port of url-policy.ts isDrivableUrl.
func isDrivableURL(raw string) bool {
	_, err := checkNavigationURL(raw)
	return err == nil
}

// isLocalContentURL reports pages that show local content. Never snapshotted,
// screenshotted or evaluated in, whatever led there. Matches url-policy.ts
// isLocalContentUrl, prefixes included: `view-source:` is refused for web pages
// too, because its value to a model is reading a source no page would hand out.
func isLocalContentURL(raw string) bool {
	lower := strings.ToLower(sanitizeURLInput(raw))
	return strings.HasPrefix(lower, "file:") ||
		strings.HasPrefix(lower, "view-source:") ||
		strings.HasPrefix(lower, "filesystem:")
}

// privilegedPagePrefixes are the browser's own pages. Reading one back to the
// model is not a local FILE, so #526's three prefixes miss it, but
// chrome://settings/passwords, chrome://history and a devtools:// window are
// worth as much to an attacker as ~/.ssh, and a headed automation browser has an
// address bar a desktop tool can type into. Refused on the read paths only: the
// navigation allowlist already refuses these schemes outright.
//
// This goes beyond the daemon, which refuses local content only. Deliberate:
// the sidecar's browser is the one on the user's desktop, and the daemon's own
// gap is worth closing separately rather than copying.
//
// `chrome-error:` is NOT here. A failed navigation leaves the main frame on
// chrome-error://chromewebdata, and a snapshot of an error page is exactly how
// the model finds out why a page did not load.
var privilegedPagePrefixes = []string{
	"chrome:", "chrome-untrusted:", "chrome-search:", "chrome-extension:", "devtools:",
}

func isPrivilegedPageURL(raw string) bool {
	lower := strings.ToLower(sanitizeURLInput(raw))
	for _, prefix := range privilegedPagePrefixes {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

// blockedRequestReason says why a request Chrome paused for us must fail, or ""
// to let it through. It decides only; browser_fetch_guard.go does the talking.
// Mirrors browser-request-guard.ts blockReason.
func blockedRequestReason(rawURL string) string {
	parsed, err := parseRequestURL(sanitizeURLInput(rawURL))
	if err != nil || parsed.Scheme == "" {
		// Chrome paused it on a pattern we set and we cannot tell which: fail.
		return "unparseable URL matched a blocked pattern"
	}
	if strings.EqualFold(parsed.Scheme, "file") {
		return "the browser does not load local files"
	}
	if isDevtoolsPort(effectiveURLPort(parsed)) {
		return "requests to a Jarvis browser's DevTools port are blocked"
	}
	return ""
}

// lonePercent matches a `%` that does not start a valid escape. Chrome leaves
// those literal in a path or query; net/url rejects the whole URL.
var lonePercent = regexp.MustCompile(`%(?:[^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|.?$)`)

// parseRequestURL parses a URL Chrome has already canonicalised, being lenient
// in the one way Chrome is and net/url is not. Chrome pauses a request because
// the URL TEXT matched a pattern, so `https://example.com/x:9222/100%discount`
// reaches the guard; refusing to parse it would fail a request that is neither a
// local file nor a DevTools endpoint, and a failed subresource is a broken page.
func parseRequestURL(raw string) (*url.URL, error) {
	if u, err := url.Parse(raw); err == nil {
		return u, nil
	}
	// Escape the stray percent signs and try once more. Still fails closed if
	// the URL is unparseable for any other reason.
	return url.Parse(lonePercent.ReplaceAllStringFunc(raw, func(m string) string {
		return "%25" + m[1:]
	}))
}

// fetchGuardPatterns are the `Fetch.enable` patterns: local files, plus every
// DevTools port on any host. Kept in one place so the test can hold it against
// devtoolsBlockedPorts.
func fetchGuardPatterns() []map[string]any {
	patterns := []map[string]any{{"urlPattern": "file:*"}}
	for _, port := range devtoolsBlockedPorts {
		patterns = append(patterns, map[string]any{"urlPattern": fmt.Sprintf("*://*:%d/*", port)})
	}
	return patterns
}

func refuseNavigation(input, scheme, why string) error {
	return fmt.Errorf("Refusing to open %s: %s. The browser only opens %s URLs (got %q).",
		truncateURL(input, 120), why, allowedSchemesSummary, scheme+":")
}

// errNotAURL is the daemon's "not a valid URL" refusal, for input that is not a
// URL at all and for http(s) spellings with no authority.
func errNotAURL(input string) error {
	// Control characters are stripped for display, so echoing the input would
	// otherwise print a URL that looks perfectly valid and tell the model to fix
	// it -- which it would "fix" by sending the same bytes again.
	if strings.ContainsFunc(input, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return fmt.Errorf("Refusing to open %s: the URL contains control characters.",
			truncateURL(input, 120))
	}
	// Literal quotes rather than %q: truncateURL has already dropped the
	// control characters, and %q would mangle a non-ASCII host into escapes.
	return fmt.Errorf("\"%s\" is not a valid URL. Include the scheme, e.g. https://%s.",
		truncateURL(input, 120), truncateURL(input, 60))
}

// truncateURL shortens a URL for a message and drops the control characters
// that would otherwise reach a log line or a terminal verbatim.
func truncateURL(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-3]) + "..."
}
