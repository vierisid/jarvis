package main

// Which site, when the app in front is a browser.
//
// "Chrome" says little about where a person is. The site says it: so in a
// browser the notch shows the site's own icon, "What I see" names the site,
// a bank is known by its address and not guessed from a title, and a person
// can say "never watch this site".
//
// How the site is known: the browser's own address bar is read, the way any
// control of any program is read (notch_where_windows.go). The page is never
// entered for it. Of what the bar holds only the site is kept, "github.com":
// not the page, not what follows a "?". An address can carry a name, a search
// or a key, and none of that is needed here, so none of it leaves the function
// that reads the bar.
//
// Where the icon comes from: the site itself, asked once and kept on this
// machine (~/.jarvis/site-icons). Never a lookup service: that would tell a
// third party every site the person opens. Nothing is asked while the notch
// looks away, and nothing of a site on the "never watch" list.
//
// This file has no platform calls in it: reading an address, the rules, and
// fetching and drawing an icon. It is tested on every platform.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // sites serve icons in these too
	_ "image/jpeg"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
)

// The programs that are browsers, by the name the list would hold them under.
var notchBrowsers = map[string]bool{
	"chrome": true, "msedge": true, "brave": true, "firefox": true, "vivaldi": true, "opera": true, "chromium": true,
	"arc": true, "zen": true, "librewolf": true, "waterfox": true,
	// As the Mac names them.
	"google chrome": true, "microsoft edge": true, "brave browser": true, "safari": true,
}

func notchIsBrowser(app string) bool { return notchBrowsers[notchAppKey(app)] }

var notchHostShape = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$`)

// notchSiteOf is the site an address bar's text names, or "" when it names
// none: a search being typed, a page of the browser itself, a file, a machine
// on the local network by its number. Only the site is returned, never the
// rest of the address.
func notchSiteOf(address string) string {
	address = strings.TrimSpace(address)
	if address == "" || strings.ContainsAny(address, " \t\r\n") || len(address) > 4096 {
		return ""
	}
	lower := strings.ToLower(address)
	if i := strings.Index(lower, "://"); i >= 0 {
		if scheme := lower[:i]; scheme != "http" && scheme != "https" {
			return ""
		}
		lower = lower[i+3:]
	} else if regexp.MustCompile(`^[a-z][a-z0-9+.-]*:[^0-9/]`).MatchString(lower) {
		// "about:blank", "chrome:settings", "mailto:": something, but not a site.
		return ""
	}
	if i := strings.IndexAny(lower, "/?#"); i >= 0 {
		lower = lower[:i]
	}
	if i := strings.LastIndex(lower, "@"); i >= 0 {
		lower = lower[i+1:]
	}
	if host, _, err := net.SplitHostPort(lower); err == nil {
		lower = host
	}
	lower = strings.TrimSuffix(strings.TrimPrefix(lower, "www."), ".")
	if len(lower) > 253 || !notchHostShape.MatchString(lower) {
		return ""
	}
	return lower
}

// notchSiteEntry is a site as the "never watch" list holds it. Apps are held
// by their program's name; a site is told apart by this mark in front.
const notchSiteMark = "site:"

func notchSiteEntry(site string) string { return notchSiteMark + site }

// notchNeverHasSite says whether a site is on the list, itself or as part of
// a site that is: "never watch google.com" covers mail.google.com.
func notchNeverHasSite(never []string, site string) bool {
	if site == "" {
		return false
	}
	for _, entry := range never {
		if !strings.HasPrefix(entry, notchSiteMark) {
			continue
		}
		listed := entry[len(notchSiteMark):]
		if site == listed || strings.HasSuffix(site, "."+listed) {
			return true
		}
	}
	return false
}

// A bank by its address. Words that are part of a bank's own name, and the
// names of those that do not say "bank". With an address there is no guessing
// from a title, so names that are also ordinary words are safe here: "wise"
// is only wise.com.
var (
	notchBankSiteWords = regexp.MustCompile(`bank|banca|banco|banque|sparkasse|creditunion`)
	notchBankSiteNames = map[string]bool{
		"paypal": true, "revolut": true, "wise": true, "n26": true, "monzo": true, "bunq": true, "qonto": true, "hype": true,
		"intesasanpaolo": true, "unicredit": true, "fineco": true, "mediolanum": true, "bper": true, "mps": true, "widiba": true,
		"illimity": true, "credem": true, "sella": true, "poste": true, "postepay": true, "americanexpress": true,
		"chase": true, "jpmorgan": true, "wellsfargo": true, "citi": true, "capitalone": true, "hsbc": true, "barclays": true,
		"lloyds": true, "natwest": true, "santander": true, "bbva": true, "caixa": true, "ing": true, "abnamro": true,
		"bnpparibas": true, "societegenerale": true, "credit-agricole": true, "ubs": true, "credit-suisse": true, "raiffeisen": true,
		"nordea": true, "seb": true, "fidelity": true, "schwab": true, "vanguard": true, "degiro": true, "etoro": true,
		"traderepublic": true, "interactivebrokers": true, "coinbase": true, "binance": true, "kraken": true,
	}
	notchBankSiteHosts = map[string]bool{"dashboard.stripe.com": true, "pay.google.com": true, "wallet.google.com": true}
)

// notchBankSite says whether a site is a bank's.
func notchBankSite(site string) bool {
	if site == "" {
		return false
	}
	if notchBankSiteHosts[site] {
		return true
	}
	labels := strings.Split(site, ".")
	// Every part but the last, which is the country or ".com".
	for _, label := range labels[:len(labels)-1] {
		if notchBankSiteNames[label] || notchBankSiteWords.MatchString(label) {
			return true
		}
	}
	return false
}

// ── The site's icon ──────────────────────────────────────────────────

// How big an icon is drawn, and the most that is read of anything a site sends.
const (
	notchSiteIconSize  = 32
	notchSiteReadLimit = 400 << 10
)

// decodeICO reads the best picture out of an .ico file: the one nearest above
// the size that is drawn. An .ico is a list of pictures, each a PNG or the
// inside of a Windows bitmap followed by a mask of what is see-through.
func decodeICO(data []byte) (image.Image, error) {
	if len(data) < 6 || binary.LittleEndian.Uint16(data[0:]) != 0 || binary.LittleEndian.Uint16(data[2:]) != 1 {
		return nil, errors.New("not an icon file")
	}
	count := int(binary.LittleEndian.Uint16(data[4:]))
	if count == 0 || count > 64 || len(data) < 6+16*count {
		return nil, errors.New("an icon file with no pictures in it")
	}
	best, bestScore := -1, 1<<30
	for i := 0; i < count; i++ {
		entry := data[6+16*i:]
		width := int(entry[0])
		if width == 0 {
			width = 256
		}
		// Nearest above what is drawn is best; smaller ones count as far away.
		score := width - notchSiteIconSize
		if score < 0 {
			score = 1000 - width
		}
		if score < bestScore {
			best, bestScore = i, score
		}
	}
	entry := data[6+16*best:]
	size, offset := int(binary.LittleEndian.Uint32(entry[8:])), int(binary.LittleEndian.Uint32(entry[12:]))
	if size <= 0 || offset < 0 || offset+size > len(data) {
		return nil, errors.New("an icon file that points outside itself")
	}
	picture := data[offset : offset+size]
	if bytes.HasPrefix(picture, []byte("\x89PNG\r\n\x1a\n")) {
		return png.Decode(bytes.NewReader(picture))
	}
	return decodeIconBitmap(picture)
}

// decodeIconBitmap reads the bitmap kind of icon picture: a bitmap's header
// that claims twice the height, the colours, then one bit a pixel for what is
// see-through.
func decodeIconBitmap(picture []byte) (image.Image, error) {
	if len(picture) < 40 || binary.LittleEndian.Uint32(picture[0:]) != 40 {
		return nil, errors.New("an icon picture of a kind that is not read")
	}
	width := int(int32(binary.LittleEndian.Uint32(picture[4:])))
	height := int(int32(binary.LittleEndian.Uint32(picture[8:]))) / 2
	bits := int(binary.LittleEndian.Uint16(picture[14:]))
	if width <= 0 || height <= 0 || width > 256 || height > 256 {
		return nil, errors.New("an icon picture of no size")
	}
	colours := 0
	if bits <= 8 {
		colours = int(binary.LittleEndian.Uint32(picture[32:]))
		if colours == 0 {
			colours = 1 << bits
		}
	}
	// As a bitmap file: a file header in front, and its true height.
	body := append([]byte{}, picture...)
	binary.LittleEndian.PutUint32(body[8:], uint32(height))
	pixelsAt := 14 + 40 + 4*colours
	file := make([]byte, 14, 14+len(body))
	copy(file, "BM")
	binary.LittleEndian.PutUint32(file[2:], uint32(14+len(body)))
	binary.LittleEndian.PutUint32(file[10:], uint32(pixelsAt))
	decoded, err := bmp.Decode(bytes.NewReader(append(file, body...)))
	if err != nil {
		return nil, err
	}
	out := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.Draw(out, out.Bounds(), decoded, decoded.Bounds().Min, draw.Src)
	hasAlpha := false
	if bits == 32 {
		for i := 3; i < len(out.Pix); i += 4 {
			if out.Pix[i] != 0 {
				hasAlpha = true
				break
			}
		}
	}
	if hasAlpha {
		return out, nil
	}
	// No transparency of its own: solid, minus what the mask says is see-through.
	for i := 3; i < len(out.Pix); i += 4 {
		out.Pix[i] = 255
	}
	rowBytes := ((width*bits + 31) / 32) * 4
	maskRow := ((width + 31) / 32) * 4
	mask := picture[40+4*colours:]
	if len(mask) >= rowBytes*height+maskRow*height {
		mask = mask[rowBytes*height:]
		for y := 0; y < height; y++ {
			row := mask[(height-1-y)*maskRow:]
			for x := 0; x < width; x++ {
				if row[x/8]&(0x80>>(x%8)) != 0 {
					out.Pix[(y*width+x)*4+3] = 0
				}
			}
		}
	}
	return out, nil
}

// notchSiteIconPNG turns what a site sent as its icon into the PNG the notch
// draws: one size, whatever came. An error when it is not a picture that is
// read (a vector drawing, a page saying "not found").
func notchSiteIconPNG(data []byte) ([]byte, error) {
	var img image.Image
	var err error
	if len(data) >= 4 && binary.LittleEndian.Uint16(data[0:]) == 0 && binary.LittleEndian.Uint16(data[2:]) == 1 {
		img, err = decodeICO(data)
	} else {
		img, _, err = image.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, err
	}
	bounds := img.Bounds()
	if bounds.Dx() < 8 || bounds.Dy() < 8 || bounds.Dx() > 2048 || bounds.Dy() > 2048 {
		return nil, fmt.Errorf("an icon of %dx%d", bounds.Dx(), bounds.Dy())
	}
	out := image.NewNRGBA(image.Rect(0, 0, notchSiteIconSize, notchSiteIconSize))
	draw.CatmullRom.Scale(out, out.Bounds(), img, bounds, draw.Src, nil)
	// A picture that came out as nothing at all is not an icon.
	blank := true
	for i := 3; i < len(out.Pix); i += 4 {
		if out.Pix[i] > 8 {
			blank = false
			break
		}
	}
	if blank {
		return nil, errors.New("an icon with nothing in it")
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var (
	notchLinkTag  = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	notchLinkRel  = regexp.MustCompile(`(?is)\brel\s*=\s*["']?([^"'>]+)`)
	notchLinkHref = regexp.MustCompile(`(?is)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
)

// notchIconLinks finds where a page says its icon is: the addresses in its
// <link rel="icon"> tags, in the order to try them. Vector drawings are left
// out (they are not read), and a touch icon comes last: it is large and made
// for another purpose.
func notchIconLinks(html []byte, base *url.URL) []string {
	var first, last []string
	seen := map[string]bool{}
	for _, tag := range notchLinkTag.FindAll(html, 40) {
		rel := notchLinkRel.FindSubmatch(tag)
		href := notchLinkHref.FindSubmatch(tag)
		if rel == nil || href == nil {
			continue
		}
		kind := strings.ToLower(string(rel[1]))
		if !strings.Contains(kind, "icon") || strings.Contains(kind, "mask-icon") {
			continue
		}
		raw := string(href[1]) + string(href[2]) + string(href[3])
		ref, err := url.Parse(strings.TrimSpace(strings.ReplaceAll(raw, "&amp;", "&")))
		if err != nil {
			continue
		}
		full := base.ResolveReference(ref)
		if full.Scheme != "https" && full.Scheme != base.Scheme {
			continue
		}
		if strings.HasSuffix(strings.ToLower(full.Path), ".svg") || seen[full.String()] {
			continue
		}
		seen[full.String()] = true
		if strings.Contains(kind, "apple-touch") {
			last = append(last, full.String())
		} else {
			first = append(first, full.String())
		}
	}
	return append(first, last...)
}

// notchSiteIcons asks sites for their icons and keeps them.
type notchSiteIcons struct {
	dir    string
	client *http.Client
	// "https", except in a test, which has no certificate to show.
	scheme string

	mu      sync.Mutex
	have    map[string][]byte
	none    map[string]time.Time // asked, and it has none: not asked again for a while
	asking  map[string]bool
	onceDir sync.Once
}

func newNotchSiteIcons(dir string) *notchSiteIcons {
	return &notchSiteIcons{
		dir: dir, scheme: "https",
		client: &http.Client{
			Timeout: 5 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 4 {
					return errors.New("too many redirects")
				}
				return nil
			},
		},
		have: map[string][]byte{}, none: map[string]time.Time{}, asking: map[string]bool{},
	}
}

// Have is the icon of a site if it is known already: from this run, or from
// the folder where they are kept. It asks nobody.
func (s *notchSiteIcons) Have(site string) []byte {
	if site == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if icon, ok := s.have[site]; ok {
		return icon
	}
	if info, err := os.Stat(s.file(site)); err == nil && time.Since(info.ModTime()) < 30*24*time.Hour {
		if icon, err := os.ReadFile(s.file(site)); err == nil && len(icon) > 0 && len(icon) <= notchIconMaxBytes {
			s.have[site] = icon
			return icon
		}
	}
	return nil
}

func (s *notchSiteIcons) file(site string) string { return filepath.Join(s.dir, site+".png") }

// Ask fetches a site's icon in the background, once. done is called when it
// has one. A site that has none is not asked again for six hours.
func (s *notchSiteIcons) Ask(site string, done func()) {
	if site == "" || !notchHostShape.MatchString(site) {
		return
	}
	s.mu.Lock()
	if _, ok := s.have[site]; ok || s.asking[site] || time.Since(s.none[site]) < 6*time.Hour {
		s.mu.Unlock()
		return
	}
	s.asking[site] = true
	s.mu.Unlock()
	go func() {
		icon := s.fetch(site)
		s.mu.Lock()
		delete(s.asking, site)
		if icon == nil {
			s.none[site] = time.Now()
			s.mu.Unlock()
			return
		}
		if len(s.have) > 400 {
			s.have = map[string][]byte{}
		}
		s.have[site] = icon
		s.mu.Unlock()
		s.onceDir.Do(func() { _ = os.MkdirAll(s.dir, 0o700) })
		_ = os.WriteFile(s.file(site), icon, 0o600)
		if done != nil {
			done()
		}
	}()
}

func (s *notchSiteIcons) get(address string) ([]byte, *url.URL, error) {
	req, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil {
		return nil, nil, err
	}
	// It says what it is and nothing about who is asking. No cookies are kept or sent.
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; icon-fetch)")
	req.Header.Set("Accept", "image/png,image/x-icon,image/*;q=0.8,text/html;q=0.5")
	res, err := s.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("status %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, notchSiteReadLimit))
	return data, res.Request.URL, err
}

// fetch asks the site: first where every site keeps its icon, then the page
// itself for where it says its icon is.
func (s *notchSiteIcons) fetch(site string) []byte {
	root := s.scheme + "://" + site
	if data, _, err := s.get(root + "/favicon.ico"); err == nil {
		if icon, err := notchSiteIconPNG(data); err == nil {
			return icon
		}
	}
	page, at, err := s.get(root + "/")
	if err != nil {
		return nil
	}
	for i, link := range notchIconLinks(page, at) {
		if i >= 4 {
			break
		}
		if data, _, err := s.get(link); err == nil {
			if icon, err := notchSiteIconPNG(data); err == nil {
				return icon
			}
		}
	}
	return nil
}
