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
		// Fullscreen mode (W2-T7) overrides bounds with the virtual screen
		// dimensions and positions the window at the virtual screen's origin
		// — secondary monitors extending left/up of primary have negative
		// origin coords. Page renders pebble at OS cursor pos via CSS.
		w, h := spec.Bounds.W, spec.Bounds.H
		if spec.Fullscreen {
			w, h = platformGetScreenSize()
		}
		if w > 0 || h > 0 {
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
			log.Printf("[panels] spawn(%s): size set to %dx%d (fullscreen=%v)", spec.ID, w, h, spec.Fullscreen)
		}

		handle := wv.Window()
		log.Printf("[panels] spawn(%s): native handle=%v", spec.ID, handle)
		if err := applyPlatformFlags(handle, spec); err != nil {
			log.Printf("[panels] applyPlatformFlags(%s): %v", spec.ID, err)
		}

		// Reposition fullscreen window to the virtual-screen origin so it
		// truly covers every connected monitor (secondaries can extend
		// left/up of primary, giving negative origin coords).
		if spec.Fullscreen {
			origX, origY := platformGetVirtualScreenOrigin()
			if err := platformMoveWindow(handle, origX, origY); err != nil {
				log.Printf("[panels] spawn(%s): move to (%d,%d): %v", spec.ID, origX, origY, err)
			} else {
				log.Printf("[panels] spawn(%s): positioned at virtual-screen origin (%d,%d)", spec.ID, origX, origY)
			}
		}

		// JS-callable bindings: page calls these directly via webview, no
		// daemon round-trip. Must be bound before Run.
		panelID := spec.ID
		if err := wv.Bind("__sidecar_set_regions", func(rects []PanelRect) error {
			return s.SetInteractiveRegions(panelID, rects)
		}); err != nil {
			log.Printf("[panels] spawn(%s): Bind(__sidecar_set_regions) failed: %v", spec.ID, err)
		}
		if err := wv.Bind("__sidecar_set_clickthrough", func(ct bool) error {
			return s.SetClickThrough(panelID, ct)
		}); err != nil {
			log.Printf("[panels] spawn(%s): Bind(__sidecar_set_clickthrough) failed: %v", spec.ID, err)
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

		// Cursor-follow goroutine.
		//
		// Two modes:
		//
		//   Fullscreen=true (Clicky pattern): the window is screen-sized and
		//   never moves. The page POLLS the cursor via __sidecar_get_cursor
		//   binding (registered above). This goroutine instead reasserts
		//   HWND_TOPMOST every second so the window stays above other apps
		//   that try to take topmost.
		//
		//   Fullscreen=false (legacy small-window pattern): goroutine eases
		//   window position toward (cursor + offset).
		if spec.FollowCursor {
			ox := spec.CursorOffsetX
			oy := spec.CursorOffsetY
			if ox == 0 && oy == 0 {
				ox, oy = 24, 28
			}
			panelHandle := handle
			panelID := spec.ID
			fullscreen := spec.Fullscreen
			go func() {
				const followFactor = 0.18
				ticker := time.NewTicker(16 * time.Millisecond)
				topmostTicker := time.NewTicker(1 * time.Second)
				defer ticker.Stop()
				defer topmostTicker.Stop()

				cx, cy, _ := platformGetCursorPos()
				curX := float64(cx + ox)
				curY := float64(cy + oy)

				for {
					select {
					case <-impl.followStop:
						return
					case <-impl.done:
						return
					case <-topmostTicker.C:
						// Reassert always-on-top in fullscreen mode so other
						// apps activating don't bury us. In non-fullscreen
						// mode platformMoveWindow already does this per frame.
						if fullscreen {
							_ = platformReassertTopmost(panelHandle)
						}
					case <-ticker.C:
						if fullscreen {
							// Page polls cursor via Bind, nothing to do here
							// at 60fps. Just stay alive for the topmost
							// ticker and stop signals.
							continue
						}
						if !impl.following.Load() {
							continue
						}
						x, y, err := platformGetCursorPos()
						if err != nil {
							log.Printf("[panels] follow(%s): cursor poll: %v", panelID, err)
							continue
						}
						targetX := float64(x + ox)
						targetY := float64(y + oy)
						curX += (targetX - curX) * followFactor
						curY += (targetY - curY) * followFactor
						_ = platformMoveWindow(panelHandle, int(curX), int(curY))
					}
				}
			}()
			mode := "window-move"
			if fullscreen {
				mode = "page-poll"
			}
			log.Printf("[panels] spawn(%s): cursor-follow started (mode=%s, offset %d,%d)", spec.ID, mode, ox, oy)
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

func (s *panelService) SetInteractiveRegions(id PanelID, rects []PanelRect) error {
	e, ok := s.reg.get(id)
	if !ok {
		return formatPanelError("set_regions", id, ErrPanelUnknown)
	}
	impl, ok := e.handle.(*panelImpl)
	if !ok || impl.wv == nil {
		return formatPanelError("set_regions", id, fmt.Errorf("window not ready"))
	}
	if err := platformSetInteractiveRegions(impl.wv.Window(), rects); err != nil {
		return formatPanelError("set_regions", id, err)
	}
	return nil
}

func (s *panelService) SetClickThrough(id PanelID, clickThrough bool) error {
	e, ok := s.reg.get(id)
	if !ok {
		return formatPanelError("set_clickthrough", id, ErrPanelUnknown)
	}
	impl, ok := e.handle.(*panelImpl)
	if !ok || impl.wv == nil {
		return formatPanelError("set_clickthrough", id, fmt.Errorf("window not ready"))
	}
	if err := platformSetClickThrough(impl.wv.Window(), clickThrough); err != nil {
		return formatPanelError("set_clickthrough", id, err)
	}
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

