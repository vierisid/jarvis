//go:build windows

// uia_cache_windows.go — Element cache with COM reference counting.
//
// Cached elements keep an AddRef'd COM pointer so they survive across
// RPC calls (e.g. snapshot → click). Cache is cleared on each new snapshot.

package main

import (
	"sync"

	"github.com/go-ole/go-ole"
)

// uiaElementCache maps integer IDs to live COM element pointers.
//
// Each entry also keeps the print the snapshot reported for it (#661). The
// COM pointer stays bound to one provider element, but that is weaker than it
// sounds: a provider may re-point an element at different content -- the
// MSAA-proxied list items behind many Win32 list views are addressed by
// index, so a re-sorted list leaves the same pointer naming a different row.
// uiaPerformAction compares the print before it acts. And ids are never
// reused within a process (see clear), so an id from an earlier snapshot is
// unknown rather than re-pointed at the new snapshot's element N.
type uiaElementCache struct {
	mu       sync.Mutex
	elements map[int]*ole.IDispatch
	prints   map[int]desktopElementPrint
	nextID   int
}

func newUIAElementCache() *uiaElementCache {
	return &uiaElementCache{
		elements: make(map[int]*ole.IDispatch),
		prints:   make(map[int]desktopElementPrint),
		nextID:   1,
	}
}

// add stores a COM element with the print the caller is about to report for
// it, and returns its cache ID. The element is AddRef'd to prevent premature
// release.
func (c *uiaElementCache) add(elem *ole.IDispatch, snap desktopElementPrint) int {
	c.mu.Lock()
	defer c.mu.Unlock()

	id := c.nextID
	c.nextID++
	elem.AddRef()
	c.elements[id] = elem
	c.prints[id] = snap
	return id
}

// get retrieves a cached element and its snapshot print by ID. Returns nil
// if not found.
func (c *uiaElementCache) get(id int) (*ole.IDispatch, desktopElementPrint) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.elements[id], c.prints[id]
}

// clear releases all cached COM elements and empties the cache. It does NOT
// restart nextID (#661): restarting at 1 meant snapshot B's element N answered
// to the id snapshot A gave element N -- with B's own print, so the check in
// uiaPerformAction passed -- and an id from an earlier snapshot clicked an
// element the model was never shown. Counting on for the life of the process
// leaves every earlier id unknown, which is a refusal.
func (c *uiaElementCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	for _, elem := range c.elements {
		elem.Release()
	}
	c.elements = make(map[int]*ole.IDispatch)
	c.prints = make(map[int]desktopElementPrint)
}

// size returns the number of cached elements.
func (c *uiaElementCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.elements)
}
