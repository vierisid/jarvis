package main

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// notchKeyboard stands between the platform's watch on the keyboard and the
// notch. The platform calls key for what it sees; this asks notchKeys what it
// means, tells the page what was said, and tells the platform whether to keep
// the key from the app and whether to send the harmless key.
//
// The watch runs only while the notch's page is up. No page, no watch: it
// cannot outlive the switch, because the page cannot.
type notchKeyboard struct {
	mu     sync.Mutex
	engine *notchKeys
	start  time.Time
	timer  *time.Timer
	// say delivers one action to the page. mask sends the harmless key.
	say  func(notchKeyAction)
	mask func()
	stop func()
}

// The pairs a machine has until its settings say otherwise.
func notchDefaultPairs(goos string) notchKeyPairs {
	if goos == "darwin" {
		return notchKeyPairs{Talk: notchPair{notchModCtrl, notchModAlt}, Yes: notchPair{notchModAlt, notchModMeta}}
	}
	return notchKeyPairs{Talk: notchPair{notchModCtrl, notchModMeta}, Yes: notchPair{notchModMeta, notchModAlt}}
}

var notchModNames = map[string]notchMods{"ctrl": notchModCtrl, "alt": notchModAlt, "meta": notchModMeta, "shift": notchModShift}

func notchModName(m notchMods) string {
	for name, mod := range notchModNames {
		if mod == m {
			return name
		}
	}
	return ""
}

// notchParsePair reads a pair as the settings write it: two modifier names
// joined by "+", such as "ctrl+meta". "win", "cmd" and "option" are accepted
// for the keys people call by those names.
func notchParsePair(text string) (notchPair, error) {
	parts := strings.Split(strings.ToLower(strings.ReplaceAll(text, " ", "")), "+")
	if len(parts) != 2 {
		return notchPair{}, fmt.Errorf("a pair is two keys joined by +, got %q", text)
	}
	var pair notchPair
	for i, part := range parts {
		switch part {
		case "win", "cmd", "super":
			part = "meta"
		case "option", "opt":
			part = "alt"
		case "control":
			part = "ctrl"
		}
		mod, ok := notchModNames[part]
		if !ok {
			return notchPair{}, fmt.Errorf("%q is not ctrl, alt, meta or shift", parts[i])
		}
		pair[i] = mod
	}
	if !pair.valid() {
		return notchPair{}, fmt.Errorf("a pair needs two different keys, got %q", text)
	}
	return pair, nil
}

// String writes a pair the way notchParsePair reads it.
func (p notchPair) String() string {
	return notchModName(p[0]) + "+" + notchModName(p[1])
}

// notchPairsScript tells the page which keys its hints should show.
func notchPairsScript(pairs notchKeyPairs) string {
	quoted := func(p notchPair) string {
		return fmt.Sprintf(`["%s","%s"]`, notchModName(p[0]), notchModName(p[1]))
	}
	return fmt.Sprintf(`window.__notch_pairs&&window.__notch_pairs({"talk":%s,"yes":%s});`, quoted(pairs.Talk), quoted(pairs.Yes))
}

// notchKeyScript tells the page what the keys said.
func notchKeyScript(action notchKeyAction) string {
	return fmt.Sprintf(`window.__notch_key&&window.__notch_key("%s");`, action.String())
}

func newNotchKeyboard(pairs notchKeyPairs, say func(notchKeyAction), mask func()) *notchKeyboard {
	return &notchKeyboard{engine: newNotchKeys(pairs), start: time.Now(), say: say, mask: mask}
}

// now is the engine's clock. It never reads 0: the engine keeps "no time" as 0,
// so a key in the very first millisecond must not look like no key at all.
func (kb *notchKeyboard) now() int64 { return time.Since(kb.start).Milliseconds() + 1 }

// key is called by the platform for each thing it saw, from the thread that
// watches the keyboard. It must come back at once: the system waits on it
// before the key goes anywhere. It reports whether to keep the key from the
// app in front.
func (kb *notchKeyboard) key(kind notchKeyKind, mods notchMods) (swallow bool) {
	kb.mu.Lock()
	v := kb.engine.Feed(notchKeyEvent{Kind: kind, Mods: mods, At: kb.now()})
	kb.arm(v.WakeAt)
	kb.mu.Unlock()
	kb.act(v)
	return v.Swallow
}

// arm sets the one timer the keys need: the moment a hold becomes talking.
// Called with the lock held.
func (kb *notchKeyboard) arm(wakeAt int64) {
	if kb.timer != nil {
		kb.timer.Stop()
		kb.timer = nil
	}
	if wakeAt == 0 {
		return
	}
	delay := time.Duration(wakeAt-kb.now()) * time.Millisecond
	if delay < 0 {
		delay = 0
	}
	kb.timer = time.AfterFunc(delay, kb.tick)
}

func (kb *notchKeyboard) tick() {
	kb.mu.Lock()
	v := kb.engine.Tick(kb.now())
	kb.arm(v.WakeAt)
	kb.mu.Unlock()
	kb.act(v)
}

func (kb *notchKeyboard) act(v notchKeyVerdict) {
	if v.Mask && kb.mask != nil {
		kb.mask()
	}
	for _, action := range v.Actions {
		if kb.say != nil {
			kb.say(action)
		}
	}
}

// wantEsc is the page saying whether Esc would do anything on the notch now.
func (kb *notchKeyboard) wantEsc(want bool) {
	kb.mu.Lock()
	kb.engine.WantEsc(want)
	kb.mu.Unlock()
}

// reset forgets every key: the keyboard cannot be trusted any more (the
// session was locked, the watch was put back). If the person was talking,
// that ends.
func (kb *notchKeyboard) reset() {
	kb.mu.Lock()
	ended := kb.engine.Reset()
	kb.arm(0)
	kb.mu.Unlock()
	kb.act(notchKeyVerdict{Actions: ended})
}

func (kb *notchKeyboard) setPairs(pairs notchKeyPairs) {
	kb.mu.Lock()
	ended := kb.engine.SetPairs(pairs)
	kb.arm(0)
	kb.mu.Unlock()
	kb.act(notchKeyVerdict{Actions: ended})
}

// watch starts the platform's watch on the keyboard. close ends it.
func (kb *notchKeyboard) watch() error {
	stop, err := platformNotchKeysStart(kb)
	if err != nil {
		return err
	}
	kb.mu.Lock()
	kb.stop = stop
	kb.mu.Unlock()
	log.Printf("[notch] keys: watching for %s to talk and %s for yes", kb.engine.pairs.Talk, kb.engine.pairs.Yes)
	return nil
}

func (kb *notchKeyboard) close() {
	kb.mu.Lock()
	stop := kb.stop
	kb.stop = nil
	kb.mu.Unlock()
	if stop != nil {
		stop()
	}
	kb.reset()
}
