//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/jarvis/sidecar/internal/autostart"
)

const (
	sidecarExeName = "jarvis.exe"
	// uninstallKeyPath is where the Windows-integration PR registers the app;
	// detection reads it already so updates keep working once it exists.
	uninstallKeyPath = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Jarvis`

	trayWindowClass = "JarvisSidecarTray"
	trayWmCopyData  = 0x004A
	// quitCopyDataMagic mirrors the sidecar's tray_windows.go receiver: a
	// WM_COPYDATA tagged with 'JVQT' asks the running sidecar to shut down
	// cleanly (client.Stop → mic released, websocket closed).
	quitCopyDataMagic = 0x4A565154
)

// installDirDefault is %LOCALAPPDATA%\Programs\Jarvis — the per-user install
// convention (VS Code, Discord, Slack); no admin/UAC involved.
func installDirDefault() (string, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return "", fmt.Errorf("LOCALAPPDATA is not set")
	}
	dir := filepath.Join(base, "Programs", "Jarvis")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return dir, nil
}

// detectInstalled reads DisplayVersion from our uninstall key, falling back to
// asking an exe found at the default location.
func detectInstalled() (installedSidecar, error) {
	var inst installedSidecar
	if k, err := registry.OpenKey(registry.CURRENT_USER, uninstallKeyPath, registry.QUERY_VALUE); err == nil {
		ver, _, verr := k.GetStringValue("DisplayVersion")
		loc, _, lerr := k.GetStringValue("InstallLocation")
		k.Close()
		if verr == nil && lerr == nil && ver != "" && loc != "" {
			inst.Version, inst.InstallDir = ver, loc
			return inst, nil
		}
	}
	if base := os.Getenv("LOCALAPPDATA"); base != "" {
		dir := filepath.Join(base, "Programs", "Jarvis")
		if v, err := installedBinaryVersion(dir); err == nil {
			inst.Version, inst.InstallDir = v, dir
			return inst, nil
		}
	}
	inst.ManagedByNpm = npmManagedSidecarPresent()
	return inst, nil
}

// installedBinaryVersion works despite the sidecar's -H windowsgui subsystem:
// os/exec wires pipes explicitly, so main.go's fmt.Println(sidecarVersion) is
// capturable.
func installedBinaryVersion(installDir string) (string, error) {
	out, err := exec.Command(filepath.Join(installDir, sidecarExeName), "--version").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

type copyDataStruct struct {
	dwData uintptr
	cbData uint32
	lpData uintptr
}

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procFindWindowW         = user32.NewProc("FindWindowW")
	procSendMessageTimeoutW = user32.NewProc("SendMessageTimeoutW")
)

const (
	smtoNormal      = 0x0000
	smtoAbortIfHung = 0x0002
	// quitSendTimeoutMS bounds the delivery attempt. A plain SendMessage to a
	// window whose thread is not pumping blocks FOREVER, which would strand
	// the installer before the timeout loop and taskkill fallback below ever
	// run — the exact case they exist for.
	quitSendTimeoutMS = 5000
)

// stopRunningSidecar asks the tray window to quit via the tagged WM_COPYDATA
// hook (sidecars ≥ the quit-hook release), polls for exit, then falls back to
// taskkill — consented implicitly in silent mode by the frozen contract, and
// pre-hook sidecars simply have no graceful path (WM_CLOSE would only strip
// the tray icon and leave a headless process holding the mic).
func stopRunningSidecar(inst installedSidecar, silent bool) error {
	hwnd := findTrayWindow()
	if hwnd == 0 {
		return nil // not running
	}
	logf("stopping running sidecar...")
	payload := []byte("quit\x00")
	cds := copyDataStruct{
		dwData: quitCopyDataMagic,
		cbData: uint32(len(payload)),
		lpData: uintptr(unsafe.Pointer(&payload[0])),
	}
	var result uintptr
	procSendMessageTimeoutW.Call(hwnd, trayWmCopyData, 0, uintptr(unsafe.Pointer(&cds)),
		smtoNormal|smtoAbortIfHung, quitSendTimeoutMS, uintptr(unsafe.Pointer(&result)))
	runtime.KeepAlive(payload) // lpData is a bare uintptr — keep the buffer live across the syscall
	runtime.KeepAlive(cds)

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if findTrayWindow() == 0 {
			// Window gone; give the process a moment to finish teardown and
			// release the exe file lock.
			time.Sleep(700 * time.Millisecond)
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}

	// Pre-quit-hook sidecars have no graceful path (WM_CLOSE would only strip
	// the tray icon and leave a headless process holding the mic), and a
	// wedged message pump won't answer the quit request either. taskkill has
	// no path filter, so this necessarily targets the image name — and NOT
	// `STATUS eq RUNNING`, which would exclude the "not responding" process
	// this fallback exists to kill.
	logf("sidecar did not stop gracefully — terminating it")
	kill := exec.Command("taskkill", "/IM", sidecarExeName, "/F")
	hideSubprocessWindow(kill)
	if out, err := kill.CombinedOutput(); err != nil {
		return fmt.Errorf("taskkill: %v — %s", err, strings.TrimSpace(string(out)))
	}
	time.Sleep(700 * time.Millisecond)
	if findTrayWindow() != 0 {
		return fmt.Errorf("sidecar still running after taskkill")
	}
	return nil
}

func findTrayWindow() uintptr {
	cls, err := windows.UTF16PtrFromString(trayWindowClass)
	if err != nil {
		return 0
	}
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), 0)
	return hwnd
}

// checkPayloadLayout rejects a package missing the executable we install, so
// a malformed publish does not surface as a signature failure.
func checkPayloadLayout(stagedBin, version string) error {
	if _, err := os.Stat(filepath.Join(stagedBin, sidecarExeName)); err != nil {
		return fmt.Errorf("sidecar %s should contain %s but does not — the published package looks malformed",
			version, sidecarExeName)
	}
	return nil
}

// swapInstall replaces jarvis.exe in installDir (the only file the win32
// package ships) with a rename-based rollback: the running instance was
// already stopped, so the file lock is released.
func swapInstall(stagedBin, installDir string) error {
	src := filepath.Join(stagedBin, sidecarExeName)
	if _, err := os.Stat(src); err != nil {
		return fmt.Errorf("payload lacks %s: %w", sidecarExeName, err)
	}
	dst := filepath.Join(installDir, sidecarExeName)
	old := dst + ".old"

	staged := dst + ".staging"
	os.Remove(staged)
	if err := copyFilePreserve(src, staged); err != nil {
		return err
	}
	os.Remove(old)
	hadOld := false
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, old); err != nil {
			os.Remove(staged)
			return err
		}
		hadOld = true
	}
	if err := os.Rename(staged, dst); err != nil {
		if hadOld {
			_ = os.Rename(old, dst)
		}
		os.Remove(staged)
		return err
	}
	os.Remove(old)
	return nil
}

func copyFilePreserve(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	fi, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := out.ReadFrom(in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// launchInstalled starts the installed sidecar. No --setup handoff on
// Windows: the sidecar's onboarding wizard would only re-ask the autostart
// question the installer already settled (there's no TCC equivalent here).
func launchInstalled(installDir, _ string, _ bool) error {
	return exec.Command(filepath.Join(installDir, sidecarExeName)).Start()
}

// applyAutostart registers/removes the installed exe as a login item — the
// same HKCU Run value the sidecar manages for itself.
func applyAutostart(installDir string, enabled bool) error {
	exe := ""
	if enabled {
		exe = filepath.Join(installDir, sidecarExeName)
	}
	return autostart.Set(exe, enabled)
}
