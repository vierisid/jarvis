package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

// stubPanelToken returns a panelToken provider that always yields tok, for
// driving makePanelSpawnHandler in tests without a live brain mint endpoint.
func stubPanelToken(tok string) func(context.Context) (string, error) {
	return func(context.Context) (string, error) { return tok, nil }
}

// fakePanelService is a stand-in for the real webview-backed service.
// It records calls, lets tests pre-seed an error, and never opens real
// windows so the test suite has no GUI dependency.
type fakePanelService struct {
	mu                sync.Mutex
	spawned           map[PanelID]PanelSpec
	closed            []PanelID
	focused           []PanelID
	followCalls       map[PanelID]bool
	regionCalls       map[PanelID][]PanelRect
	clickThroughCalls map[PanelID]bool
	spawnErr          error
	closeErr          error
	focusErr          error
	nextID            int
}

func newFakePanelService() *fakePanelService {
	return &fakePanelService{spawned: make(map[PanelID]PanelSpec)}
}

func (f *fakePanelService) Spawn(spec PanelSpec) (PanelID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.spawnErr != nil {
		return "", f.spawnErr
	}
	if spec.ID == "" {
		f.nextID++
		spec.ID = PanelID("test-" + itoa(f.nextID))
	}
	f.spawned[spec.ID] = spec
	return spec.ID, nil
}

func (f *fakePanelService) Close(id PanelID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closeErr != nil {
		return f.closeErr
	}
	if _, ok := f.spawned[id]; !ok {
		return ErrPanelUnknown
	}
	delete(f.spawned, id)
	f.closed = append(f.closed, id)
	return nil
}

func (f *fakePanelService) Focus(id PanelID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.focusErr != nil {
		return f.focusErr
	}
	if _, ok := f.spawned[id]; !ok {
		return ErrPanelUnknown
	}
	f.focused = append(f.focused, id)
	return nil
}

func (f *fakePanelService) SetFollow(id PanelID, follow bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.spawned[id]; !ok {
		return ErrPanelUnknown
	}
	if f.followCalls == nil {
		f.followCalls = make(map[PanelID]bool)
	}
	f.followCalls[id] = follow
	return nil
}

func (f *fakePanelService) SetInteractiveRegions(id PanelID, rects []PanelRect) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.spawned[id]; !ok {
		return ErrPanelUnknown
	}
	if f.regionCalls == nil {
		f.regionCalls = make(map[PanelID][]PanelRect)
	}
	f.regionCalls[id] = rects
	return nil
}

func (f *fakePanelService) SetClickThrough(id PanelID, ct bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.spawned[id]; !ok {
		return ErrPanelUnknown
	}
	if f.clickThroughCalls == nil {
		f.clickThroughCalls = make(map[PanelID]bool)
	}
	f.clickThroughCalls[id] = ct
	return nil
}

func (f *fakePanelService) List() []PanelID {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]PanelID, 0, len(f.spawned))
	for id := range f.spawned {
		out = append(out, id)
	}
	return out
}

func (f *fakePanelService) Stop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.spawned = map[PanelID]PanelSpec{}
}

func (f *fakePanelService) SetWindowState(id PanelID, _ PanelWindowState) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.spawned[id]; !ok {
		return ErrPanelUnknown
	}
	return nil
}

func (f *fakePanelService) OnBoundsChanged(cb func(id PanelID, x, y, w, h int)) {
	// no-op — the fake never spawns a real window, so it never has
	// bounds to report. The handler tests don't exercise this path.
	_ = cb
}

func (f *fakePanelService) OnClosed(cb func(id PanelID)) {
	// no-op — the fake never spawns a real window, so it never closes one.
	_ = cb
}

// tiny itoa to avoid pulling strconv in this test file
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

// ---------- panel.spawn ----------

func TestPanelSpawnHandler_HappyPath(t *testing.T) {
	svc := newFakePanelService()
	h := makePanelSpawnHandler(svc, "ws://localhost:3142/sidecar/connect", stubPanelToken("tok-123"))

	res, err := h(map[string]any{
		"id":            "pebble",
		"url":           "http://localhost:3142/pebble.html",
		"title":         "JARVIS",
		"frameless":     true,
		"transparent":   true,
		"always_on_top": true,
		"click_through": true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got, _ := res.Result.(map[string]any)["id"].(string); got != "pebble" {
		t.Errorf("expected id=pebble, got %q", got)
	}
	spec, ok := svc.spawned["pebble"]
	if !ok {
		t.Fatalf("spec not recorded in fake service")
	}
	if !spec.Frameless || !spec.Transparent || !spec.AlwaysOnTop || !spec.ClickThrough {
		t.Errorf("flags lost in decode: %+v", spec)
	}
}

func TestPanelSpawnHandler_MissingURL(t *testing.T) {
	svc := newFakePanelService()
	h := makePanelSpawnHandler(svc, "ws://localhost:3142/sidecar/connect", stubPanelToken("tok-123"))

	_, err := h(map[string]any{"id": "x"})
	if err == nil {
		t.Fatal("expected error for missing url, got nil")
	}
}

func TestPanelSpawnHandler_MissingParams(t *testing.T) {
	svc := newFakePanelService()
	h := makePanelSpawnHandler(svc, "ws://localhost:3142/sidecar/connect", stubPanelToken("tok-123"))

	_, err := h(nil)
	if err == nil {
		t.Fatal("expected error for nil params, got nil")
	}
}

func TestPanelSpawnHandler_ServiceError(t *testing.T) {
	svc := newFakePanelService()
	svc.spawnErr = errors.New("boom")
	h := makePanelSpawnHandler(svc, "ws://x/sidecar/connect", stubPanelToken("tok-123"))

	_, err := h(map[string]any{"url": "http://x"})
	if err == nil || err.Error() != "boom" {
		t.Fatalf("expected service error, got %v", err)
	}
}

func TestPanelSpawnHandler_RejectsForeignOrigin(t *testing.T) {
	svc := newFakePanelService()
	h := makePanelSpawnHandler(svc, "wss://brain.example.com/sidecar/connect", stubPanelToken("tok-123"))

	_, err := h(map[string]any{"id": "x", "url": "https://evil.com/phish"})
	if err == nil {
		t.Fatal("expected rejection of non-brain origin, got nil")
	}
	if len(svc.spawned) != 0 {
		t.Errorf("foreign-origin panel must not spawn, got %v", svc.spawned)
	}
}

func TestPanelSpawnHandler_InjectsTokenAndKeepsFragment(t *testing.T) {
	svc := newFakePanelService()
	h := makePanelSpawnHandler(svc, "ws://localhost:3142/sidecar/connect", stubPanelToken("tok-123"))

	if _, err := h(map[string]any{"id": "ans", "url": "http://localhost:3142/#/_answer_42"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	spec := svc.spawned["ans"]
	if !strings.Contains(spec.URL, "token=tok-123") {
		t.Errorf("expected sidecar token injected, got %q", spec.URL)
	}
	if !strings.Contains(spec.URL, "#/_answer_42") {
		t.Errorf("expected hash route preserved, got %q", spec.URL)
	}
}

// ---------- panel.close ----------

func TestPanelCloseHandler_HappyPath(t *testing.T) {
	svc := newFakePanelService()
	svc.spawned["abc"] = PanelSpec{ID: "abc", URL: "http://x"}

	h := makePanelCloseHandler(svc)
	res, err := h(map[string]any{"id": "abc"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := res.Result.(map[string]any)["closed"]; got != "abc" {
		t.Errorf("expected closed=abc, got %v", got)
	}
	if len(svc.closed) != 1 {
		t.Errorf("close not recorded: %v", svc.closed)
	}
}

func TestPanelCloseHandler_UnknownID(t *testing.T) {
	svc := newFakePanelService()
	h := makePanelCloseHandler(svc)
	_, err := h(map[string]any{"id": "ghost"})
	if err == nil {
		t.Fatal("expected error for unknown id")
	}
}

func TestPanelCloseHandler_MissingID(t *testing.T) {
	svc := newFakePanelService()
	h := makePanelCloseHandler(svc)
	_, err := h(map[string]any{})
	if err == nil {
		t.Fatal("expected error for missing id")
	}
}

// ---------- panel.focus ----------

func TestPanelFocusHandler_HappyPath(t *testing.T) {
	svc := newFakePanelService()
	svc.spawned["a"] = PanelSpec{ID: "a", URL: "http://x"}

	h := makePanelFocusHandler(svc)
	res, err := h(map[string]any{"id": "a"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := res.Result.(map[string]any)["focused"]; got != "a" {
		t.Errorf("expected focused=a, got %v", got)
	}
	if len(svc.focused) != 1 {
		t.Errorf("focus not recorded: %v", svc.focused)
	}
}

// ---------- panel.set_follow ----------

func TestPanelSetFollowHandler_HappyPath(t *testing.T) {
	svc := newFakePanelService()
	svc.spawned["pebble"] = PanelSpec{ID: "pebble", URL: "http://x"}

	h := makePanelSetFollowHandler(svc)
	res, err := h(map[string]any{"id": "pebble", "follow": false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := res.Result.(map[string]any)["id"]; got != "pebble" {
		t.Errorf("expected id=pebble, got %v", got)
	}
	if v, ok := svc.followCalls["pebble"]; !ok || v != false {
		t.Errorf("set_follow not recorded as false: %v", svc.followCalls)
	}
}

func TestPanelSetFollowHandler_MissingFollow(t *testing.T) {
	svc := newFakePanelService()
	svc.spawned["pebble"] = PanelSpec{ID: "pebble", URL: "http://x"}
	h := makePanelSetFollowHandler(svc)
	_, err := h(map[string]any{"id": "pebble"})
	if err == nil {
		t.Fatal("expected error for missing follow param")
	}
}

func TestPanelSetFollowHandler_NonBoolFollow(t *testing.T) {
	svc := newFakePanelService()
	svc.spawned["pebble"] = PanelSpec{ID: "pebble", URL: "http://x"}
	h := makePanelSetFollowHandler(svc)
	_, err := h(map[string]any{"id": "pebble", "follow": "yes"})
	if err == nil {
		t.Fatal("expected error for non-boolean follow")
	}
}

// ---------- panel.list ----------

func TestPanelListHandler_Empty(t *testing.T) {
	svc := newFakePanelService()
	h := makePanelListHandler(svc)
	res, err := h(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ids := res.Result.(map[string]any)["ids"].([]string)
	if len(ids) != 0 {
		t.Errorf("expected empty, got %v", ids)
	}
}

func TestPanelListHandler_WithPanels(t *testing.T) {
	svc := newFakePanelService()
	svc.spawned["a"] = PanelSpec{ID: "a", URL: "http://x"}
	svc.spawned["b"] = PanelSpec{ID: "b", URL: "http://x"}

	h := makePanelListHandler(svc)
	res, err := h(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ids := res.Result.(map[string]any)["ids"].([]string)
	if len(ids) != 2 {
		t.Errorf("expected 2 ids, got %d: %v", len(ids), ids)
	}
}
