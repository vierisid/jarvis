package main

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"time"

	webview "github.com/webview/webview_go"
)

// panelImpl wraps a single webview window and the channel used to control it.
type panelImpl struct {
	spec PanelSpec
	wv   webview.WebView // assigned by the runner goroutine
	ready chan struct{}  // closed once wv is set + flags applied
	done  chan struct{}  // closed when Run() returns
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
		spec:  spec,
		ready: make(chan struct{}),
		done:  make(chan struct{}),
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

		debug := false
		wv := webview.New(debug)
		if wv == nil {
			log.Printf("[panels] webview.New returned nil for %s", spec.ID)
			close(impl.ready)
			return
		}
		defer wv.Destroy()
		impl.wv = wv

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
		}

		// Apply native flags after the window exists. Window() returns the
		// platform-native handle (HWND / NSWindow* / GtkWindow*) as an
		// unsafe.Pointer; we keep it as-is through the chain so go vet's
		// unsafeptr check doesn't flag a uintptr→Pointer round-trip.
		handle := wv.Window()
		if err := applyPlatformFlags(handle, spec); err != nil {
			log.Printf("[panels] applyPlatformFlags(%s): %v", spec.ID, err)
		}

		if spec.URL != "" {
			wv.Navigate(spec.URL)
		}

		close(impl.ready)
		wv.Run() // blocks until Terminate() or window closed
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

