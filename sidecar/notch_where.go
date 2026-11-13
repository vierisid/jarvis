package main

// Where the person is, and whether this program is looking.
//
// The notch shows the app in front beside its eyes, turns its eyes aside when
// it is looking away, and closes them when it sees nothing. All three start
// here, on the machine itself:
//
//   - which app is in front is heard from the system the moment it changes
//     (notch_where_windows.go), not found by asking every five seconds;
//   - "never watch this app" is a list kept in this machine's own settings;
//   - looking away is decided here, BEFORE anything is captured: for an app on
//     that list, while a password is being typed, and on a bank's pages. The
//     screen and window observers ask (observers.go), so a screenshot of a
//     bank page is not taken and thrown away: it is not taken.
//
// The brain is told what was decided (the event `notch.where`). It does not
// decide, and a brain that is wrong or late cannot make this program look.
//
// None of this runs unless the brain says the notch is on. With the notch off
// the observers work exactly as before.
//
// This file has no platform calls in it: the decisions, the state and what is
// said to the brain. It is tested on every platform.

import (
	"crypto/sha1"
	"encoding/hex"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// notchWhereEvent is the event that says where the person is.
const notchWhereEvent = "notch.where"

// How long hands have to be off the keyboard and the mouse to count as still.
const notchStillMs = 4000

// Why this program is not looking. Empty: it is.
type notchLook string

const (
	notchLooking      notchLook = ""
	notchLookNever    notchLook = "never"    // the app is on the person's list
	notchLookPassword notchLook = "password" // a password field has the keyboard
	notchLookBank     notchLook = "bank"     // the window is a bank's
)

// notchFront is the app in front.
type notchFront struct {
	App      string // the program's name in small letters, no ".exe": what the list holds
	Name     string // what a person calls it
	Title    string // the window's title
	Icon     string // the key of its icon, "" when it has none
	Password bool   // a password field has the keyboard
}

// notchAppKey is a program's name as the list holds it.
func notchAppKey(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if i := strings.LastIndexAny(name, `\/`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.TrimSuffix(name, ".exe")
	return strings.TrimSuffix(name, ".app")
}

// Words that make a window a bank's, in a title. A title is all there is to go
// by: this program cannot read the address a browser is on. So it is a list,
// and it errs towards looking away: a page about banks is not captured either.
// Whole words only, so "Banksy" and "embankment" are not banks.
var notchBankWords = regexp.MustCompile(`(?i)(^|[^\p{L}])(` + strings.Join([]string{
	// The thing itself, in the languages the product is used in.
	`bank|banking|banca|banco|banque|bancario|bancaria|home ?banking|online ?banking|internet ?banking|e-?banking|netbanking`,
	`credit union|cassa di risparmio|sparkasse|caisse d['’ ]epargne|cr[eé]dit (agricole|mutuel)`,
	// Names that do not say "bank". Only names that are not also ordinary
	// words: "wise", "chase" and "hype" are banks, and are also half the titles
	// on a video site.
	`intesa sanpaolo|unicredit|fineco|mediolanum|bper|monte dei paschi|poste ?pay|bancoposta|widiba|illimity|credem`,
	`revolut|n26|monzo|bunq|qonto|paypal|stripe dashboard|american express|amex|jpmorgan|wise\.com|chase\.com`,
	`wells fargo|citibank|capital one|hsbc|barclays|lloyds|natwest|santander|bbva|caixabank|la caixa|ing direct|rabobank|abn amro`,
	`bnp paribas|soci[eé]t[eé] g[eé]n[eé]rale|commerzbank|ubs|credit suisse|raiffeisen|nordea|swedbank|handelsbanken`,
	`fidelity investments|schwab|degiro|etoro|trade republic|interactive brokers|coinbase|binance`,
}, "|") + `)([^\p{L}]|$)`)

// notchBankTitle says whether a window's title reads as a bank's.
func notchBankTitle(title string) bool {
	return title != "" && notchBankWords.MatchString(title)
}

// notchLookFor decides whether to look, for the app in front. The person's own
// list comes first: they said never. Then a password, then a bank.
func notchLookFor(front notchFront, never []string) notchLook {
	if front.App != "" {
		for _, app := range never {
			if app == front.App {
				return notchLookNever
			}
		}
	}
	if front.Password {
		return notchLookPassword
	}
	if notchBankTitle(front.Title) {
		return notchLookBank
	}
	return notchLooking
}

// notchNeverList is a list as it is kept: keys, no doubles, in order.
func notchNeverList(list []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, app := range list {
		if key := notchAppKey(app); key != "" && !seen[key] {
			seen[key] = true
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

// notchIconKey names an icon by what it is, so that the brain is sent each
// picture once and told its name after that.
func notchIconKey(png []byte) string {
	if len(png) == 0 {
		return ""
	}
	sum := sha1.Sum(png)
	return hex.EncodeToString(sum[:8])
}

// The most an icon may weigh to be sent. A 32 pixel icon is a few kilobytes.
const notchIconMaxBytes = 40_000

// NotchWhere holds where the person is and says it to the brain.
type NotchWhere struct {
	mu    sync.Mutex
	on    bool // a brain with the notch on is connected
	front notchFront
	still bool
	never []string
	// The connection's sender, and which icons have gone out on it.
	send func(payload map[string]any, icon []byte)
	sent map[string]bool
	// Icons by key, for a brain that connects later. The newest few.
	icons map[string][]byte
	// What was last said, so that nothing is said twice.
	last string
	// Saves the list in this machine's settings.
	save func(list []string) error
}

var notchWhere = &NotchWhere{icons: map[string][]byte{}}

// The system is listened to from the first time a brain with the notch on
// connects, and then for as long as this program runs.
var notchWhereStart sync.Once

// Use gives it a connection whose brain has the notch on. Everything it knows
// is said at once. forget takes the connection away, and with it the looking
// away: with the notch off the observers are as they always were.
func (w *NotchWhere) Use(send func(payload map[string]any, icon []byte)) {
	w.mu.Lock()
	w.on = true
	w.send = send
	w.sent = map[string]bool{}
	w.last = ""
	w.mu.Unlock()
	w.tell()
}

func (w *NotchWhere) Forget() {
	w.mu.Lock()
	w.on = false
	w.send = nil
	w.sent = nil
	w.last = ""
	w.mu.Unlock()
}

// On says whether a brain with the notch on is connected.
func (w *NotchWhere) On() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.on
}

// SetNever takes the list from this machine's settings, and how to save it.
func (w *NotchWhere) SetNever(list []string, save func(list []string) error) {
	w.mu.Lock()
	w.never = notchNeverList(list)
	if save != nil {
		w.save = save
	}
	w.mu.Unlock()
	w.tell()
}

// NeverWatch puts an app on the list, or takes it off, and saves the list.
// It answers with the list as it is now. If it cannot be saved nothing changes.
func (w *NotchWhere) NeverWatch(app string, watch bool) ([]string, error) {
	key := notchAppKey(app)
	w.mu.Lock()
	next := []string{}
	for _, have := range w.never {
		if have != key {
			next = append(next, have)
		}
	}
	if !watch && key != "" {
		next = append(next, key)
	}
	next = notchNeverList(next)
	save := w.save
	w.mu.Unlock()
	if save != nil {
		if err := save(next); err != nil {
			return w.Never(), err
		}
	}
	w.mu.Lock()
	w.never = next
	w.mu.Unlock()
	w.tell()
	return next, nil
}

func (w *NotchWhere) Never() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string{}, w.never...)
}

// SetFront is the system saying which app is in front. icon is its picture as
// a PNG, or nil when it has none or it was given before.
func (w *NotchWhere) SetFront(front notchFront, icon []byte) {
	front.App = notchAppKey(front.App)
	if len(icon) > 0 && len(icon) <= notchIconMaxBytes {
		front.Icon = notchIconKey(icon)
	}
	w.mu.Lock()
	if front.Icon != "" && len(icon) > 0 {
		if len(w.icons) >= 48 {
			// Enough for a day's apps. Start again rather than keep count.
			w.icons = map[string][]byte{}
		}
		w.icons[front.Icon] = icon
	}
	w.front = front
	w.mu.Unlock()
	w.tell()
}

// SetPassword is the system saying a password field took, or gave up, the keyboard.
func (w *NotchWhere) SetPassword(password bool) {
	w.mu.Lock()
	changed := w.front.Password != password
	w.front.Password = password
	w.mu.Unlock()
	if changed {
		w.tell()
	}
}

// SetStill is whether the person's hands have been still for notchStillMs.
func (w *NotchWhere) SetStill(still bool) {
	w.mu.Lock()
	changed := w.still != still
	w.still = still
	w.mu.Unlock()
	if changed {
		w.tell()
	}
}

// Look is why this program is not looking now, or "" when it is. Always ""
// with the notch off: then nothing here holds the observers back.
func (w *NotchWhere) Look() notchLook {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.on {
		return notchLooking
	}
	return notchLookFor(w.front, w.never)
}

// Refuses says whether what an observer itself read (the app and the title it
// found when it looked) must not be sent. The observers read the front window
// on their own, a moment after this file last heard of it, so they are asked
// again with what they found.
func (w *NotchWhere) Refuses(app, title string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.on {
		return false
	}
	return notchLookFor(notchFront{App: notchAppKey(app), Title: title}, w.never) != notchLooking
}

// payload is what the brain is told. While this program looks away the title
// is not said: it is text from a window nobody is to read.
func notchWherePayload(front notchFront, look notchLook, still bool, never []string) map[string]any {
	title := front.Title
	if look != notchLooking {
		title = ""
	}
	return map[string]any{
		"app": front.App, "name": front.Name, "title": title, "icon": front.Icon,
		"look": string(look), "still": still, "never": append([]string{}, never...),
	}
}

// tell says the state to the brain, if it is connected and anything changed.
func (w *NotchWhere) tell() {
	w.mu.Lock()
	if !w.on || w.send == nil {
		w.mu.Unlock()
		return
	}
	look := notchLookFor(w.front, w.never)
	payload := notchWherePayload(w.front, look, w.still, w.never)
	said := strings.Join([]string{w.front.App, w.front.Name, payload["title"].(string), w.front.Icon, string(look),
		map[bool]string{true: "still", false: "moving"}[w.still], strings.Join(w.never, ",")}, "\x00")
	if said == w.last {
		w.mu.Unlock()
		return
	}
	w.last = said
	var icon []byte
	// The picture goes once per connection, and never while looking away:
	// then no app is shown at all.
	if w.front.Icon != "" && look == notchLooking && !w.sent[w.front.Icon] {
		if png, ok := w.icons[w.front.Icon]; ok {
			icon = png
			w.sent[w.front.Icon] = true
		}
	}
	send := w.send
	w.mu.Unlock()
	send(payload, icon)
}
