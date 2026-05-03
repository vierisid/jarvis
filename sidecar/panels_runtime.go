package main

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	webview "github.com/webview/webview_go"
)

// panelImpl wraps a single webview window and the channel used to control it.
type panelImpl struct {
	spec       PanelSpec
	wv         webview.WebView // assigned by the runner goroutine
	ready      chan struct{}   // closed once wv is set + flags applied
	done       chan struct{}   // closed when Run() returns
	following  atomic.Bool     // when true, cursor-tracker actively moves window
	followStop chan struct{}   // closed by Close()/Stop() to halt the tracker
	hotkeyStop func()          // unregister + stop the hotkey listener
}

// panelService is the cross-platform PanelService implementation. The actual
// window-flag work (always-on-top, transparent, frameless, click-through) is
// delegated to applyPlatformFlags which is implemented per OS in panels_<os>.go.
type panelService struct {
	mu  sync.Mutex
	reg *panelRegistry
}

// NewPanelService constructs a PanelService that uses webview_go for window
// hosting. macOS callers should ensure the main goroutine runs the first
// webview's event loop on the main OS thread (see runPanelMainLoop).
func NewPanelService() PanelService {
	return &panelService{reg: newPanelRegistry()}
}

func (s *panelService) Spawn(spec PanelSpec) (PanelID, error) {
	if err := validateSpec(spec); err != nil {
		return "", err
	}
	spec = resolveSpec(spec)

	s.mu.Lock()
	if !spec.MultiInstance {
		if _, exists := s.reg.get(spec.ID); exists {
			s.mu.Unlock()
			return spec.ID, formatPanelError("spawn", spec.ID, ErrPanelExists)
		}
	}
	impl := &panelImpl{
		spec:       spec,
		ready:      make(chan struct{}),
		done:       make(chan struct{}),
		followStop: make(chan struct{}),
	}
	if spec.FollowCursor {
		impl.following.Store(true)
	}
	s.reg.put(spec.ID, &panelEntry{spec: spec, handle: impl})
	s.mu.Unlock()

	go func() {
		// Each webview owns its goroutine. On macOS the first instance must
		// run on the main OS thread; the daemon is responsible for arranging
		// that via runPanelMainLoop. For non-macOS platforms LockOSThread is
		// a cheap no-op that keeps cgo callbacks consistent.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		defer s.reg.delete(spec.ID)
		defer close(impl.done)
		defer func() {
			// idempotent close — guard against double-close panic if
			// SetFollow already closed this channel before us.
			defer func() { _ = recover() }()
			close(impl.followStop)
		}()
		defer func() {
			if impl.hotkeyStop != nil {
				impl.hotkeyStop()
			}
		}()

		log.Printf("[panels] spawn(%s): creating webview", spec.ID)
		debug := false
		wv := webview.New(debug)
		if wv == nil {
			log.Printf("[panels] spawn(%s): webview.New returned nil — WebView2 runtime missing?", spec.ID)
			close(impl.ready)
			return
		}
		defer wv.Destroy()
		impl.wv = wv
		log.Printf("[panels] spawn(%s): webview created", spec.ID)

		if spec.Title != "" {
			wv.SetTitle(spec.Title)
		}
		if spec.Bounds.W > 0 || spec.Bounds.H > 0 {
			w, h := spec.Bounds.W, spec.Bounds.H
			if w <= 0 {
				w = 200
			}
			if h <= 0 {
				h = 60
			}
			var hint webview.Hint = webview.HintNone
			if !spec.Resizable {
				hint = webview.HintFixed
			}
			wv.SetSize(w, h, hint)
			log.Printf("[panels] spawn(%s): size set to %dx%d", spec.ID, w, h)
		}

		handle := wv.Window()
		log.Printf("[panels] spawn(%s): native handle=%v", spec.ID, handle)
		if err := applyPlatformFlags(handle, spec); err != nil {
			log.Printf("[panels] applyPlatformFlags(%s): %v", spec.ID, err)
		}

		if spec.URL != "" {
			wv.Navigate(spec.URL)
			log.Printf("[panels] spawn(%s): navigated to %s", spec.ID, spec.URL)
		}

		// Global summon hotkey: toggles cursor-follow and dispatches a JS
		// callback in the page so the user can summon/dismiss from any app.
		if spec.SummonHotkey != "" {
			panelID := spec.ID
			onFire := func() {
				e, ok := s.reg.get(panelID)
				if !ok {
					return
				}
				p, ok := e.handle.(*panelImpl)
				if !ok || p.wv == nil {
					return
				}
				wasFollowing := p.following.Load()
				p.following.Store(!wasFollowing)
				p.wv.Dispatch(func() {
					if wasFollowing {
						p.wv.Eval("if (window.__pebble_summon) window.__pebble_summon();")
					} else {
						p.wv.Eval("if (window.__pebble_dismiss) window.__pebble_dismiss();")
					}
				})
			}
			stop, err := startHotkeyListener(spec.SummonHotkey, onFire)
			if err != nil {
				log.Printf("[panels] spawn(%s): hotkey '%s' not registered: %v", spec.ID, spec.SummonHotkey, err)
			} else {
				impl.hotkeyStop = stop
				log.Printf("[panels] spawn(%s): summon hotkey '%s' registered", spec.ID, spec.SummonHotkey)
			}
		}

		// Cursor-follow goroutine — runs on a separate, non-locked OS thread.
		// Polls platformGetCursorPos at ~60fps and moves the window to track
		// the cursor with offset. The page can pause tracking via panel.set_follow.
		if spec.FollowCursor {
			ox := spec.CursorOffsetX
			oy := spec.CursorOffsetY
			if ox == 0 && oy == 0 {
				ox, oy = 24, 28
			}
			panelHandle := handle
			panelID := spec.ID
			go func() {
				ticker := time.NewTicker(16 * time.Millisecond)
				defer ticker.Stop()
				for {
					select {
					case <-impl.followStop:
						return
					case <-impl.done:
						return
					case <-ticker.C:
						if !impl.following.Load() {
							continue
						}
						x, y, err := platformGetCursorPos()
						if err != nil {
							log.Printf("[panels] follow(%s): cursor poll: %v", panelID, err)
							continue
						}
						_ = platformMoveWindow(panelHandle, x+ox, y+oy)
					}
				}
			}()
			log.Printf("[panels] spawn(%s): cursor-follow goroutine started (offset %d,%d)", spec.ID, ox, oy)
		}

		close(impl.ready)
		log.Printf("[panels] spawn(%s): entering event loop (Run)", spec.ID)
		wv.Run() // blocks until Terminate() or window closed
		log.Printf("[panels] spawn(%s): event loop exited", spec.ID)
	}()

	// Wait briefly for the window to become ready so the caller knows it
	// either started or failed without holding the RPC connection too long.
	select {
	case <-impl.ready:
	case <-time.After(2 * time.Second):
		// Continue anyway — webview may take longer on slow systems.
	}

	return spec.ID, nil
}

func (s *panelService) Close(id PanelID) error {
	e, ok := s.reg.get(id)
	if !ok {
		return formatPanelError("close", id, ErrPanelUnknown)
	}
	impl, ok := e.handle.(*panelImpl)
	if !ok {
		return formatPanelError("close", id, fmt.Errorf("handle type mismatch"))
	}
	if impl.wv != nil {
		impl.wv.Terminate()
	}
	return nil
}

func (s *panelService) SetFollow(id PanelID, follow bool) error {
	e, ok := s.reg.get(id)
	if !ok {
		return formatPanelError("set_follow", id, ErrPanelUnknown)
	}
	impl, ok := e.handle.(*panelImpl)
	if !ok {
		return formatPanelError("set_follow", id, fmt.Errorf("handle type mismatch"))
	}
	impl.following.Store(follow)
	return nil
}

func (s *panelService) Focus(id PanelID) error {
	e, ok := s.reg.get(id)
	if !ok {
		return formatPanelError("focus", id, ErrPanelUnknown)
	}
	impl, ok := e.handle.(*panelImpl)
	if !ok || impl.wv == nil {
		return formatPanelError("focus", id, fmt.Errorf("window not ready"))
	}
	if err := platformFocusWindow(impl.wv.Window()); err != nil {
		return formatPanelError("focus", id, err)
	}
	return nil
}

func (s *panelService) List() []PanelID {
	return s.reg.ids()
}

func (s *panelService) Stop() {
	for _, id := range s.reg.ids() {
		_ = s.Close(id)
	}
}

