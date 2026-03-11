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
type uiaElementCache struct {
	mu       sync.Mutex
	elements map[int]*ole.IDispatch
	nextID   int
}

func newUIAElementCache() *uiaElementCache {
	return &uiaElementCache{
		elements: make(map[int]*ole.IDispatch),
		nextID:   1,
	}
}

// add stores a COM element and returns its cache ID.
// The element is AddRef'd to prevent premature release.
func (c *uiaElementCache) add(elem *ole.IDispatch) int {
	c.mu.Lock()
	defer c.mu.Unlock()

	id := c.nextID
	c.nextID++
	elem.AddRef()
	c.elements[id] = elem
	return id
}

// get retrieves a cached element by ID. Returns nil if not found.
func (c *uiaElementCache) get(id int) *ole.IDispatch {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.elements[id]
}

// clear releases all cached COM elements and resets the cache.
func (c *uiaElementCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	for _, elem := range c.elements {
		elem.Release()
	}
	c.elements = make(map[int]*ole.IDispatch)
	c.nextID = 1
}

// size returns the number of cached elements.
func (c *uiaElementCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.elements)
}
