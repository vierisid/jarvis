package main

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	webview "github.com/webview/webview_go"
)

// panelSharedLoop is true on platforms where one process-wide native run loop,
// owned elsewhere (the macOS tray's [NSApp run]), services every panel window.
// There, panels must NOT start their own loop and every window/webview mutation
// must be marshalled onto that loop's thread (the main thread). On Windows/Linux
// each panel goroutine owns its window and runs its own loop, so this is false.
const panelSharedLoop = runtime.GOOS == "darwin"

// uiSync runs fn on the thread that owns the panel windows and blocks until it
// finishes. On shared-loop platforms (macOS) that's the main thread, reached via
// the webview's main-queue dispatch; elsewhere the caller already owns the
// window so fn runs inline.
func uiSync(wv webview.WebView, fn func()) {
	if !panelSharedLoop || wv == nil {
		fn()
		return
	}
	done := make(chan struct{})
	wv.Dispatch(func() {
		defer close(done)
		fn()
	})
	<-done
}

// panelImpl wraps a single webview window and the channel used to control it.
type panelImpl struct {
	spec       PanelSpec
	wvVal      atomic.Value    // webview.WebView; set once by the runner goroutine, read by close-watcher / hotkey / service methods
	ready      chan struct{}   // closed once wv is set + flags applied
	done       chan struct{}   // closed when Run() returns
	following  atomic.Bool     // when true, cursor-tracker actively moves window
	followStop chan struct{}   // closed by Close()/Stop() to halt the tracker
	hotkeyStop func()          // unregister + stop the hotkey listener
	// macOS shared-loop teardown: uiClosed is closed (once) when the window is
	// gone so the spawn goroutine, which does not run its own loop there, can
	// return. Unused on Windows/Linux (those block in wv.Run()).
	uiClosed    chan struct{}
	uiCloseOnce sync.Once
}

// setWV / loadWV guard the webview handle, which is written once by the runner
// goroutine and read concurrently by the close-watcher, the hotkey listener, and
// the service methods (Close/Focus/SetInteractiveRegions/...). loadWV returns
// nil until the runner has assigned it. Callers must snapshot once and reuse the
// local, not call loadWV twice in a nil-check + use.
func (p *panelImpl) setWV(wv webview.WebView) { p.wvVal.Store(wv) }
func (p *panelImpl) loadWV() webview.WebView {
	wv, _ := p.wvVal.Load().(webview.WebView)
	return wv
}

// panelService is the cross-platform PanelService implementation. The actual
// window-flag work (always-on-top, transparent, frameless, click-through) is
// delegated to applyPlatformFlags which is implemented per OS in panels_<os>.go.
type panelService struct {
	mu              sync.Mutex
	reg             *panelRegistry
	boundsChangedCb func(id PanelID, x, y, w, h int)
	closedCb        func(id PanelID)
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
		uiClosed:   make(chan struct{}),
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

		// Windows/Linux own the loop and Destroy the webview after Run()
		// returns. Declared FIRST so defer LIFO runs it LAST: hotkey teardown,
		// follower shutdown, close(impl.done), and registry removal all happen
		// before the engine is freed — with Destroy first (the old order), the
		// still-registered summon hotkey could Dispatch into freed memory, and
		// a Close()/reopen could reach the dead entry. The delayShow reveal
		// timer and the close watcher are joined here too, for the same reason
		// (same fix as webview_reveal.go's stop). On macOS (shared loop) the
		// window closes under the tray's [NSApp run], and webview's own
		// on_window_will_close dispatch still references the engine; destroying
		// it here frees the engine out from under it -> use-after-free crash.
		// Leak the engine on macOS instead (panels open rarely; the timer and
		// watcher are joined either way). TODO: cancellable teardown to
		// reclaim. wv/stopReveal/stopCloseWatch are populated later; they stay
		// nil/no-op on the webview.New failure path.
		var wv webview.WebView
		stopReveal := func() {}
		stopCloseWatch := func() {}
		defer func() {
			stopCloseWatch()
			stopReveal()
			if wv != nil && !panelSharedLoop {
				wv.Destroy()
			}
		}()

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
		wv = webview.New(debug)
		if wv == nil {
			log.Printf("[panels] spawn(%s): webview.New returned nil — WebView2 runtime missing?", spec.ID)
			close(impl.ready)
			return
		}
		impl.setWV(wv)
		log.Printf("[panels] spawn(%s): webview created", spec.ID)

		// Hide normal panels while the page loads, then reveal them once the
		// page fires `load` (the page keeps loading + rendering while hidden,
		// so it appears fully-formed instead of showing the empty webview that
		// fills + resizes as it loads). Fullscreen / cursor-follow panels (the
		// transparent overlays) must be visible from the start, so they opt out.
		// All window/webview setup below touches AppKit/WebKit objects, which on
		// the shared-loop platform (macOS) must run on the main thread. uiSync
		// marshals the whole sequence there and blocks until done; on
		// Windows/Linux it runs inline on this goroutine. earlyHandle/handle/
		// delayShow are hoisted because later goroutines (follow, bounds, close
		// watcher) read them.
		var earlyHandle, handle unsafe.Pointer
		var delayShow bool
		uiSync(wv, func() {
			earlyHandle = wv.Window()
			delayShow = !spec.Fullscreen && !spec.FollowCursor && earlyHandle != nil
			if delayShow {
				_ = platformSetWindowVisible(earlyHandle, false)
			}

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

			handle = wv.Window()
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
			} else if spec.Bounds.X >= 0 && spec.Bounds.Y >= 0 {
				// W3-T3 — daemon passed an explicit top-left (restored from
				// ~/.jarvis/window-state.json, or palette positioning). The
				// sentinel for "let the sidecar pick" is x<0/y<0; treat
				// 0,0 and positive coords as authoritative and move there.
				// Use the keep-z-order variant so a non-always-on-top panel
				// doesn't get promoted to topmost just because we repositioned
				// it (platformMoveWindow does that for the cursor-follow path).
				if err := platformMoveWindowKeepZOrder(handle, spec.Bounds.X, spec.Bounds.Y); err != nil {
					log.Printf("[panels] spawn(%s): move to saved (%d,%d): %v", spec.ID, spec.Bounds.X, spec.Bounds.Y, err)
				} else {
					log.Printf("[panels] spawn(%s): positioned at saved (%d,%d)", spec.ID, spec.Bounds.X, spec.Bounds.Y)
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

			// Reveal the (hidden) panel once its page has loaded, with a timeout
			// fallback so it never stays stuck hidden. Set up BEFORE Navigate so the
			// init script + binding apply to the loaded page.
			if !delayShow {
				// Overlay panels (fullscreen / cursor-follow) must be visible
				// immediately. The vendored webview creates the window hidden on
				// Windows, so show it now.
				_ = platformSetWindowVisible(earlyHandle, true)
			}
			if delayShow {
				// Re-assert hidden: applyPlatformFlags above may have re-shown the
				// window (its SetWindowPos uses SWP_SHOWWINDOW for always-on-top).
				_ = platformSetWindowVisible(earlyHandle, false)
				var panelShown atomic.Bool
				var revealStopped atomic.Bool
				showPanel := func() {
					if revealStopped.Load() {
						return // teardown won the race; the handle may be dead
					}
					select {
					case <-impl.uiClosed:
						// macOS: the window already closed under the shared
						// loop. uiClosed is closed inside the will-close
						// notification ON THE MAIN THREAD, so a reveal closure
						// queued behind it reliably sees this and bails —
						// otherwise it would re-show and focus the closed
						// (frameless, registry-deleted) panel as an
						// unreachable zombie. revealStopped can't cover this:
						// the spawn goroutine sets it only after it wakes.
						return
					default:
					}
					if panelShown.CompareAndSwap(false, true) {
						_ = platformSetWindowVisible(earlyHandle, true)
						_ = platformFocusWindow(earlyHandle)
					}
				}
				// Injected at document start on each navigation: call the binding a
				// beat after `load` so the first paint is done before we reveal.
				wv.Init(`(function(){try{var r=function(){if(window.__sidecar_panel_ready)window.__sidecar_panel_ready();};` +
					`if(document.readyState==='complete'){setTimeout(r,120);}` +
					`else{window.addEventListener('load',function(){setTimeout(r,120);});}}catch(e){}})();`)
				_ = wv.Bind("__sidecar_panel_ready", func() { showPanel() })
				// Timeout fallback, cancellable: stopReveal (joined by the defer
				// above before Destroy) keeps the Dispatch CALL off a freed
				// engine, and revealStopped keeps an already-queued closure off
				// a dead window handle (GTK idle sources survive gtk_main_quit).
				revealDone := make(chan struct{})
				revealFinished := make(chan struct{})
				go func() {
					defer close(revealFinished)
					select {
					case <-time.After(6 * time.Second):
						wv.Dispatch(func() { showPanel() })
					case <-revealDone:
					}
				}()
				var stopOnce sync.Once
				stopReveal = func() {
					stopOnce.Do(func() {
						revealStopped.Store(true)
						close(revealDone)
					})
					<-revealFinished
				}
			}

			if spec.URL != "" {
				wv.Navigate(spec.URL)
				log.Printf("[panels] spawn(%s): navigated to %s", spec.ID, redactPanelURL(spec.URL))
			}
		})

		// macOS: panels don't run their own loop, so we can't rely on wv.Run()
		// returning when the window closes. Observe the window's close to signal
		// teardown (clears the registry so a reopen makes a fresh window instead
		// of focusing the destroyed one). No-op on Windows/Linux.
		registerPanelCloseWatch(handle, impl)

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
				if !ok {
					return
				}
				wv := p.loadWV()
				if wv == nil {
					return
				}
				wasFollowing := p.following.Load()
				p.following.Store(!wasFollowing)
				wv.Dispatch(func() {
					if wasFollowing {
						wv.Eval("if (window.__pebble_summon) window.__pebble_summon();")
					} else {
						wv.Eval("if (window.__pebble_dismiss) window.__pebble_dismiss();")
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

		// W3-T1 — bounds poll. Fires the service-wide OnBoundsChanged
		// callback when the user drags or resizes the window. Skipped
		// for fullscreen panels (always virtual-screen-sized) and for
		// cursor-following panels (their position is sidecar-driven, not
		// user-driven). Polls at 1 Hz — fast enough to feel responsive
		// for save-on-close, slow enough that drag-in-progress doesn't
		// thrash. Stops when the panel goroutine exits.
		if !spec.Fullscreen && !spec.FollowCursor {
			panelID := spec.ID
			panelHandle := handle
			go func() {
				ticker := time.NewTicker(1 * time.Second)
				defer ticker.Stop()
				var lastX, lastY, lastW, lastH int
				initialized := false
				for {
					select {
					case <-impl.done:
						return
					case <-impl.followStop:
						return
					case <-ticker.C:
						x, y, w, h, err := platformGetWindowRect(panelHandle)
						if err != nil {
							// Unimplemented (mac/linux) or transient — skip.
							return
						}
						if w <= 0 || h <= 0 {
							continue // minimised or hidden
						}
						if !initialized {
							lastX, lastY, lastW, lastH = x, y, w, h
							initialized = true
							continue
						}
						if x == lastX && y == lastY && w == lastW && h == lastH {
							continue
						}
						lastX, lastY, lastW, lastH = x, y, w, h
						s.mu.Lock()
						cb := s.boundsChangedCb
						s.mu.Unlock()
						if cb != nil {
							cb(panelID, x, y, w, h)
						}
					}
				}
			}()
		}

		// Close watcher (Windows). webview_go only terminates a run loop when the
		// LAST webview window in the process closes (process-wide window count),
		// so closing one panel while another webview window is open leaves this
		// run loop stuck — its deferred reg.delete never fires and the (fixed-id)
		// panel can't be reopened. Watch the HWND; when it's destroyed, force the
		// loop to return so cleanup runs. No-op on platforms where
		// platformWindowAlive can't probe the handle.
		//
		// Joined (stopCloseWatch, in the Destroy defer) before the engine is
		// freed: teardown closes impl.done only AFTER Destroy (defer LIFO), so
		// the done check alone leaves a gap where a tick could see the window
		// dead, pass the check, and Dispatch into freed memory.
		watchStop := make(chan struct{})
		watchFinished := make(chan struct{})
		go func() {
			defer close(watchFinished)
			t := time.NewTicker(250 * time.Millisecond)
			defer t.Stop()
			for {
				select {
				case <-watchStop:
					return // teardown is joining us
				case <-impl.done:
					return
				case <-t.C:
					if platformWindowAlive(handle) {
						continue
					}
					select {
					case <-watchStop:
						return // teardown is joining us
					case <-impl.done:
						return // already tearing down (webview terminated it)
					default:
						if panelSharedLoop {
							// macOS: the window is gone, but the shared [NSApp run]
							// loop must keep running for the tray + other panels.
							// Signal the spawn goroutine instead of terminating.
							impl.uiCloseOnce.Do(func() { close(impl.uiClosed) })
						} else if wv := impl.loadWV(); wv != nil {
							wv.Dispatch(func() {
								wv.Terminate()
							})
						}
						return
					}
				}
			}
		}()
		var watchOnce sync.Once
		stopCloseWatch = func() {
			watchOnce.Do(func() { close(watchStop) })
			<-watchFinished
		}

		close(impl.ready)
		if panelSharedLoop {
			// macOS: the tray owns the single process-wide [NSApp run] loop and
			// services this window. Starting our own loop here would nest
			// [NSApp run] on a background goroutine (illegal). Just block until
			// the window closes — the close watcher / Close() signals uiClosed.
			log.Printf("[panels] spawn(%s): attached to shared run loop", spec.ID)
			<-impl.uiClosed
			log.Printf("[panels] spawn(%s): window closed", spec.ID)
		} else {
			log.Printf("[panels] spawn(%s): entering event loop (Run)", spec.ID)
			wv.Run() // blocks until Terminate() or window closed
			log.Printf("[panels] spawn(%s): event loop exited", spec.ID)
		}
		s.mu.Lock()
		closedCb := s.closedCb
		s.mu.Unlock()
		if closedCb != nil {
			closedCb(spec.ID)
		}
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
	if wv := impl.loadWV(); wv != nil {
		if panelSharedLoop {
			// macOS: close the window on the main thread (it owns the NSWindow)
			// and signal the spawn goroutine. Never Terminate() here — that stops
			// the tray's shared [NSApp run] loop, killing the menu bar + every
			// other panel. The close watcher's deferred cleanup runs once the
			// spawn goroutine returns from <-uiClosed.
			uiSync(wv, func() {
				if err := platformDestroyWindow(wv.Window()); err != nil {
					log.Printf("[panels] platformDestroyWindow(%s): %v", id, err)
				}
			})
			impl.uiCloseOnce.Do(func() { close(impl.uiClosed) })
			return nil
		}
		// On Windows, wv.Terminate() asks the webview's message loop to
		// return but doesn't actually destroy the OS HWND, so the user
		// still sees the window after Close() reports success. Force the
		// OS-level close by posting WM_CLOSE (Win32) / [w close] (Cocoa)
		// / gtk_widget_destroy (Linux) to the underlying handle, then
		// fall through to wv.Terminate so the webview's deferred cleanup
		// (`reg.delete`, `wv.Destroy`) still runs.
		if err := platformDestroyWindow(wv.Window()); err != nil {
			log.Printf("[panels] platformDestroyWindow(%s): %v (falling back to wv.Terminate)", id, err)
		}
		wv.Terminate()
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
	if !ok {
		return formatPanelError("set_regions", id, fmt.Errorf("window not ready"))
	}
	wv := impl.loadWV()
	if wv == nil {
		return formatPanelError("set_regions", id, fmt.Errorf("window not ready"))
	}
	if err := platformSetInteractiveRegions(wv.Window(), rects); err != nil {
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
	if !ok {
		return formatPanelError("set_clickthrough", id, fmt.Errorf("window not ready"))
	}
	wv := impl.loadWV()
	if wv == nil {
		return formatPanelError("set_clickthrough", id, fmt.Errorf("window not ready"))
	}
	if err := platformSetClickThrough(wv.Window(), clickThrough); err != nil {
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
	if !ok {
		return formatPanelError("focus", id, fmt.Errorf("window not ready"))
	}
	wv := impl.loadWV()
	if wv == nil {
		return formatPanelError("focus", id, fmt.Errorf("window not ready"))
	}
	if err := platformFocusWindow(wv.Window()); err != nil {
		return formatPanelError("focus", id, err)
	}
	return nil
}

func (s *panelService) List() []PanelID {
	return s.reg.ids()
}

func (s *panelService) SetWindowState(id PanelID, state PanelWindowState) error {
	e, ok := s.reg.get(id)
	if !ok {
		return formatPanelError("set_window_state", id, ErrPanelUnknown)
	}
	impl, ok := e.handle.(*panelImpl)
	if !ok {
		return formatPanelError("set_window_state", id, fmt.Errorf("window not ready"))
	}
	wv := impl.loadWV()
	if wv == nil {
		return formatPanelError("set_window_state", id, fmt.Errorf("window not ready"))
	}
	if err := platformSetWindowState(wv.Window(), state); err != nil {
		return formatPanelError("set_window_state", id, err)
	}
	return nil
}

func (s *panelService) Stop() {
	for _, id := range s.reg.ids() {
		_ = s.Close(id)
	}
}

func (s *panelService) OnBoundsChanged(cb func(id PanelID, x, y, w, h int)) {
	s.mu.Lock()
	s.boundsChangedCb = cb
	s.mu.Unlock()
}

func (s *panelService) OnClosed(cb func(id PanelID)) {
	s.mu.Lock()
	s.closedCb = cb
	s.mu.Unlock()
}
