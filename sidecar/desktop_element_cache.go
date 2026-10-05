//go:build linux || darwin

package main

import (
	"fmt"
	"sync"
	"time"
)

// desktop_element_cache.go -- the element cache behind desktop_click and
// desktop_type's element_id on Linux and macOS, and the check every action
// on it runs (#661). See desktop_element_identity.go for why the check is a
// read-back and not a time bound.
//
// TWO checks, because they close different holes:
//
//  1. The id names ONE walk. Both walks number elements by their index in a
//     depth-first walk, and an index alone means "element N of whatever the
//     cache holds now": a later walk -- another window's find_element, a
//     sub-agent's snapshot, a parallel call in the same turn -- re-pointed
//     every old id at an element the model was never shown, and a read-back
//     compared that later walk with itself and passed. So fill rewrites each
//     id to gen*desktopElementIDStride + index, and an id from any other fill
//     is "not in the cache".
//
//  2. The element is still there. The surface changes between turns without
//     any walk: a window moves, a dialog is replaced. So every action walks
//     again with the SAME pid and depth -- what makes index N in the new walk
//     comparable with index N in the old one -- and refuses unless that
//     element has the same role, name and rect.
//
// Only the walk is per platform (walkDesktopElements, in desktop_linux.go and
// desktop_darwin.go).
//
// THE BUDGET. The read-back is one extra walk per element action, and the
// daemon gives an RPC 30s before it stops waiting (DEFAULT_RPC_TIMEOUTS,
// src/sidecar/protocol.ts) -- after which the action may still land while the
// model is told it "may have occurred" and retries. So the read-back gets a
// budget per caller that keeps walk + click (5s) + keystroke (10s) at or under
// Linux's 25s: the AT-SPI walk's own 10s everywhere on Linux; on macOS the
// JXA walk's 20s for a click (25s) but 10s ahead of a keystroke (25s, where
// 20s would be 35s). A walk that overruns its budget is a refusal before
// anything is clicked, never a late click.
type desktopElementCache struct {
	mu       sync.Mutex
	elements []map[string]any
	pid      int
	depth    int
	// gen counts fills, and is the high part of every id the current fill
	// handed out.
	gen uint64
}

// desktopElementIDStride separates one fill's ids from the next. Both walks
// stop at 201 elements (`len(elements) > 200` in the AT-SPI script and
// `elements.length > 200` in the JXA one), so 1000 leaves room and keeps ids
// readable: the first snapshot's elements are 1000..1200, the next 2000..2200.
const desktopElementIDStride = 1000

var elementCache desktopElementCache

// fill replaces the cache with one walk's elements and REWRITES their `id`
// fields in place to this fill's ids, so the reply the caller is about to send
// hands the model ids bound to this walk. `depth` must be the depth the walk
// used, or a later read-back walks a different tree.
func (c *desktopElementCache) fill(elems []any, pid, depth int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	c.elements = make([]map[string]any, 0, len(elems))
	for _, e := range elems {
		m, ok := e.(map[string]any)
		if !ok {
			continue
		}
		if len(c.elements) >= desktopElementIDStride {
			// Past the stride an id would spill into the next fill's range.
			// Unreachable under the walks' own cap; an element with no id is
			// one nothing can address, rather than one addressed wrongly.
			delete(m, "id")
			continue
		}
		m["id"] = int(c.gen)*desktopElementIDStride + len(c.elements)
		c.elements = append(c.elements, m)
	}
	c.pid = pid
	c.depth = depth
}

// forget empties the cache and retires every id it handed out, for a walk
// that failed or returned nothing (#661 review). Without it a failed snapshot
// left the previous walk's ids live, so "any later snapshot makes an id
// unknown" held only for a later snapshot that worked. Same rule as the
// browser's forgetSnapshotElements on every takePageSnapshot failure.
func (c *desktopElementCache) forget() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	c.elements = nil
	c.pid, c.depth = 0, 0
}

func (c *desktopElementCache) generation() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen
}

// lookup reads one element and everything needed to re-check it in a single
// critical section, so a concurrent fill cannot pair this element with the
// next walk's pid or depth. `index` is the element's position in its walk.
// An id from any fill but the current one is not found.
func (c *desktopElementCache) lookup(id int) (el map[string]any, index, pid, depth int, gen uint64, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if id < 0 || c.gen == 0 || uint64(id/desktopElementIDStride) != c.gen {
		return nil, 0, 0, 0, 0, false
	}
	index = id % desktopElementIDStride
	if index >= len(c.elements) {
		return nil, 0, 0, 0, 0, false
	}
	if _, hasRect := c.elements[index]["rect"].(map[string]any); !hasRect {
		return nil, 0, 0, 0, 0, false
	}
	return c.elements[index], index, c.pid, c.depth, c.gen, true
}

// printOf reads an AT-SPI or JXA element map the way both walks write it.
func printOf(el map[string]any) desktopElementPrint {
	p := desktopElementPrint{}
	p.name, _ = el["name"].(string)
	p.role, _ = el["control_type"].(string)
	p.autoID, _ = el["automation_id"].(string)
	if r, ok := el["rect"].(map[string]any); ok {
		p.x, p.y, p.w, p.h = toInt(r["x"]), toInt(r["y"]), toInt(r["w"]), toInt(r["h"])
	}
	return p
}

// resolveDesktopElement is the guard every action on a cached element id runs
// before it dispatches anything. It returns the rect to act at, which is the
// one the read-back just confirmed, or an error -- and every error is returned
// before a click, so all of them may be reported as not started.
//
// slowHint is appended when the read-back itself fails, for a caller whose
// budget is tighter than a snapshot's: "take a fresh snapshot" cannot help a
// window that is merely slower to walk than that budget, and a model told only
// that would loop.
func resolveDesktopElement(id int, walkBudget time.Duration, slowHint string) (map[string]any, error) {
	cached, index, pid, depth, gen, ok := elementCache.lookup(id)
	if !ok {
		return nil, desktopElementNotCached(id)
	}
	live, err := walkDesktopElements(pid, depth, walkBudget)
	if err != nil {
		return nil, &codedError{code: desktopStaleElementCode, err: fmt.Errorf(
			"could not re-read the window to confirm element [%d] is still the one the snapshot listed, so nothing was done "+
				"(%v). Run desktop_snapshot again%s", id, err, slowHint)}
	}
	if index >= len(live) {
		return nil, desktopElementStale(id, "has disappeared")
	}
	liveEl, _ := live[index].(map[string]any)
	if liveEl == nil {
		return nil, desktopElementStale(id, "has disappeared")
	}
	liveRect, hasRect := liveEl["rect"].(map[string]any)
	if !hasRect {
		return nil, desktopElementStale(id, "has disappeared")
	}
	if why := desktopElementChange(printOf(cached), printOf(liveEl), true); why != "" {
		return nil, desktopElementStale(id, why)
	}
	// A fill that landed DURING the read-back has made this id one from an
	// earlier snapshot, which lookup would now refuse; refused here too, so the
	// rule is "ids from the current snapshot" whenever the fill lands. A fill
	// after this line cannot re-target the click: the rect returned is the one
	// just confirmed, not a fresh read of the cache.
	if elementCache.generation() != gen {
		return nil, desktopElementSuperseded(id)
	}
	return liveRect, nil
}

// findInWalk filters one walk's elements -- the reply of the handleGetWindowTree
// call find_element just made, whose ids fill already rewrote -- rather than
// re-reading elementCache, which a concurrent fill may have replaced with
// another walk (another pid, other ids) in between.
func findInWalk(result any, name, controlType, className string) []map[string]any {
	tree, _ := result.(map[string]any)
	elems, _ := tree["elements"].([]any)
	var matches []map[string]any
	for _, e := range elems {
		el, ok := e.(map[string]any)
		if !ok {
			continue
		}
		if _, addressable := el["id"]; !addressable {
			continue
		}
		if name != "" {
			if elName, _ := el["name"].(string); elName != name {
				continue
			}
		}
		if controlType != "" {
			if elType, _ := el["control_type"].(string); elType != controlType {
				continue
			}
		}
		if className != "" {
			if elClass, _ := el["class_name"].(string); elClass != className {
				continue
			}
		}
		matches = append(matches, el)
	}
	return matches
}
