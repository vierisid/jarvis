package main

// OS permission status over RPC, so the dashboard's onboarding wizard can show
// the REAL state of this machine instead of four buttons that do nothing.
//
// The wizard screen it feeds used to be static: every row called
// window.open("x-apple.systempreferences:...") and every one of those was
// dropped on the floor, because a panel routes window.open to the host and the
// host allowlists http(s) only (isExternallyOpenable, panels_extnav.go). The
// page could not read a status either, so a granted permission and a denied one
// looked identical. Opening the pane from HERE works for the same reason the
// native --setup wizard's buttons work: it is an `open` from the sidecar
// process, not a URL from a web page.
//
// The checks and requests themselves are NOT new - this is the same
// setup_permissions_{darwin,other}.go that the native `--setup` wizard drives,
// exposed a second way. One source of truth, so the two screens can never
// disagree about what is granted.

import (
	"fmt"
	"os/exec"
	"sync"
	"time"
)

// How a permission is obtained, which is the difference the UI has to render:
// a "prompt" row can be granted without leaving the app, a "pane" row can only
// be granted by the user flipping a toggle in System Settings.
const (
	grantPrompt = "prompt" // the OS shows a dialog; requesting is enough
	grantPane   = "pane"   // no dialog exists; the user must visit the pane
	grantNone   = "none"   // nothing to do on this platform
)

// permissionRow is one row of the report. Deliberately just facts: which
// permission, where it stands, and how it can be obtained. What it is CALLED,
// whether it is required, and how it is explained are the dashboard's business.
type permissionRow struct {
	Name   string `json:"name"`
	Status string `json:"status"` // granted | denied | undetermined | na
	Grant  string `json:"grant"`  // prompt | pane | none
}

// permissionsReport is the payload of system.permissions.
type permissionsReport struct {
	Platform string `json:"platform"`
	// Bundled is false when macOS TCC has no app identity to attach a grant to
	// (a bare binary rather than Jarvis.app). Grants then bind to whatever
	// launched us - the terminal - so the rows describe someone else's
	// permissions and the dashboard must say so rather than show them.
	// Always true off macOS, where there is no bundle to be missing.
	Bundled     bool            `json:"bundled"`
	Permissions []permissionRow `json:"permissions"`
}

// permissionNames is the full row set, in the order the report lists them.
// Every platform answers for all four; the ones that mean nothing there come
// back "na" and the dashboard drops them.
var permissionNames = []string{"notifications", "microphone", "screen", "accessibility"}

var permissionNameSet = func() map[string]struct{} {
	m := make(map[string]struct{}, len(permissionNames))
	for _, n := range permissionNames {
		m[n] = struct{}{}
	}
	return m
}()

// readPermissionStatuses is the status reader, indirected so tests can stand in
// a fake for it. The real one is a C call into TCC and answers only on a Mac,
// which would otherwise leave the coalescing and freshness rules below
// untestable on any dev box.
var readPermissionStatuses = setupPermissionStatuses

// Sampling the four statuses is not free - the macOS notification-settings read
// waits on a callback (up to 2s) - and the dashboard polls this while the
// screen is open. Handlers run concurrently (one goroutine per RPC in
// client.go), so without this a slow read under a 1.5s poll would pile up
// overlapping samples of the same thing. Holding the lock ACROSS the read is
// the point: concurrent pollers queue behind one in-flight sample and then take
// its answer, so the depth is one no matter how many ask.
var (
	permSampleMu   sync.Mutex
	permSampleAt   time.Time
	permSampleRows []permissionRow
)

const permSampleTTL = 700 * time.Millisecond

// samplePermissionRows returns the four statuses, re-reading them only when the
// cached sample is older than freshSince.
//
// Freshness is a DEADLINE, not a boolean, because "force" answers the wrong
// question after a request. A caller that has just asked the OS for something
// needs a sample taken after the ask; any sample taken after that moment will
// do, including one another goroutine is already producing. With a boolean, a
// request arriving behind a stalled 2s poll would wait out that poll and then
// insist on its own second 2s read, hanging the button for four seconds to
// learn what the sample it just discarded already knew.
func samplePermissionRows(freshSince time.Time) []permissionRow {
	permSampleMu.Lock()
	defer permSampleMu.Unlock()

	if permSampleRows != nil && permSampleAt.After(freshSince) {
		return append([]permissionRow(nil), permSampleRows...)
	}

	notif, mic, screen, ax := readPermissionStatuses()
	byName := map[string]string{
		"notifications": notif,
		"microphone":    mic,
		"screen":        screen,
		"accessibility": ax,
	}

	rows := make([]permissionRow, 0, len(permissionNames))
	for _, name := range permissionNames {
		rows = append(rows, permissionRow{
			Name:   name,
			Status: byName[name],
			Grant:  setupPermissionGrant(name),
		})
	}

	permSampleAt = time.Now()
	permSampleRows = rows
	return append([]permissionRow(nil), rows...)
}

// pollFreshness is the deadline an ordinary status read asks for: anything
// sampled within the TTL.
func pollFreshness() time.Time { return time.Now().Add(-permSampleTTL) }

// buildPermissionsReport assembles the full report.
func buildPermissionsReport(freshSince time.Time) permissionsReport {
	return permissionsReport{
		Platform:    setupPlatform,
		Bundled:     setupProcessBundled(),
		Permissions: samplePermissionRows(freshSince),
	}
}

// knownPermission guards the request handler's name parameter. The name selects
// a TCC prompt and a System Settings deep link, so it is checked against the
// fixed set rather than passed through - a params map arrives from the brain,
// and nothing that reaches an `open` should be taken on trust.
func knownPermission(name string) bool {
	_, ok := permissionNameSet[name]
	return ok
}

// paneLauncherWait bounds how long we watch a System Settings launcher before
// assuming it is fronting a window rather than failing.
const paneLauncherWait = 1500 * time.Millisecond

// startPaneLauncher runs a launcher (`open`, `rundll32`) and reports whether it
// took the URL.
//
// Two things the bare .Start() this replaces could not do. It REAPS the child:
// the native wizard re-execs moments after opening a pane so a zombie there was
// invisible, but this handler lives in a process that runs for weeks and every
// click would leave one behind. And it OBSERVES the exit: a launcher that fails
// after fork - no `open` on a broken install, a scheme nothing handles - exits
// nonzero within milliseconds, and reporting that as a window the user should
// go and look at is the exact failure this whole change exists to remove.
//
// Same shape as openInDefaultBrowser: a launcher normally hands off and exits
// at once, so a process still alive at the deadline is a success, and the
// goroutine keeps waiting to reap it on every path.
func startPaneLauncher(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		return err
	case <-time.After(paneLauncherWait):
		return nil // still running: assume it is fronting System Settings
	}
}

// handleSystemPermissions reports what this machine has granted.
func handleSystemPermissions(_ map[string]any) (*RPCResult, error) {
	return &RPCResult{Result: buildPermissionsReport(pollFreshness())}, nil
}

// handleSystemRequestPermission asks for one permission and reports where it
// landed.
//
// Both halves run for a "pane" permission, in this order: the request first
// (which is what makes Jarvis APPEAR in the pane's list - an app absent from
// that list cannot be toggled on, so opening the pane first shows the user an
// empty list and no way forward), then the pane itself. For a "prompt"
// permission the OS dialog is the whole interaction and no pane is opened.
//
// The status returned is sampled immediately afterwards and is usually
// UNCHANGED: every macOS request is asynchronous, and a pane grant needs the
// user to go and flip a toggle. It is the dashboard's poll that observes the
// grant, not this return value - which reports the request was made, and for a
// pane row whether the pane opened.
func handleSystemRequestPermission(params map[string]any) (*RPCResult, error) {
	name, _ := params["name"].(string)
	if name == "" {
		return nil, fmt.Errorf("missing required parameter: name")
	}
	if !knownPermission(name) {
		return nil, fmt.Errorf("unknown permission %q", name)
	}

	// Refuse to ask on behalf of an app we are not. Without a bundle identity
	// the grant lands on whatever launched the sidecar: requesting "screen"
	// from a bare binary run in a terminal registers TERMINAL in the Screen
	// Recording list and then invites the user to switch it on. Reporting that
	// as a permission granted to Jarvis would be wrong twice over, so the
	// report's `bundled: false` is a refusal here and a warning on screen,
	// not a row to click.
	if !setupProcessBundled() {
		return nil, fmt.Errorf("not running as an app bundle: a grant would attach to the launching app, not to Jarvis")
	}

	mode := setupPermissionGrant(name)
	if mode == grantNone {
		return nil, fmt.Errorf("permission %q cannot be requested on %s", name, setupPlatform)
	}

	// Stamped BEFORE the request so the sample below cannot be one taken
	// before the OS was asked. See samplePermissionRows on why this is a
	// deadline rather than a "force" flag.
	askedAt := time.Now()
	setupRequestPermission(name)

	paneOpened := false
	var paneErr string
	if mode == grantPane {
		if err := setupOpenPane(name); err != nil {
			// Not fatal: the request above may still have registered Jarvis in
			// the pane, and the user can open System Settings themselves. Report
			// it so the dashboard can say that instead of silently pretending a
			// window appeared - the exact failure this whole change is about.
			paneErr = err.Error()
		} else {
			paneOpened = true
		}
	}

	result := map[string]any{
		"name":        name,
		"grant":       mode,
		"pane_opened": paneOpened,
		"permissions": samplePermissionRows(askedAt),
	}
	if paneErr != "" {
		result["pane_error"] = paneErr
	}
	return &RPCResult{Result: result}, nil
}
