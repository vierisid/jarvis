package main

import (
	"errors"
	"strings"
	"testing"
)

// #712: the Windows half of #661 -- the cache that never reuses an id, and
// the name/role/AutomationId comparison that ignores position -- run on every
// platform, against the print shape the UIA walk produces (role as
// controlTypeName spells it, the AutomationId, the bounding rect).

// fakeCOMElement stands in for a COM element: it counts its references and
// carries the print a live read would return.
type fakeCOMElement struct {
	refs int32
	now  desktopElementPrint
}

func (e *fakeCOMElement) AddRef() int32  { e.refs++; return e.refs }
func (e *fakeCOMElement) Release() int32 { e.refs--; return e.refs }

func livePrint(e *fakeCOMElement) desktopElementPrint { return e.now }

var sendButton = desktopElementPrint{name: "Send", role: "Button", autoID: "sendButton", x: 900, y: 600, w: 80, h: 30}

func TestUIAGuardComparesNameRoleAndAutomationIDButNotPosition(t *testing.T) {
	for _, tc := range []struct {
		name string
		live desktopElementPrint
		want string // "" = acted on
	}{
		{"unchanged", sendButton, ""},
		// The live element is what is acted on, so a moved window has not
		// re-pointed the id: Windows passes what Linux and macOS refuse.
		{"window moved", func() desktopElementPrint { p := sendButton; p.x, p.y = 10, 10; return p }(), ""},
		{"renamed", func() desktopElementPrint { p := sendButton; p.name = "Delete"; return p }(), "is a different element now"},
		{"recast", func() desktopElementPrint { p := sendButton; p.role = "Hyperlink"; return p }(), "is a different element now"},
		// Same name and role, different control: the AutomationId is the
		// only thing that tells a re-sorted list's rows apart.
		{"other automation id", func() desktopElementPrint { p := sendButton; p.autoID = "discardButton"; return p }(), "is a different element now"},
		// A dead element reads back empty.
		{"element gone", desktopElementPrint{}, "is a different element now"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newElementCacheOf[*fakeCOMElement]()
			el := &fakeCOMElement{now: tc.live}
			id := c.add(el, sendButton)
			got, err := guardCachedElement(c, id, livePrint)
			if tc.want == "" {
				if err != nil || got != el {
					t.Fatalf("refused an element that is still the one listed: %v", err)
				}
				return
			}
			var coded *codedError
			if err == nil || !errors.As(err, &coded) || coded.code != desktopStaleElementCode || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want a %s refusal saying %q", err, desktopStaleElementCode, tc.want)
			}
		})
	}
}

func TestUIACacheNeverReusesAnIDAcrossSnapshots(t *testing.T) {
	c := newElementCacheOf[*fakeCOMElement]()
	a := &fakeCOMElement{now: sendButton}
	oldID := c.add(a, sendButton)
	if a.refs != 1 {
		t.Fatalf("a cached element holds %d references, want 1", a.refs)
	}

	// A new snapshot clears the cache, releasing what it held...
	c.clear()
	if a.refs != 0 || c.size() != 0 {
		t.Fatalf("clear left refs=%d size=%d", a.refs, c.size())
	}
	// ...and its first element does not answer to the old snapshot's first id.
	b := &fakeCOMElement{now: desktopElementPrint{name: "Delete", role: "Button"}}
	newID := c.add(b, b.now)
	if newID == oldID {
		t.Fatalf("snapshot B reused id %d", oldID)
	}
	if _, err := guardCachedElement(c, oldID, livePrint); err == nil || !strings.Contains(err.Error(), "not in the current element cache") {
		t.Fatalf("an id from an earlier snapshot got %v, want a not-cached refusal", err)
	}
}

func TestUIAFindElementAddsWithoutInvalidatingSnapshotIDs(t *testing.T) {
	// find_element adds to the cache instead of clearing it (uiaFindElement,
	// "allow mixing inspect + find results"), so a snapshot id stays usable.
	c := newElementCacheOf[*fakeCOMElement]()
	snapEl := &fakeCOMElement{now: sendButton}
	snapID := c.add(snapEl, sendButton)
	found := &fakeCOMElement{now: desktopElementPrint{name: "To", role: "Edit", autoID: "to"}}
	foundID := c.add(found, found.now)
	if foundID == snapID {
		t.Fatal("find_element reused a snapshot id")
	}
	for _, id := range []int{snapID, foundID} {
		if _, err := guardCachedElement(c, id, livePrint); err != nil {
			t.Errorf("id %d refused after a find: %v", id, err)
		}
	}
}
