package main

import (
	"errors"
	"testing"
)

// A registry entry can outlive its window: on macOS the window closes (closing
// uiClosed) before the spawn goroutine deletes the entry. Focus/SetWindowState
// landing in that gap must refuse rather than queue AppKit work that re-shows
// the closed window.
func TestFocusAndSetWindowStateRefuseAClosedWindow(t *testing.T) {
	s := &panelService{reg: newPanelRegistry()}
	impl := &panelImpl{uiClosed: make(chan struct{})}
	close(impl.uiClosed)
	s.reg.put("tray:chat", &panelEntry{handle: impl})

	if err := s.Focus("tray:chat"); !errors.Is(err, errPanelWindowClosed) {
		t.Errorf("Focus err = %v, want errPanelWindowClosed", err)
	}
	if err := s.SetWindowState("tray:chat", PanelWindowNormal); !errors.Is(err, errPanelWindowClosed) {
		t.Errorf("SetWindowState err = %v, want errPanelWindowClosed", err)
	}
}

// An open window must not be reported closed; without a webview yet it is
// merely not ready.
func TestFocusOnAnOpenWindowIsNotReportedClosed(t *testing.T) {
	s := &panelService{reg: newPanelRegistry()}
	s.reg.put("tray:chat", &panelEntry{handle: &panelImpl{uiClosed: make(chan struct{})}})

	err := s.Focus("tray:chat")
	if err == nil || errors.Is(err, errPanelWindowClosed) {
		t.Fatalf("Focus err = %v, want a not-ready error, not errPanelWindowClosed", err)
	}
}
