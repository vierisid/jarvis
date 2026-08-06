//go:build windows

// Package webview2 checks for (and interactively installs) the Edge WebView2
// Evergreen Runtime, which every webview window in the project needs on
// Windows — the sidecar's panels/settings AND the installer's wizard. Shared
// so both binaries prompt and wait identically.
package webview2

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

// EdgeUpdate registers the installed WebView2 runtime's version under this
// client GUID's `pv` value — the documented way to detect the runtime.
const clientGUID = `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`

const (
	// Evergreen Bootstrapper — Microsoft's tiny online installer.
	bootstrapperURL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
	docsURL         = "https://developer.microsoft.com/microsoft-edge/webview2/"
	installerProc   = "MicrosoftEdgeWebview2Setup.exe"
)

var (
	user32            = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW   = user32.NewProc("MessageBoxW")
	shell32           = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteW = shell32.NewProc("ShellExecuteW")

	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateToolhelp32Snapshot = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW          = kernel32.NewProc("Process32FirstW")
	procProcess32NextW           = kernel32.NewProc("Process32NextW")
	procCloseHandle              = kernel32.NewProc("CloseHandle")
)

// PROCESSENTRY32W (only the fields we read; szExeFile carries the image name).
type processEntry32 struct {
	Size            uint32
	CntUsage        uint32
	ProcessID       uint32
	DefaultHeapID   uintptr
	ModuleID        uint32
	CntThreads      uint32
	ParentProcessID uint32
	PriClassBase    int32
	Flags           uint32
	ExeFile         [260]uint16
}

func processRunning(name string) bool {
	const th32csSnapProcess = 0x00000002
	snap, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapProcess, 0)
	if snap == 0 || snap == ^uintptr(0) {
		return false
	}
	defer procCloseHandle.Call(snap)

	var pe processEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	target := strings.ToLower(name)
	r, _, _ := procProcess32FirstW.Call(snap, uintptr(unsafe.Pointer(&pe)))
	for r != 0 {
		if strings.ToLower(syscall.UTF16ToString(pe.ExeFile[:])) == target {
			return true
		}
		r, _, _ = procProcess32NextW.Call(snap, uintptr(unsafe.Pointer(&pe)))
	}
	return false
}

// Installed reports whether the Edge WebView2 runtime is present by reading
// the EdgeUpdate client `pv` (product version) from the machine-wide (64- and
// 32-bit hives) and per-user registry locations.
func Installed() bool {
	locs := []struct {
		root registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\` + clientGUID},
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\EdgeUpdate\Clients\` + clientGUID},
		{registry.CURRENT_USER, `SOFTWARE\Microsoft\EdgeUpdate\Clients\` + clientGUID},
	}
	for _, l := range locs {
		k, err := registry.OpenKey(l.root, l.path, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		pv, _, err := k.GetStringValue("pv")
		k.Close()
		if err == nil && pv != "" && pv != "0.0.0.0" {
			return true
		}
	}
	return false
}

// Ensure returns true if the WebView2 runtime is present (now or after the
// user installs it). When it's missing it prompts the user (native dialog)
// and, on confirmation, downloads + launches the Evergreen Bootstrapper and
// then BLOCKS until the runtime appears in the registry — so the caller keeps
// running the moment the install finishes, instead of exiting mid-install.
// Returns false only if the user declines or the install never completes.
//
// Waiting/continuing here (rather than launching + exiting) also avoids the
// Windows Program Compatibility Assistant "this program might not have
// installed correctly" dialog, which fires when a process spawns an installer
// and then exits.
func Ensure() bool {
	if Installed() {
		return true
	}
	log.Printf("[webview2] runtime not found — prompting the user to install it")

	const (
		mbYesNo       = 0x00000004
		mbIconWarning = 0x00000030
		idYes         = 6
	)
	msg := "JARVIS needs the Microsoft Edge WebView2 Runtime to show its windows.\r\n\r\n" +
		"Download and install it now? JARVIS will continue automatically when the " +
		"installation finishes."
	if messageBox(msg, "JARVIS — WebView2 Runtime required", mbYesNo|mbIconWarning) != idYes {
		return false
	}

	if err := launchBootstrapper(); err != nil {
		log.Printf("[webview2] auto-install failed: %v — opening the download page", err)
		if oerr := shellOpen(docsURL); oerr != nil {
			log.Printf("[webview2] failed to open download page: %v", oerr)
		}
		// Manual install via browser — we can't reliably time it; bail.
		return false
	}

	log.Printf("[webview2] installer launched — waiting for it to finish")
	return waitForRuntime(10 * time.Minute)
}

// launchBootstrapper downloads the Evergreen Bootstrapper to %TEMP% and
// starts it. Fire-and-forget: it may self-elevate (UAC), so instead of
// waiting on a process handle (unavailable for elevated launches) the caller
// polls the registry via waitForRuntime.
func launchBootstrapper() error {
	dst := filepath.Join(os.TempDir(), installerProc)
	if err := downloadFile(bootstrapperURL, dst, 60*time.Second); err != nil {
		return fmt.Errorf("download bootstrapper: %w", err)
	}
	if err := shellOpen(dst); err != nil {
		return fmt.Errorf("launch bootstrapper: %w", err)
	}
	log.Printf("[webview2] launched installer: %s", dst)
	return nil
}

// waitForRuntime blocks until the runtime is ready or the timeout elapses.
//
// IMPORTANT: the registry `pv` value is written when the install hits ~100%,
// but the bootstrapper is still finalizing the runtime at that point. So
// "ready" means BOTH the runtime is registered AND the installer process has
// exited (plus a short settle). We only enter this function when the runtime
// was initially absent, so the registry flips true exactly once.
func waitForRuntime(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		if !Installed() {
			continue
		}
		if processRunning(installerProc) {
			continue // registered but the installer is still finalizing
		}
		log.Printf("[webview2] installer closed + runtime registered — settling")
		time.Sleep(3 * time.Second)
		if Installed() && !processRunning(installerProc) {
			log.Printf("[webview2] runtime ready — continuing startup")
			return true
		}
	}
	log.Printf("[webview2] timed out waiting for the runtime to install")
	return false
}

func downloadFile(url, dst string, timeout time.Duration) error {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

func messageBox(text, caption string, flags uint) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(caption)
	r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(flags))
	return int(r)
}

// shellOpen runs ShellExecute "open" on a URL (default browser) or a file
// (the installer, which self-elevates as needed).
func shellOpen(target string) error {
	verb, _ := syscall.UTF16PtrFromString("open")
	t, _ := syscall.UTF16PtrFromString(target)
	const swShowNormal = 1
	r, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(t)), 0, 0, swShowNormal)
	if r <= 32 {
		return fmt.Errorf("ShellExecute failed (code %d)", r)
	}
	return nil
}
