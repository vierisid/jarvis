package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// FileObserver is a dependency-free, cross-platform file watcher. It walks a
// set of root directories on an interval, tracks modification times, and emits
// file_change events (created / modified / deleted) when something changes.
//
// It deliberately mirrors the payload the brain's old FileWatcher produced
// ({path, eventType, filename, basePath}) so downstream classification, vault
// storage, and workflow `observer.file_changed` triggers keep working unchanged
// after the move from brain to sidecar.
//
// Polling (rather than inotify / kqueue / ReadDirectoryChangesW) keeps it
// portable across all three platforms with no cgo and no new dependency. The
// walk is bounded — noisy directories are skipped wholesale, the number of
// tracked entries is capped, and emits per poll are capped — so a large home
// tree can't melt the CPU or flood the brain.
type FileObserver struct {
	roots        []string
	excludePaths []string // absolute path prefixes always skipped
	pollInterval time.Duration
	maxEntries   int
	maxEmits     int

	known map[string]int64 // abs path -> modtime UnixNano
	mu    sync.Mutex

	truncated   bool // last scan hit maxEntries (coverage capped)
	truncWarned bool // truncation already logged once
}

// fileWatchSkipDirs are directory base names skipped wholesale: huge,
// machine-generated, or otherwise noise for awareness.
var fileWatchSkipDirs = map[string]bool{
	"node_modules": true,
	".git":         true,
	".cache":       true,
	".npm":         true,
	".cargo":       true,
	"venv":         true,
	".venv":        true,
	"__pycache__":  true,
	"target":       true,
	"dist":         true,
	"build":        true,
}

// NewFileObserver builds a watcher over roots (defaulting to the user's home),
// skipping anything under excludePaths. pollMs defaults to 5000.
func NewFileObserver(roots []string, excludePaths []string, pollMs int) *FileObserver {
	if pollMs <= 0 {
		pollMs = 5000
	}
	if len(roots) == 0 {
		roots = []string{homeDir()}
	}
	return &FileObserver{
		roots:        roots,
		excludePaths: excludePaths,
		pollInterval: time.Duration(pollMs) * time.Millisecond,
		maxEntries:   20000,
		maxEmits:     100,
		known:        make(map[string]int64),
	}
}

func (o *FileObserver) excluded(path string) bool {
	for _, p := range o.excludePaths {
		if p == "" {
			continue
		}
		// Match the excluded dir itself or anything under it, but NOT a sibling
		// that merely shares the prefix (exclude ".../.jarvis" must not also
		// swallow ".../.jarvis-backup").
		if path == p || strings.HasPrefix(path, p+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

// scan walks the roots and returns a snapshot of path -> modtime UnixNano.
// Hidden directories (other than a root itself), known-noisy dirs, and excluded
// path prefixes are skipped, and the total entry count is capped.
func (o *FileObserver) scan() map[string]int64 {
	snapshot := make(map[string]int64)
	count := 0
	o.truncated = false
	for _, root := range o.roots {
		if count >= o.maxEntries {
			o.truncated = true
			break
		}
		_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				// Unreadable entry — skip its subtree if a dir, else ignore.
				if d != nil && d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if path != root && o.excluded(path) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				base := d.Name()
				if path != root && (fileWatchSkipDirs[base] || strings.HasPrefix(base, ".")) {
					return filepath.SkipDir
				}
				return nil
			}
			info, infoErr := d.Info()
			if infoErr != nil {
				return nil
			}
			snapshot[path] = info.ModTime().UnixNano()
			count++
			if count >= o.maxEntries {
				o.truncated = true
				return filepath.SkipAll
			}
			return nil
		})
	}
	return snapshot
}

// Run seeds the baseline (without emitting), then polls until ctx is cancelled.
func (o *FileObserver) Run(ctx context.Context, send EventSender) {
	log.Printf("[files] Monitoring %v (every %s)", o.roots, o.pollInterval)

	// Seed without emitting so we don't flood on startup with one "created"
	// per pre-existing file.
	seed := o.scan()
	o.mu.Lock()
	o.known = seed
	o.mu.Unlock()
	log.Printf("[files] Seeded with %d files", len(seed))

	ticker := time.NewTicker(o.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			o.poll(ctx, send)
		}
	}
}

func (o *FileObserver) poll(ctx context.Context, send EventSender) {
	current := o.scan()

	// Surface a capped walk once: beyond maxEntries the snapshot is partial, so
	// created/deleted diffs near the cap boundary may be noisy.
	if o.truncated && !o.truncWarned {
		o.truncWarned = true
		log.Printf("[files] Watch tree exceeds %d entries; coverage is capped and some changes may be missed", o.maxEntries)
	}

	o.mu.Lock()
	prev := o.known
	o.known = current
	o.mu.Unlock()

	emitted := 0
	truncated := false

	emit := func(path, eventType string) {
		if emitted >= o.maxEmits {
			truncated = true
			return
		}
		o.send(ctx, send, path, eventType)
		emitted++
	}

	// created / modified
	for path, mod := range current {
		old, existed := prev[path]
		if !existed {
			emit(path, "created")
		} else if mod != old {
			emit(path, "modified")
		}
	}
	// deleted
	for path := range prev {
		if _, ok := current[path]; !ok {
			emit(path, "deleted")
		}
	}

	if truncated {
		log.Printf("[files] Emitted %d events this poll; further changes suppressed (cap %d)", emitted, o.maxEmits)
	}
}

func (o *FileObserver) send(ctx context.Context, send EventSender, path, eventType string) {
	// basePath is the longest matching root prefix, mirroring the brain's
	// FileWatcher which tagged each event with its watch root.
	base := ""
	for _, root := range o.roots {
		if strings.HasPrefix(path, root) && len(root) > len(base) {
			base = root
		}
	}
	event := SidecarEvent{
		Type:      "sidecar_event",
		EventType: "file_change",
		Timestamp: time.Now().UnixMilli(),
		Priority:  "low",
		Payload: map[string]any{
			"path":      path,
			"eventType": eventType,
			"filename":  filepath.Base(path),
			"basePath":  base,
		},
	}
	if err := send(ctx, event, nil); err != nil {
		log.Printf("[files] Failed to send event: %v", err)
	}
}
