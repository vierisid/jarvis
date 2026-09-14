package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Who is allowed to say "something other than a webview window owns the run
// loop", and when.
//
// The flag exists because `terminate_impl` on Cocoa and GTK has to do two
// opposite things (see third_party/webview_go/JARVIS_PATCH.md). Under a single
// shared loop (the macOS tray's [NSApp run], the Linux sidecar's one gtk_main
// for its overlays and panels), a window closing must NOT stop it. Before that
// loop exists, the first-run connect window and the onboarding wizard own the
// loop themselves and end by calling Terminate() to hand control back to
// main() -- for those, terminate must actually terminate.
//
// Setting the flag too early collapses the second case into the first, and the
// failure is silent on both sides: Run() never returns, the window sits open on
// its "connected" screen, the enrollment token it already captured is never
// saved, and the sidecar never dials the brain a user has just paid for. No
// crash, no error, nothing in the log after the token arrives. That shipped
// once. These are cheap and they run on every platform, unlike the Cocoa and
// GTK code they protect.

// runLoopClaimants maps each file allowed to claim the run loop to the call
// that enters the shared loop it claims.
var runLoopClaimants = map[string]string{
	"tray_darwin.go":    "C.jarvisTrayRun()",
	"gtk_main_linux.go": "C.gtk_main()",
}

func TestHostOwnsRunLoopIsDeclaredOnlyByTheSharedLoops(t *testing.T) {
	// Walked, not globbed: a glob of the package directory would miss a call
	// added under internal/, which is a real place for one to appear.
	// third_party is upstream's tree and defines the binding itself.
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "third_party" || d.Name() == "node_modules" || d.Name() == "dist" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		// A CALL, not a mention: the identifier appears in prose in more than
		// one comment, and flagging those would train people to ignore this.
		if !strings.Contains(string(src), "SetHostOwnsRunLoop(") {
			return nil
		}
		if _, ok := runLoopClaimants[filepath.ToSlash(path)]; !ok {
			t.Errorf("%s calls SetHostOwnsRunLoop; only the shared loops (the macOS tray, "+
				"the Linux GTK main loop) may, and only as they enter the loop. Anything "+
				"earlier makes Terminate a no-op for the first-run windows, which then "+
				"never return from Run().", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

func TestSharedLoopsClaimTheRunLoopOnlyAsTheyEnterIt(t *testing.T) {
	for file, enter := range runLoopClaimants {
		t.Run(file, func(t *testing.T) {
			src, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read %s: %v", file, err)
			}
			text := string(src)

			const claim = "webview.SetHostOwnsRunLoop(true)"

			if n := strings.Count(text, claim); n != 1 {
				t.Fatalf("found %d calls to %s in %s, want exactly 1", n, claim, file)
			}
			if n := strings.Count(text, enter); n != 1 {
				t.Fatalf("found %d calls to %s in %s, want exactly 1", n, enter, file)
			}

			claimAt := strings.Index(text, claim)
			enterAt := strings.Index(text, enter)
			if claimAt > enterAt {
				t.Fatalf("%s is claimed AFTER entering the run loop in %s; a window "+
					"closing in between would stop the shared loop", claim, file)
			}

			// Adjacent, not merely earlier: the guarantee is "everything before
			// this line owns its own loop". A claim hoisted to the top of the
			// function would still pass an ordering-only check while covering
			// setup paths it must not.
			between := strings.TrimSpace(text[claimAt+len(claim) : enterAt])
			for _, line := range strings.Split(between, "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "//") {
					continue
				}
				t.Fatalf("statement between claiming the run loop and entering it in %s: %q. "+
					"The claim must be the last thing before %s.", file, line, enter)
			}
		})
	}
}

// The Go binding is what the shared loops call; losing it is a compile error
// there but this names the reason so a re-vendor that drops jarvis_native.go
// fails here with an explanation rather than only in a build nobody runs
// locally.
func TestRunLoopBindingSurvivesReVendoring(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("third_party", "webview_go", "jarvis_native.go"))
	if err != nil {
		t.Fatalf("read jarvis_native.go: %v", err)
	}
	if !strings.Contains(string(src), "func SetHostOwnsRunLoop(") {
		t.Fatal("jarvis_native.go no longer exports SetHostOwnsRunLoop. A re-vendor " +
			"drops anything jarvis.patch stops carrying; see JARVIS_PATCH.md.")
	}

	header, err := os.ReadFile(filepath.Join(
		"third_party", "webview_go", "libs", "webview", "include", "webview.h"))
	if err != nil {
		t.Fatalf("read webview.h: %v", err)
	}
	text := string(header)
	if !strings.Contains(text, "webview_set_host_owns_run_loop") {
		t.Fatal("webview.h lost the host-owns-run-loop entry point (re-vendored " +
			"without the jarvis patch?)")
	}
	// The half that a silent revert would take: without this, terminate is an
	// unconditional no-op again and first run hangs. Assert the whole guard,
	// not just its condition -- `if (jarvis_host_owns_run_loop()) {` (inverted)
	// and an empty body both read as "present" to a looser check, and both
	// break it in the direction that hangs.
	guard := "if (!jarvis_host_owns_run_loop()) {\n      stop_run_loop();\n    }"
	if !strings.Contains(text, guard) {
		t.Fatal("webview.h's Cocoa terminate_impl no longer stops a window-owned " +
			"run loop; the pre-tray first-run windows will hang in Run()")
	}
	// The GTK guard, whole for the same reason. Unguarded, the last panel
	// window closing quits the Linux sidecar's shared gtk_main and freezes the
	// pebble; inverted or emptied, the first-run windows hang in Run().
	gtkGuard := "if (!jarvis_host_owns_run_loop()) {\n      dispatch_impl([] { gtk_main_quit(); });\n    }"
	if !strings.Contains(text, gtkGuard) {
		t.Fatal("webview.h's GTK terminate_impl lost its host-owned loop guard; " +
			"a closing panel will quit the Linux sidecar's shared GTK loop")
	}
	// And the setter has to reach the GTK flag, or the guard never engages.
	setter := "#if defined(WEBVIEW_COCOA) || defined(WEBVIEW_GTK)\n  webview::detail::jarvis_host_owns_run_loop() = owns != 0;"
	if !strings.Contains(text, setter) {
		t.Fatal("webview_set_host_owns_run_loop no longer sets the GTK flag; the " +
			"Linux shared loop's guard will never engage")
	}
}
