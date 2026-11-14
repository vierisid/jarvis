package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNotchSiteOfKeepsOnlyTheSite(t *testing.T) {
	for in, want := range map[string]string{
		"github.com/vierisid/jarvis":               "github.com",
		"https://www.GitHub.com/a?token=secret#x":  "github.com",
		"http://example.co.uk:8080/path":           "example.co.uk",
		"mail.google.com/mail/u/0/#inbox":          "mail.google.com",
		"https://user:pass@intranet.example.com/a": "intranet.example.com",
		"www.unicredit.it":                         "unicredit.it",
		"xn--bcher-kva.example/":                   "xn--bcher-kva.example",
		// Not a site.
		"":                           "",
		"how to open a bank account": "",
		"github":                     "",
		"localhost:3143/app":         "",
		"192.168.1.1/admin":          "",
		"chrome://settings":          "",
		"about:blank":                "",
		"file:///C:/Users/me/a.html": "",
		"mailto:sam@example.com":     "",
		"edge://newtab":              "",
		"-bad-.com":                  "",
	} {
		if got := notchSiteOf(in); got != want {
			t.Errorf("notchSiteOf(%q) = %q, want %q", in, got, want)
		}
	}
	if got := notchSiteOf("https://example.com/" + strings.Repeat("a", 5000)); got != "" {
		t.Errorf("an address too long to be one: %q", got)
	}
}

func TestNotchBankSite(t *testing.T) {
	for _, site := range []string{
		"paypal.com", "wise.com", "app.revolut.com", "unicredit.it", "intesasanpaolo.com", "bankofamerica.com", "chase.com",
		"hsbc.co.uk", "ing.it", "online.bancaintesa.rs", "sparkasse.de", "deutsche-bank.de", "dashboard.stripe.com",
		"secure.finecobank.com", "n26.com", "coinbase.com",
	} {
		if !notchBankSite(site) {
			t.Errorf("%q should be a bank", site)
		}
	}
	for _, site := range []string{
		"github.com", "wikipedia.org", "youtube.com", "stripe.com", "docs.stripe.com", "google.com", "wisewords.example.com",
		"thechase.tv", "news.example.com", "",
	} {
		if notchBankSite(site) {
			t.Errorf("%q should not be a bank", site)
		}
	}
}

func TestNotchLookForUsesTheSiteWhenItIsKnown(t *testing.T) {
	never := []string{"site:reddit.com", "steam"}
	for _, c := range []struct {
		front notchFront
		want  notchLook
		name  string
	}{
		{notchFront{App: "chrome", Site: "en.wikipedia.org", Title: "River bank - Wikipedia"}, notchLooking, "a page about river banks, on a site that is not a bank"},
		{notchFront{App: "chrome", Site: "paypal.com", Title: "Summary"}, notchLookBank, "a bank whose title says nothing"},
		{notchFront{App: "chrome", Title: "PayPal: Summary"}, notchLookBank, "no site known: the title is all there is"},
		{notchFront{App: "chrome", Site: "old.reddit.com", Title: "reddit"}, notchLookNever, "a site on the list, by a part of it"},
		{notchFront{App: "chrome", Site: "notreddit.com"}, notchLooking, "another site whose name ends the same"},
		{notchFront{App: "chrome", Site: "github.com", Password: true}, notchLookPassword, "a password on an ordinary site"},
		{notchFront{App: "steam", Site: ""}, notchLookNever, "an app on the list"},
	} {
		if got := notchLookFor(c.front, never); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestNotchNeverListHoldsAppsAndSites(t *testing.T) {
	got := notchNeverList([]string{"Steam.exe", "site:GitHub.com", "SITE:https://www.github.com/x", "site:cash.app", "site:not a site", "Arc.app"})
	if want := []string{"arc", "site:cash.app", "site:github.com", "steam"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	w := &NotchWhere{icons: map[string][]byte{}}
	w.Use(func(map[string]any, []byte) {})
	w.SetFront(notchFront{App: "chrome", Name: "Google Chrome", Title: "GitHub", Site: "github.com"}, nil)
	if list, err := w.NeverWatch("site:github.com", false); err != nil || !reflect.DeepEqual(list, []string{"site:github.com"}) || w.Look() != notchLookNever {
		t.Errorf("never watch a site: %v, %v, Look() = %q", list, err, w.Look())
	}
	// The observer reads "chrome" and a title; the site is the one last heard for that browser.
	if !w.Refuses("chrome", "GitHub") || w.Refuses("notepad", "GitHub") {
		t.Error("an observer looking at the same browser is refused the site on the list; another app is not")
	}
	if list, err := w.NeverWatch("site:github.com", true); err != nil || len(list) != 0 || w.Look() != notchLooking {
		t.Errorf("watch it again: %v, %v, Look() = %q", list, err, w.Look())
	}
}

func TestNotchWherePayloadSaysTheSiteButNotForABankOrAPassword(t *testing.T) {
	front := notchFront{App: "chrome", Name: "Google Chrome", Title: "t", Site: "github.com"}
	if p := notchWherePayload(front, notchLooking, false, nil); p["site"] != "github.com" || p["title"] != "t" {
		t.Errorf("watching: %v", p)
	}
	for _, look := range []notchLook{notchLookBank, notchLookPassword} {
		if p := notchWherePayload(front, look, false, nil); p["site"] != "" || p["title"] != "" {
			t.Errorf("%s: %v", look, p)
		}
	}
	// A site the person put on the list is named, so that it can be taken off.
	if p := notchWherePayload(front, notchLookNever, false, []string{"site:github.com"}); p["site"] != "github.com" || p["title"] != "" {
		t.Errorf("never: %v", p)
	}
}

// ── icons ──

func pngOf(t *testing.T, size int, c color.NRGBA) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// icoOf builds an .ico with one picture per entry given.
func icoOf(pictures ...[]byte) []byte {
	sizes := make([]int, len(pictures))
	for i, p := range pictures {
		sizes[i] = 16
		if bytes.HasPrefix(p, []byte("\x89PNG")) {
			if cfg, err := png.DecodeConfig(bytes.NewReader(p)); err == nil {
				sizes[i] = cfg.Width
			}
		} else if len(p) >= 8 {
			sizes[i] = int(binary.LittleEndian.Uint32(p[4:]))
		}
	}
	out := []byte{0, 0, 1, 0, byte(len(pictures)), 0}
	offset := 6 + 16*len(pictures)
	for i, p := range pictures {
		entry := make([]byte, 16)
		entry[0], entry[1] = byte(sizes[i]), byte(sizes[i])
		binary.LittleEndian.PutUint16(entry[4:], 1)
		binary.LittleEndian.PutUint16(entry[6:], 32)
		binary.LittleEndian.PutUint32(entry[8:], uint32(len(p)))
		binary.LittleEndian.PutUint32(entry[12:], uint32(offset))
		out = append(out, entry...)
		offset += len(p)
	}
	for _, p := range pictures {
		out = append(out, p...)
	}
	return out
}

// dibOf is the bitmap kind of icon picture: 24 bits a pixel, all one colour,
// with a mask that makes the left half see-through.
func dibOf(size int, c color.NRGBA) []byte {
	head := make([]byte, 40)
	binary.LittleEndian.PutUint32(head[0:], 40)
	binary.LittleEndian.PutUint32(head[4:], uint32(size))
	binary.LittleEndian.PutUint32(head[8:], uint32(size*2))
	binary.LittleEndian.PutUint16(head[12:], 1)
	binary.LittleEndian.PutUint16(head[14:], 24)
	row := ((size*24 + 31) / 32) * 4
	pixels := make([]byte, row*size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			pixels[y*row+x*3], pixels[y*row+x*3+1], pixels[y*row+x*3+2] = c.B, c.G, c.R
		}
	}
	maskRow := ((size + 31) / 32) * 4
	mask := make([]byte, maskRow*size)
	for y := 0; y < size; y++ {
		for x := 0; x < size/2; x++ {
			mask[y*maskRow+x/8] |= 0x80 >> (x % 8)
		}
	}
	return append(append(head, pixels...), mask...)
}

func decoded(t *testing.T, data []byte) *image.NRGBA {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("not a PNG: %v", err)
	}
	out := image.NewNRGBA(img.Bounds())
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			out.Set(x, y, img.At(x, y))
		}
	}
	return out
}

func TestNotchSiteIconPNGDrawsWhateverASiteSendsAtOneSize(t *testing.T) {
	red := color.NRGBA{R: 220, G: 30, B: 30, A: 255}
	for name, data := range map[string][]byte{
		"a PNG":                                 pngOf(t, 64, red),
		"an .ico holding PNGs, best size taken": icoOf(pngOf(t, 16, color.NRGBA{B: 255, A: 255}), pngOf(t, 48, red)),
		"an .ico holding a bitmap":              icoOf(dibOf(32, red)),
	} {
		out, err := notchSiteIconPNG(data)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		img := decoded(t, out)
		if img.Bounds().Dx() != notchSiteIconSize || img.Bounds().Dy() != notchSiteIconSize {
			t.Errorf("%s: drawn at %v", name, img.Bounds())
		}
		// The right half is the picture's colour in all three.
		if c := img.NRGBAAt(24, 16); c.R < 180 || c.B > 80 || c.A < 200 {
			t.Errorf("%s: the picture came out as %v", name, c)
		}
		if len(out) > notchIconMaxBytes {
			t.Errorf("%s: %d bytes is more than is sent", name, len(out))
		}
	}
	// The bitmap's mask: its left half is see-through.
	out, _ := notchSiteIconPNG(icoOf(dibOf(32, red)))
	if c := decoded(t, out).NRGBAAt(4, 16); c.A > 40 {
		t.Errorf("the masked half should be see-through, got %v", c)
	}
	for name, data := range map[string][]byte{
		"a page that says not found":         []byte("<html><body>404</body></html>"),
		"a vector drawing":                   []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
		"nothing":                            nil,
		"an .ico that points outside itself": {0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 255, 255, 0, 0, 22, 0, 0, 0},
		"a picture with nothing in it":       pngOf(t, 32, color.NRGBA{}),
		"a picture of one dot":               pngOf(t, 1, red),
	} {
		if out, err := notchSiteIconPNG(data); err == nil {
			t.Errorf("%s was taken for an icon (%d bytes)", name, len(out))
		}
	}
}

func TestNotchIconLinks(t *testing.T) {
	base, _ := url.Parse("https://example.com/app/")
	html := []byte(`<head>
<link rel="stylesheet" href="/a.css">
<link rel="apple-touch-icon" href="/touch.png">
<link rel="mask-icon" href="/mask.svg">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<LINK REL='shortcut icon' HREF='fav.ico?v=2&amp;x=1'>
<link href=//cdn.example.net/i.png rel=icon>
<link rel="icon" href="http://insecure.example.com/i.png">
<link rel="icon" href="/fav.ico?v=2&x=1">
</head>`)
	got := notchIconLinks(html, base)
	want := []string{"https://example.com/app/fav.ico?v=2&x=1", "https://cdn.example.net/i.png", "https://example.com/fav.ico?v=2&x=1", "https://example.com/touch.png"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %v\nwant %v", got, want)
	}
}

func TestNotchSiteIconsAsksTheSiteOnceAndKeepsWhatItGets(t *testing.T) {
	red := color.NRGBA{R: 220, G: 30, B: 30, A: 255}
	var hits atomic.Int32
	var sawCookie, sawAgent atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(res http.ResponseWriter, req *http.Request) {
		hits.Add(1)
		sawCookie.Store(req.Header.Get("Cookie"))
		sawAgent.Store(req.Header.Get("User-Agent"))
		switch req.URL.Path {
		case "/favicon.ico":
			http.NotFound(res, req)
		case "/":
			_, _ = res.Write([]byte(`<html><head><link rel="icon" href="/static/icon.png"></head></html>`))
		case "/static/icon.png":
			_, _ = res.Write(pngOf(t, 48, red))
		default:
			http.NotFound(res, req)
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	icons := newNotchSiteIcons(dir)
	// The test's server answers for every site, in the clear.
	icons.scheme = "http"
	icons.client = server.Client()
	serverURL, _ := url.Parse(server.URL)
	icons.client.Transport = rewriteHost{to: serverURL.Host}

	if icons.Have("example.com") != nil {
		t.Fatal("nothing is known before anybody was asked")
	}
	done := make(chan struct{}, 4)
	icons.Ask("example.com", func() { done <- struct{}{} })
	icons.Ask("example.com", func() { done <- struct{}{} }) // asked while asking: once
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the icon never came")
	}
	icon := icons.Have("example.com")
	if icon == nil || decoded(t, icon).Bounds().Dx() != notchSiteIconSize {
		t.Fatalf("no icon kept: %d bytes", len(icon))
	}
	if n := hits.Load(); n != 3 {
		t.Errorf("the site was asked %d times, want 3 (its usual place, its page, the icon it names)", n)
	}
	if cookie, _ := sawCookie.Load().(string); cookie != "" {
		t.Errorf("a cookie was sent: %q", cookie)
	}
	if agent, _ := sawAgent.Load().(string); strings.Contains(strings.ToLower(agent), "jarvis") {
		t.Errorf("the request says who is asking: %q", agent)
	}
	// Kept in the folder, and found there by a fresh start, with nobody asked.
	if _, err := os.Stat(filepath.Join(dir, "example.com.png")); err != nil {
		t.Errorf("not kept on disk: %v", err)
	}
	again := newNotchSiteIcons(dir)
	if again.Have("example.com") == nil {
		t.Error("a fresh start did not find the kept icon")
	}
	before := hits.Load()
	icons.Ask("example.com", nil)
	time.Sleep(50 * time.Millisecond)
	if hits.Load() != before {
		t.Error("a site whose icon is known was asked again")
	}
	// A name that is not a site is never asked for anything.
	icons.Ask("192.168.1.1", nil)
	icons.Ask("localhost", nil)
	icons.Ask("", nil)
	time.Sleep(50 * time.Millisecond)
	if hits.Load() != before {
		t.Error("something that is not a site was asked for an icon")
	}
}

func TestNotchSiteIconsDoesNotKeepAskingASiteThatHasNone(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(res http.ResponseWriter, req *http.Request) {
		hits.Add(1)
		http.NotFound(res, req)
	}))
	defer server.Close()
	icons := newNotchSiteIcons(t.TempDir())
	icons.scheme = "http"
	serverURL, _ := url.Parse(server.URL)
	icons.client = &http.Client{Timeout: 2 * time.Second, Transport: rewriteHost{to: serverURL.Host}}
	icons.Ask("none.example.com", func() { t.Error("it has no icon: nothing is done") })
	deadline := time.Now().Add(3 * time.Second)
	for hits.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	first := hits.Load()
	icons.Ask("none.example.com", nil)
	time.Sleep(80 * time.Millisecond)
	if hits.Load() != first {
		t.Errorf("a site with no icon was asked again at once (%d then %d)", first, hits.Load())
	}
	if icons.Have("none.example.com") != nil {
		t.Error("an icon appeared from nowhere")
	}
}

// rewriteHost sends every request to the test's server, whatever site it names.
type rewriteHost struct{ to string }

func (r rewriteHost) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = r.to
	return http.DefaultTransport.RoundTrip(clone)
}
