//go:build windows

// uia_cache_windows.go — Element cache with COM reference counting.
//
// Cached elements keep an AddRef'd COM pointer so they survive across
// RPC calls (e.g. snapshot → click). Cache is cleared on each new snapshot.
// The cache itself is platform-neutral (uia_element_guard.go, #712); this is
// its instantiation over COM elements.

package main

import "github.com/go-ole/go-ole"

// uiaElementCache maps integer IDs to live COM element pointers, with the
// print the snapshot reported for each (see elementCacheOf).
type uiaElementCache = elementCacheOf[*ole.IDispatch]

func newUIAElementCache() *uiaElementCache {
	return newElementCacheOf[*ole.IDispatch]()
}
