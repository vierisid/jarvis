package main

import (
	"errors"
	"fmt"
	"sync"

	"github.com/google/uuid"
)

// PanelID uniquely identifies a spawned native panel window.
type PanelID string

// PanelBounds describes window geometry. Use -1 for X or Y to mean
// "spawn near the user's cursor"; use 0 for W or H to mean "use default".
type PanelBounds struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// PanelSpec is the full specification for a panel window. It is sent from
// the daemon to the sidecar via the panel.spawn RPC.
type PanelSpec struct {
	ID            PanelID     `json:"id"`
	URL           string      `json:"url"`
	Title         string      `json:"title"`
	Bounds        PanelBounds `json:"bounds"`
	Frameless     bool        `json:"frameless"`
	AlwaysOnTop   bool        `json:"always_on_top"`
	ClickThrough  bool        `json:"click_through"`
	Transparent   bool        `json:"transparent"`
	Resizable     bool        `json:"resizable"`
	MultiInstance bool        `json:"multi_instance"`
}

// PanelService manages the lifecycle of native panel windows.
//
// Implementations are platform-specific (panels_windows.go, panels_darwin.go,
// panels_linux.go) and share the in-memory registry maintained here.
type PanelService interface {
	Spawn(spec PanelSpec) (PanelID, error)
	Close(id PanelID) error
	Focus(id PanelID) error
	List() []PanelID
	Stop()
}

// panelRegistry is the cross-platform bookkeeping layer. Platform impls embed
// this and add a platform-specific window handle per entry.
type panelRegistry struct {
	mu      sync.Mutex
	entries map[PanelID]*panelEntry
}

type panelEntry struct {
	spec PanelSpec
	// platform-specific handle is attached by the platform impl
	handle any
}

func newPanelRegistry() *panelRegistry {
	return &panelRegistry{entries: make(map[PanelID]*panelEntry)}
}

func (r *panelRegistry) put(id PanelID, e *panelEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[id] = e
}

func (r *panelRegistry) get(id PanelID) (*panelEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[id]
	return e, ok
}

func (r *panelRegistry) delete(id PanelID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, id)
}

func (r *panelRegistry) ids() []PanelID {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]PanelID, 0, len(r.entries))
	for id := range r.entries {
		out = append(out, id)
	}
	return out
}

// validateSpec rejects specs that would obviously fail at the platform layer.
func validateSpec(spec PanelSpec) error {
	if spec.URL == "" {
		return errors.New("panel spec missing required field: url")
	}
	return nil
}

// resolveSpec assigns an ID if the spec has none.
func resolveSpec(spec PanelSpec) PanelSpec {
	if spec.ID == "" {
		spec.ID = PanelID(uuid.NewString())
	}
	return spec
}

// ErrPanelUnknown is returned by Close/Focus when the id is not registered.
var ErrPanelUnknown = errors.New("panel not found")

// ErrPanelExists is returned by Spawn when a non-multi-instance panel with
// the same id is already open. Callers should Focus(id) instead.
var ErrPanelExists = errors.New("panel already exists")

// formatPanelError adds context to platform errors for clearer RPC responses.
func formatPanelError(op string, id PanelID, err error) error {
	if id == "" {
		return fmt.Errorf("panel.%s: %w", op, err)
	}
	return fmt.Errorf("panel.%s[%s]: %w", op, id, err)
}
