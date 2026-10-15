package main

import "sync"

// uia_element_guard.go -- the Windows element cache and the check every action
// on it runs (#661), with no COM in it, so it compiles and runs on every
// platform (#712).
//
// Before this the whole of it lived in windows-tagged files, which CI only
// cross-compiles: the AutomationId comparison and the never-reused ids were
// compile-checked and nothing more. Windows differs from Linux and macOS by
// design -- it acts through the live COM element, so the comparison is name,
// role and AutomationId but not position, and a find_element adds to the cache
// instead of replacing it -- so the Linux tests did not stand in for it. The
// COM half (reading a live element's print, the pattern calls) stays in
// uia_actions_windows.go and uia_cache_windows.go.

// refCounted is what the cache needs of an element: a COM pointer is AddRef'd
// while cached and Released when the cache lets it go.
type refCounted interface {
	AddRef() int32
	Release() int32
}

// elementCacheOf maps integer ids to live elements and the print the snapshot
// reported for each.
//
// The pointer stays bound to one provider element, but that is weaker than it
// sounds: a provider may re-point an element at different content -- the
// MSAA-proxied list items behind many Win32 list views are addressed by index,
// so a re-sorted list leaves the same pointer naming a different row. So the
// guard compares the print before an action. And ids are never reused within a
// process (see clear), so an id from an earlier snapshot is unknown rather than
// re-pointed at the new snapshot's element N.
type elementCacheOf[T refCounted] struct {
	mu       sync.Mutex
	elements map[int]T
	prints   map[int]desktopElementPrint
	nextID   int
}

func newElementCacheOf[T refCounted]() *elementCacheOf[T] {
	return &elementCacheOf[T]{
		elements: make(map[int]T),
		prints:   make(map[int]desktopElementPrint),
		nextID:   1,
	}
}

// add stores an element with the print the caller is about to report for it,
// and returns its id. The element is AddRef'd so it outlives the walk.
func (c *elementCacheOf[T]) add(elem T, snap desktopElementPrint) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.nextID
	c.nextID++
	elem.AddRef()
	c.elements[id] = elem
	c.prints[id] = snap
	return id
}

// get retrieves a cached element and its snapshot print; ok is false for an
// id this cache does not hold.
func (c *elementCacheOf[T]) get(id int) (elem T, snap desktopElementPrint, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	elem, ok = c.elements[id]
	return elem, c.prints[id], ok
}

// clear releases every cached element and empties the cache. It does NOT
// restart nextID (#661): restarting at 1 meant snapshot B's element N answered
// to the id snapshot A gave element N -- with B's own print, so the guard
// passed -- and an id from an earlier snapshot acted on an element the model
// was never shown. Counting on for the life of the process leaves every
// earlier id unknown, which is a refusal.
func (c *elementCacheOf[T]) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, elem := range c.elements {
		elem.Release()
	}
	c.elements = make(map[int]T)
	c.prints = make(map[int]desktopElementPrint)
}

// size returns the number of cached elements.
func (c *elementCacheOf[T]) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.elements)
}

// guardCachedElement is what every Windows action runs before it acts, read-only
// ones included: get_value would otherwise hand back the text of whatever the
// id names now. live reads the element's print as it is now. Not positional,
// because every action goes through the live element and the mouse fallback
// reads its bounds at click time. Every error is returned before anything acts.
func guardCachedElement[T refCounted](c *elementCacheOf[T], id int, live func(T) desktopElementPrint) (T, error) {
	elem, snap, ok := c.get(id)
	if !ok {
		var zero T
		return zero, desktopElementNotCached(id)
	}
	if why := desktopElementChange(snap, live(elem), false); why != "" {
		var zero T
		return zero, desktopElementStale(id, why)
	}
	return elem, nil
}
