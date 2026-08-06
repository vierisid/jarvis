//go:build windows

package main

// Start Menu shortcut via WScript.Shell COM automation — go-ole is already a
// module dependency (the sidecar's UIA code uses it), and the IDispatch route
// is ~20 lines against ~100 for raw IShellLinkW vtables.

import (
	"runtime"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

func createStartMenuShortcut(targetExe, workingDir string) error {
	lnk, err := startMenuLnkPath()
	if err != nil {
		return err
	}

	// COM apartments are per-OS-thread, and this runs on a goroutine in the
	// wizard path — without locking, the goroutine can migrate between
	// CoInitialize and CreateObject and get CO_E_NOTINITIALIZED. Same
	// convention as uia_windows.go.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := ole.CoInitialize(0); err != nil {
		if oleErr, ok := err.(*ole.OleError); !ok || (oleErr.Code() != 0 && oleErr.Code() != 1) {
			return err // S_OK / S_FALSE mean "already initialized" — fine
		}
	}
	defer ole.CoUninitialize()

	unk, err := oleutil.CreateObject("WScript.Shell")
	if err != nil {
		return err
	}
	defer unk.Release()
	ws, err := unk.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return err
	}
	defer ws.Release()

	csRes, err := oleutil.CallMethod(ws, "CreateShortcut", lnk)
	if err != nil {
		return err
	}
	cs := csRes.ToIDispatch()
	defer cs.Release()

	for _, p := range [][2]string{
		{"TargetPath", targetExe},
		{"WorkingDirectory", workingDir},
		{"IconLocation", targetExe + ",0"},
		{"Description", "Jarvis sidecar"},
	} {
		if _, err := oleutil.PutProperty(cs, p[0], p[1]); err != nil {
			return err
		}
	}
	_, err = oleutil.CallMethod(cs, "Save")
	return err
}
