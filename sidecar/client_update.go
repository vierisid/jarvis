package main

// Client-side wiring of the self-updater (updater.go): progress events to the
// brain, the two brain->sidecar RPCs, and the hooks the platform UI (update
// prompt, tray item) attaches to.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"sync/atomic"
	"time"
)

var (
	// showUpdatePrompt opens (or focuses) the native update prompt. Set by the
	// platform UI on Windows and macOS; nil where there is none (Linux), where
	// the dashboard installs the update directly instead.
	showUpdatePrompt func()
	// updateOfferChanged refreshes the platform UI (tray item, an open
	// prompt) when the offer changes. No-op until a platform sets it.
	updateOfferChanged = func(UpdateOffer) {}
	// activeUpdaterV is the process's updater, for the RPC handlers
	// (NewHandlerRegistry has no client reference) and the tray.
	activeUpdaterV atomic.Pointer[Updater]
)

func activeUpdater() *Updater { return activeUpdaterV.Load() }

// initUpdater builds the updater and connects it to this client.
func (c *SidecarClient) initUpdater() {
	u := newUpdater(sidecarVersion)
	u.handOff = c.handOff
	u.emit = c.emitUpdateProgress
	u.onChange = func(o UpdateOffer) { updateOfferChanged(o) }
	u.onFirstOffer = c.onFirstUpdateOffer
	c.updater = u
	activeUpdaterV.Store(u)
	if updatePromptSupported() {
		showUpdatePrompt = c.openUpdatePrompt
		trayOpenUpdate = c.openUpdatePrompt
		updateOfferChanged = func(o UpdateOffer) {
			setTrayUpdateOffer(o)
			c.pushUpdateWindow()
		}
	}
	log.Printf("[update] install mode: %s %s%s", u.mode.Kind, u.mode.InstallDir, u.mode.Reason)
}

// onFirstUpdateOffer is the once-per-process startup prompt: an update that
// just became known on the first registration, or a hard block. A version the
// user chose to skip stays quiet here (tray and dashboard still offer it).
func (c *SidecarClient) onFirstUpdateOffer(o UpdateOffer) {
	if !o.Blocked && o.Version != "" && o.Version == c.skippedUpdateVersion() {
		log.Printf("[update] sidecar %s is available but was skipped, not prompting", o.Version)
		return
	}
	if showUpdatePrompt == nil {
		if o.Blocked {
			notifyUpdateRequired(o, c.updater.ManualCommand(o.Version))
		}
		return
	}
	showUpdatePrompt()
}

func (c *SidecarClient) skippedUpdateVersion() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.config.Update.SkippedVersion
}

// skipUpdateVersion records "Skip this version".
func (c *SidecarClient) skipUpdateVersion(version string) {
	if err := c.editConfig(func(cfg *SidecarConfig) { cfg.Update.SkippedVersion = version }); err != nil {
		log.Printf("[update] could not save the skipped version: %v", err)
	}
}

// emitUpdateProgress reports an update phase to the brain (best-effort: while
// disconnected there is no one to tell, and the prompt shows it anyway).
func (c *SidecarClient) emitUpdateProgress(s UpdateState) {
	c.mu.Lock()
	ctx := c.obsCtx
	c.mu.Unlock()
	if ctx == nil {
		return
	}
	payload := map[string]any{"phase": s.Phase}
	if s.Version != "" {
		payload["version"] = s.Version
	}
	if s.Error != "" {
		payload["error"] = s.Error
	}
	if s.ManualCommand != "" {
		payload["manual_command"] = s.ManualCommand
	}
	// Bounded: a stalled socket must not hold up the install (this runs
	// between the swap and the hand-off).
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := c.sendEvent(ctx, SidecarEvent{
		Type:      "sidecar_event",
		EventType: "update_progress",
		Timestamp: time.Now().UnixMilli(),
		Priority:  "normal",
		Payload:   payload,
	}, nil); err != nil {
		log.Printf("[update] could not report %s to the brain: %v", s.Phase, err)
	}
}

// handleUpdatePrompt is the `sidecar.update_prompt` RPC: the dashboard's
// update hint opens the same native prompt the sidecar shows at startup.
func handleUpdatePrompt(map[string]any) (*RPCResult, error) {
	if showUpdatePrompt == nil {
		return nil, &codedError{code: "UNSUPPORTED", err: errors.New("this sidecar has no update prompt on this platform")}
	}
	if activeUpdater() == nil {
		return nil, fmt.Errorf("the updater is not running")
	}
	go showUpdatePrompt()
	return &RPCResult{Result: map[string]any{"ok": true}}, nil
}

// handleUpdateApply is the `sidecar.update_apply` RPC: install the update now
// (the dashboard's path on platforms without a native prompt). It returns as
// soon as the install starts; progress follows as update_progress events.
func handleUpdateApply(params map[string]any) (*RPCResult, error) {
	u := activeUpdater()
	if u == nil {
		return nil, fmt.Errorf("the updater is not running")
	}
	version, _ := params["version"].(string)
	if err := u.Start(version); err != nil {
		code := "UPDATE_UNAVAILABLE"
		if errors.Is(err, ErrUpdateBusy) {
			code = "UPDATE_BUSY"
		}
		return nil, &codedError{code: code, err: err}
	}
	return &RPCResult{Result: map[string]any{"started": true}}, nil
}

// notifyUpdateRequired tells the user a blocked sidecar must be updated, on a
// platform without the update prompt (Linux): a desktop notification when
// notify-send is present, else the alert fallback (which logs).
func notifyUpdateRequired(o UpdateOffer, manual string) {
	title := "JARVIS sidecar update required"
	body := fmt.Sprintf("The brain no longer accepts sidecar %s. Update it with: %s", o.Current, manual)
	if path, err := exec.LookPath("notify-send"); err == nil {
		cmd := exec.Command(path, "--app-name=JARVIS", title, body)
		if err := cmd.Start(); err == nil {
			go cmd.Wait()
			return
		}
	}
	platformShowAlert(title, body)
}
