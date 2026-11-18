package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestNotchAppKey(t *testing.T) {
	for in, want := range map[string]string{
		"Notepad.exe": "notepad", " steam ": "steam", `C:\Program Files\Steam\Steam.exe`: "steam", "TextEdit.app": "textedit", "": "",
	} {
		if got := notchAppKey(in); got != want {
			t.Errorf("notchAppKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNotchBankTitle(t *testing.T) {
	for _, title := range []string{
		"Intesa Sanpaolo - Area clienti - Google Chrome", "UniCredit | Banca via Internet", "Online Banking - Mozilla Firefox",
		"Home banking Fineco", "PayPal: Summary", "Revolut Business", "N26 — The Mobile Bank", "Bank of America | Accounts",
		"Chase.com - Sign in", "La banque en ligne", "Sparkasse Berlin", "Coinbase - Portfolio", "Stripe Dashboard",
	} {
		if !notchBankTitle(title) {
			t.Errorf("%q should read as a bank", title)
		}
	}
	for _, title := range []string{
		"Untitled - Notepad", "Banksy - Wikipedia", "Embankment station", "Steam", "Wise words - YouTube", "The Chase | Netflix",
		"Inbox (3) - Gmail", "Visual Studio Code", "", "Hype trailer", "Listening", "Bankruptcy? no: Bankroll", "Thinking fast",
	} {
		if notchBankTitle(title) {
			t.Errorf("%q should not read as a bank", title)
		}
	}
}

func TestNotchLookFor(t *testing.T) {
	never := []string{"steam"}
	for _, c := range []struct {
		front notchFront
		want  notchLook
		name  string
	}{
		{notchFront{App: "notepad", Title: "Untitled - Notepad"}, notchLooking, "an ordinary app"},
		{notchFront{App: "steam", Title: "Steam"}, notchLookNever, "an app on the list"},
		{notchFront{App: "chrome", Title: "Sign in", Password: true}, notchLookPassword, "a password being typed"},
		{notchFront{App: "chrome", Title: "UniCredit | Banca via Internet"}, notchLookBank, "a bank"},
		// The person's own word comes first, then a password, then a bank.
		{notchFront{App: "steam", Title: "PayPal", Password: true}, notchLookNever, "all three"},
		{notchFront{App: "chrome", Title: "PayPal: Log in", Password: true}, notchLookPassword, "a password at a bank"},
		{notchFront{}, notchLooking, "nothing in front"},
	} {
		if got := notchLookFor(c.front, never); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestNotchNeverList(t *testing.T) {
	got := notchNeverList([]string{"Steam.exe", "notepad", "steam", "", "  ", "Chrome"})
	if want := []string{"chrome", "notepad", "steam"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// A brain with the notch on is connected: it is told where the person is.
type whereSent struct {
	payload map[string]any
	icon    []byte
}

func newWhere(t *testing.T) (*NotchWhere, *[]whereSent) {
	t.Helper()
	w := &NotchWhere{icons: map[string][]byte{}}
	sent := &[]whereSent{}
	w.Use(func(payload map[string]any, icon []byte) { *sent = append(*sent, whereSent{payload, icon}) })
	return w, sent
}

func TestNotchWhereTellsTheBrainOnceForEachChange(t *testing.T) {
	w, sent := newWhere(t)
	if len(*sent) != 1 {
		t.Fatalf("on connecting it says what it knows, once: got %d", len(*sent))
	}
	png := []byte("not really a png, but bytes")
	w.SetFront(notchFront{App: "Notepad.exe", Name: "Notepad", Title: "Untitled - Notepad"}, png)
	last := (*sent)[len(*sent)-1]
	if last.payload["app"] != "notepad" || last.payload["name"] != "Notepad" || last.payload["title"] != "Untitled - Notepad" || last.payload["look"] != "" {
		t.Errorf("the front app: %v", last.payload)
	}
	if string(last.icon) != string(png) || last.payload["icon"] != notchIconKey(png) {
		t.Errorf("the icon goes with the first mention, under its key: %v", last.payload["icon"])
	}
	// The same thing again is not said again.
	n := len(*sent)
	w.SetFront(notchFront{App: "notepad", Name: "Notepad", Title: "Untitled - Notepad"}, png)
	if len(*sent) != n {
		t.Errorf("nothing changed, and %d more were sent", len(*sent)-n)
	}
	// Away and back: the picture is not sent a second time on this connection.
	w.SetFront(notchFront{App: "steam", Name: "Steam", Title: "Steam"}, nil)
	w.SetFront(notchFront{App: "notepad", Name: "Notepad", Title: "notes.txt - Notepad"}, png)
	last = (*sent)[len(*sent)-1]
	if last.icon != nil || last.payload["icon"] != notchIconKey(png) {
		t.Errorf("the second time only the key is sent: icon %d bytes, key %v", len(last.icon), last.payload["icon"])
	}
	// Hands still, hands moving.
	w.SetStill(true)
	if (*sent)[len(*sent)-1].payload["still"] != true {
		t.Error("hands still must be said")
	}
	n = len(*sent)
	w.SetStill(true)
	if len(*sent) != n {
		t.Error("still, said twice")
	}
}

func TestNotchWhereLooksAwayAndSaysNoTitle(t *testing.T) {
	w, sent := newWhere(t)
	png := []byte("icon")
	w.SetFront(notchFront{App: "chrome", Name: "Google Chrome", Title: "UniCredit | Banca via Internet"}, png)
	last := (*sent)[len(*sent)-1]
	if last.payload["look"] != "bank" || last.payload["title"] != "" {
		t.Errorf("a bank: %v", last.payload)
	}
	if last.icon != nil {
		t.Error("no picture is sent while looking away: no app is shown then")
	}
	if w.Look() != notchLookBank {
		t.Errorf("Look() = %q", w.Look())
	}
	w.SetFront(notchFront{App: "chrome", Name: "Google Chrome", Title: "New Tab"}, png)
	if w.Look() != notchLooking {
		t.Errorf("back on an ordinary page: Look() = %q", w.Look())
	}
	w.SetPassword(true)
	last = (*sent)[len(*sent)-1]
	if w.Look() != notchLookPassword || last.payload["look"] != "password" || last.payload["title"] != "" {
		t.Errorf("a password: Look() = %q, payload %v", w.Look(), last.payload)
	}
	w.SetPassword(false)
	if w.Look() != notchLooking {
		t.Errorf("the password field lost the keyboard: Look() = %q", w.Look())
	}
}

func TestNotchWhereNeverWatchIsSavedAndHeld(t *testing.T) {
	w, sent := newWhere(t)
	var saved [][]string
	w.SetNever([]string{"Steam.exe"}, func(list []string) error { saved = append(saved, list); return nil })
	w.SetFront(notchFront{App: "notepad", Name: "Notepad", Title: "Untitled - Notepad"}, nil)
	if w.Look() != notchLooking {
		t.Fatalf("Notepad is not on the list: %q", w.Look())
	}
	list, err := w.NeverWatch("Notepad", false)
	if err != nil || !reflect.DeepEqual(list, []string{"notepad", "steam"}) || !reflect.DeepEqual(saved[len(saved)-1], list) {
		t.Errorf("never watch Notepad: list %v, saved %v, err %v", list, saved, err)
	}
	last := (*sent)[len(*sent)-1]
	if w.Look() != notchLookNever || last.payload["look"] != "never" || last.payload["title"] != "" {
		t.Errorf("it stops looking at once: Look() = %q, payload %v", w.Look(), last.payload)
	}
	// What an observer read by itself a moment later is refused too.
	if !w.Refuses("Notepad.exe", "Untitled - Notepad") || !w.Refuses("chrome", "PayPal: Summary") || w.Refuses("code", "main.go - Visual Studio Code") {
		t.Error("an observer's own reading is judged by the same rule")
	}
	list, err = w.NeverWatch("notepad", true)
	if err != nil || !reflect.DeepEqual(list, []string{"steam"}) || w.Look() != notchLooking {
		t.Errorf("watch Notepad again: list %v, err %v, Look() = %q", list, err, w.Look())
	}
	// A list that cannot be saved is not changed.
	w.SetNever([]string{"steam"}, func([]string) error { return errors.New("disk full") })
	if list, err := w.NeverWatch("notepad", false); err == nil || !reflect.DeepEqual(list, []string{"steam"}) || w.Look() != notchLooking {
		t.Errorf("a failed save: list %v, err %v, Look() = %q", list, err, w.Look())
	}
}

func TestNotchWhereDoesNothingWithTheNotchOff(t *testing.T) {
	w := &NotchWhere{icons: map[string][]byte{}}
	w.SetNever([]string{"steam"}, nil)
	w.SetFront(notchFront{App: "steam", Name: "Steam", Title: "PayPal", Password: true}, nil)
	if w.Look() != notchLooking || w.Refuses("steam", "PayPal") || w.On() {
		t.Error("with the notch off nothing here holds the observers back")
	}
	sent := 0
	w.Use(func(map[string]any, []byte) { sent++ })
	if w.Look() != notchLookNever || sent != 1 {
		t.Errorf("when a brain with the notch on connects it is told at once: Look() = %q, sent %d", w.Look(), sent)
	}
	w.Forget()
	if w.Look() != notchLooking || w.Refuses("steam", "Steam") {
		t.Error("and when it goes, the observers are as they were")
	}
}

func TestNotchWherePayloadNamesTheListAndNeverTheTitleWhileAway(t *testing.T) {
	p := notchWherePayload(notchFront{App: "chrome", Name: "Google Chrome", Title: "secret", Icon: "k"}, notchLookPassword, true, []string{"steam"})
	if p["title"] != "" || p["look"] != "password" || p["still"] != true || !reflect.DeepEqual(p["never"], []string{"steam"}) {
		t.Errorf("got %v", p)
	}
	if notchIconKey(nil) != "" || notchIconKey([]byte("a")) == notchIconKey([]byte("b")) || len(notchIconKey([]byte("a"))) != 16 {
		t.Error("an icon's key is its own, and nothing has none")
	}
}

// A yes or no from Windows is 16 bits of a 64-bit field. The rest can hold
// anything, and a "no" must stay a "no" whatever is above it.
func TestOleBoolReadsOnlyItsSixteenBits(t *testing.T) {
	for _, tc := range []struct {
		val  int64
		want bool
	}{
		{0, false},
		{0xFFFF, true},                    // VARIANT_TRUE
		{1, true},                         // some programs say yes as 1
		{0x7FF6_1234_0000, false},         // no, with stray bits above it
		{int64(-1) << 16, false},          // no, with every other bit set
		{0x7FF6_1234_0000 | 0xFFFF, true}, // yes, with stray bits above it
		{int64(-1), true},
	} {
		if got := oleBoolIsTrue(tc.val); got != tc.want {
			t.Errorf("oleBoolIsTrue(%#x) = %v, want %v", tc.val, got, tc.want)
		}
	}
}

// The hardening audit, 17 November 2026: a second window of the browser was
// judged by the site of the one in front. GitHub in front, the bank in the
// second window, and the bank's window was looked at.
func TestAnotherWindowOfTheBrowserIsNotJudgedByTheSiteOfTheOneInFront(t *testing.T) {
	w := &NotchWhere{icons: map[string][]byte{}}
	w.Use(func(map[string]any, []byte) {})
	w.SetFront(notchFront{App: "chrome", Name: "Google Chrome", Title: "Pull requests - Google Chrome", Site: "github.com"}, nil)
	if w.Refuses("chrome", "Pull requests - Google Chrome") {
		t.Fatal("the window in front is GitHub: looked at")
	}
	if !w.Refuses("chrome", "PayPal: Summary - Google Chrome") {
		t.Fatal("a second window of the browser showing the bank is not looked at")
	}
	if w.Refuses("chrome", "Recipes for bread - Google Chrome") {
		t.Fatal("a second window showing something harmless is looked at")
	}
	// And the other way round: the bank in front refuses the browser's other windows too.
	w.SetFront(notchFront{App: "chrome", Name: "Google Chrome", Title: "PayPal: Summary - Google Chrome", Site: "paypal.com"}, nil)
	if !w.Refuses("chrome", "Recipes for bread - Google Chrome") {
		t.Fatal("with the bank in front, nothing of that browser is looked at")
	}
}
