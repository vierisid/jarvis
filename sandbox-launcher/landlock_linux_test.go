//go:build linux

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuleRights(t *testing.T) {
	handled := handledRights(1)
	if handled&accessTruncate != 0 || handled&accessRefer != 0 {
		t.Fatalf("ABI 1 cannot handle truncate or refer: %b", handled)
	}
	if got := ruleRights(readWriteRights, true, handled); got&accessTruncate != 0 {
		t.Fatalf("a right the ABI cannot handle was granted: %b", got)
	}
	file := ruleRights(readOnlyRights, false, handledRights(6))
	if file != accessExecute|accessReadFile {
		t.Fatalf("a file rule may carry file rights only: %b", file)
	}
	if readWriteRights&accessExecute != 0 {
		t.Fatal("nothing written in the sandbox may be executable")
	}
}

// launcher runs the test binary as jarvis-sandbox.
func launcher(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(os.Args[0], append([]string{"jarvis-sandbox"}, args...)...)
	cmd.Env = append(os.Environ(), "JARVIS_SANDBOX_HELPER=1")
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func system() []string {
	var args []string
	for _, p := range []string{"/usr", "/lib", "/lib64", "/bin", "/etc/ld.so.cache", "/nix/store"} {
		args = append(args, "--ro", p)
	}
	return args
}

func TestSandboxDeniesWhatIsNotListed(t *testing.T) {
	if abiVersion() < 1 {
		t.Skip("no Landlock on this kernel")
	}
	cat, err := exec.LookPath("cat")
	if err != nil {
		t.Skip("no cat")
	}
	cat, _ = filepath.EvalSymlinks(cat)
	data := t.TempDir()
	secret := filepath.Join(data, "workflow-encryption.key")
	if err := os.WriteFile(secret, []byte("planted-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	allowed := filepath.Join(data, "allowed")
	if err := os.Mkdir(allowed, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(allowed, "ok.txt"), []byte("readable"), 0o600); err != nil {
		t.Fatal(err)
	}

	out, err := launcher(t, append(system(), "--ro", allowed, "--", cat, secret)...)
	if err == nil || strings.Contains(out, "planted-secret") {
		t.Fatalf("read a file outside the allow-list: %q", out)
	}

	out, err = launcher(t, append(system(), "--ro", allowed, "--", cat, filepath.Join(allowed, "ok.txt"))...)
	if err != nil || !strings.Contains(out, "readable") {
		t.Fatalf("could not read an allowed file: %q %v", out, err)
	}

	// Read-only means read-only, and the rules reach the program's children.
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	sh, _ = filepath.EvalSymlinks(sh)
	out, err = launcher(t, append(system(), "--ro", allowed, "--", sh, "-c", "echo x > "+filepath.Join(allowed, "new.txt"))...)
	if err == nil {
		t.Fatalf("wrote into a read-only path: %q", out)
	}
	rw := filepath.Join(data, "rw")
	if err := os.Mkdir(rw, 0o700); err != nil {
		t.Fatal(err)
	}
	out, err = launcher(t, append(system(), "--rw", rw, "--", sh, "-c", "echo x > "+filepath.Join(rw, "new.txt")+" && cat "+secret)...)
	if err == nil || strings.Contains(out, "planted-secret") {
		t.Fatalf("a child read a file outside the allow-list: %q", out)
	}
	if _, err := os.Stat(filepath.Join(rw, "new.txt")); err != nil {
		t.Fatalf("could not write into a read-write path: %v", err)
	}
}

func TestLauncherRefusesWithoutRunning(t *testing.T) {
	out, err := launcher(t, "--", "relative-program")
	if err == nil || !strings.Contains(out, "absolute") {
		t.Fatalf("expected a refusal: %q %v", out, err)
	}
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != exitLauncherFailed {
		t.Fatalf("expected exit %d: %v", exitLauncherFailed, err)
	}
}
