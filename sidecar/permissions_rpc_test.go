package main

import (
	"encoding/json"
	"runtime"
	"sync"
	"testing"
	"time"
)

// The darwin half of this (real TCC reads) can only run on a Mac. What is
// testable anywhere is the shape every platform must hold to, the freshness
// rule, and the coalescing - the last two via readPermissionStatuses, which is
// a package var precisely so a fake slow or changing reader can stand in.

func resetPermissionSample(t *testing.T) {
	t.Helper()
	permSampleMu.Lock()
	permSampleRows = nil
	permSampleAt = time.Time{}
	permSampleMu.Unlock()
}

// stubStatuses swaps in a fake reader for the length of one test.
func stubStatuses(t *testing.T, fn func() (string, string, string, string)) {
	t.Helper()
	resetPermissionSample(t)
	prev := readPermissionStatuses
	readPermissionStatuses = fn
	t.Cleanup(func() {
		readPermissionStatuses = prev
		resetPermissionSample(t)
	})
}

func TestPermissionsReportCoversEveryRow(t *testing.T) {
	resetPermissionSample(t)
	rep := buildPermissionsReport(time.Now())

	if rep.Platform != runtime.GOOS {
		t.Errorf("platform = %q, want %q", rep.Platform, runtime.GOOS)
	}
	if len(rep.Permissions) != len(permissionNames) {
		t.Fatalf("got %d rows, want %d", len(rep.Permissions), len(permissionNames))
	}
	for i, name := range permissionNames {
		if rep.Permissions[i].Name != name {
			t.Errorf("row %d = %q, want %q (order is the report's contract)", i, rep.Permissions[i].Name, name)
		}
	}

	for _, row := range rep.Permissions {
		switch row.Status {
		case "granted", "denied", "undetermined", "na":
		default:
			t.Errorf("%s: status %q is not one of the four the dashboard renders", row.Name, row.Status)
		}
		switch row.Grant {
		case grantPrompt, grantPane, grantNone:
		default:
			t.Errorf("%s: grant %q is not a mode the dashboard knows", row.Name, row.Grant)
		}
	}
}

// The wire keys are a contract with two other programs: the brain parses this
// report (src/daemon/system-permissions.ts) and refuses a shape it cannot read,
// and the wizard renders the result. Renaming a field here would break both
// silently, since a missing key parses as absent rather than as an error.
func TestReportWireFormatIsStable(t *testing.T) {
	stubStatuses(t, func() (string, string, string, string) {
		return "granted", "denied", "undetermined", "na"
	})

	blob, err := json.Marshal(buildPermissionsReport(time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(blob, &got); err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{"platform", "bundled", "permissions"} {
		if _, ok := got[key]; !ok {
			t.Errorf("report is missing the %q key the brain reads", key)
		}
	}
	rows, ok := got["permissions"].([]any)
	if !ok || len(rows) != len(permissionNames) {
		t.Fatalf("permissions did not marshal as a %d-element array", len(permissionNames))
	}
	first, _ := rows[0].(map[string]any)
	for _, key := range []string{"name", "status", "grant"} {
		if _, ok := first[key]; !ok {
			t.Errorf("row is missing the %q key the brain reads", key)
		}
	}
	if first["status"] != "granted" {
		t.Errorf("first row status = %v, want the reader's first return value", first["status"])
	}
}

// Off macOS there is no per-app permission model, so every row must read "na"
// and the dashboard hides them. Getting this wrong would show Linux users four
// rows that can never go green.
func TestNonDarwinReportsNoApplicablePermissions(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("macOS answers these for real")
	}
	resetPermissionSample(t)
	rep := buildPermissionsReport(time.Now())
	for _, row := range rep.Permissions {
		if row.Status != "na" {
			t.Errorf("%s: status = %q, want \"na\" on %s", row.Name, row.Status, runtime.GOOS)
		}
	}
	if !rep.Bundled {
		t.Error("bundled must be true where no bundle identity exists to be missing")
	}
}

// The one openable pane off macOS. Windows has no readable status for it, so
// the row exists purely to carry the link - losing the grant mode would lose
// the row.
func TestWindowsMicrophoneKeepsItsPane(t *testing.T) {
	want := grantNone
	if runtime.GOOS == "windows" {
		want = grantPane
	}
	if got := setupPermissionGrant("microphone"); got != want {
		t.Errorf("microphone grant on %s = %q, want %q", runtime.GOOS, got, want)
	}
}

func TestRequestRejectsUnknownNames(t *testing.T) {
	// A name selects a TCC prompt and a System Settings deep link, and it
	// arrives in an RPC params map. Anything outside the fixed set must be
	// refused before it reaches setupOpenPane.
	for _, name := range []string{"", "files", "automation", "../../etc", "SCREEN", "screen "} {
		if knownPermission(name) {
			t.Errorf("knownPermission(%q) = true, want false", name)
		}
		if _, err := handleSystemRequestPermission(map[string]any{"name": name}); err == nil {
			t.Errorf("request(%q) returned no error", name)
		}
	}
	for _, name := range permissionNames {
		if !knownPermission(name) {
			t.Errorf("knownPermission(%q) = false, want true", name)
		}
	}
}

func TestRequestRefusesWhatThePlatformCannotDo(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("every row is requestable on macOS")
	}
	// A valid name whose platform offers nothing must fail loudly rather than
	// report a request that never happened.
	if _, err := handleSystemRequestPermission(map[string]any{"name": "accessibility"}); err == nil {
		t.Errorf("request(accessibility) on %s returned no error", runtime.GOOS)
	}
}

// A sample taken before the OS was asked is not an answer to "what happened
// when I asked". The freshness deadline is what guarantees the difference.
func TestRequestNeverServesASampleOlderThanTheAsk(t *testing.T) {
	var mu sync.Mutex
	status := "denied"
	stubStatuses(t, func() (string, string, string, string) {
		mu.Lock()
		defer mu.Unlock()
		return status, status, status, status
	})

	// Warm the cache with the pre-request answer.
	before := samplePermissionRows(pollFreshness())
	if before[0].Status != "denied" {
		t.Fatalf("warm-up status = %q", before[0].Status)
	}

	// The grant lands. A poll issued now, inside the TTL, would happily serve
	// the stale "denied" -- which is correct for a poll and wrong for a request.
	mu.Lock()
	status = "granted"
	mu.Unlock()

	if got := samplePermissionRows(pollFreshness())[0].Status; got != "denied" {
		t.Errorf("a poll inside the TTL re-read; got %q, want the cached \"denied\"", got)
	}
	if got := samplePermissionRows(time.Now())[0].Status; got != "granted" {
		t.Errorf("a request-freshness read served a stale sample: got %q, want \"granted\"", got)
	}
}

// Concurrent pollers must collapse onto one read. Without that, a status read
// that stalls for 2s under a 1.5s poll stacks overlapping samples of the same
// thing for as long as the screen is open.
func TestConcurrentPollersShareOneRead(t *testing.T) {
	var reads int
	var mu sync.Mutex
	stubStatuses(t, func() (string, string, string, string) {
		mu.Lock()
		reads++
		mu.Unlock()
		time.Sleep(30 * time.Millisecond)
		return "denied", "denied", "denied", "denied"
	})

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = samplePermissionRows(pollFreshness())
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if reads != 1 {
		t.Errorf("8 concurrent pollers caused %d reads, want 1", reads)
	}
}

// Callers must not be able to edit the cached sample out from under the next
// caller - they share one slice otherwise.
func TestSampleIsCopiedPerCaller(t *testing.T) {
	resetPermissionSample(t)
	first := samplePermissionRows(pollFreshness())
	if len(first) == 0 {
		t.Fatal("no rows")
	}
	first[0].Status = "tampered"

	second := samplePermissionRows(pollFreshness())
	if second[0].Status == "tampered" {
		t.Error("the cached sample is shared by reference; one caller can corrupt every other")
	}
}

func TestSampleTTLIsShortEnoughToWatch(t *testing.T) {
	// The dashboard polls while the user is looking at the screen. A TTL near
	// or above the poll interval would make a grant take two polls to appear.
	if permSampleTTL >= time.Second {
		t.Errorf("permSampleTTL = %v; too long for a row to turn green as the user watches", permSampleTTL)
	}
}
