//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// winPipe wraps a synchronous anonymous-pipe handle with blocking ReadFile /
// WriteFile. We avoid os.NewFile here on purpose: it routes the handle through
// Go's IOCP poller, whose behavior on synchronous CreatePipe handles is fragile.
// The readLoop runs on its own goroutine, so blocking syscalls are fine.
type winPipe struct {
	h windows.Handle
}

func (p *winPipe) Read(b []byte) (int, error) {
	var done uint32
	err := windows.ReadFile(p.h, b, &done, nil)
	if err != nil {
		// The browser closed its end (exit) -> surface a clean EOF.
		if err == windows.ERROR_BROKEN_PIPE || err == windows.ERROR_HANDLE_EOF {
			return int(done), io.EOF
		}
		return int(done), err
	}
	if done == 0 {
		return 0, io.EOF
	}
	return int(done), nil
}

func (p *winPipe) Write(b []byte) (int, error) {
	var done uint32
	if err := windows.WriteFile(p.h, b, &done, nil); err != nil {
		return int(done), err
	}
	return int(done), nil
}

func (p *winPipe) Close() error { return windows.CloseHandle(p.h) }

// On Windows, Chromium's --remote-debugging-pipe reads/writes CDP on C-runtime
// file descriptors 3 and 4. Those fds are populated through the MSVCRT "lowio"
// inheritance block passed in STARTUPINFO.lpReserved2 — a mechanism Go's
// os/exec does not expose. So we launch the browser by calling CreateProcessW
// directly, hand-building that block (the same trick libuv / Node use).

var (
	modkernel32        = windows.NewLazySystemDLL("kernel32.dll")
	procCreateProcessW = modkernel32.NewProc("CreateProcessW")
)

// startupInfoW mirrors STARTUPINFOW. We need the cbReserved2 / lpReserved2
// fields that golang.org/x/sys/windows.StartupInfo leaves as blank padding.
type startupInfoW struct {
	Cb            uint32
	Reserved      *uint16
	Desktop       *uint16
	Title         *uint16
	X             uint32
	Y             uint32
	XSize         uint32
	YSize         uint32
	XCountChars   uint32
	YCountChars   uint32
	FillAttribute uint32
	Flags         uint32
	ShowWindow    uint16
	CbReserved2   uint16
	LpReserved2   *byte
	StdInput      windows.Handle
	StdOutput     windows.Handle
	StdErr        windows.Handle
}

// CRT lowio per-fd flags.
const (
	crtFOPEN = 0x01
	crtFPIPE = 0x08
)

// buildCRTInheritBlock encodes the MSVCRT lowio table: a uint32 count, then one
// flags byte per fd, then one pointer-sized handle per fd. Unused fds carry an
// INVALID handle and zero flags; pipe fds carry FOPEN|FPIPE.
func buildCRTInheritBlock(handles []windows.Handle) []byte {
	const ptrSize = int(unsafe.Sizeof(uintptr(0)))
	n := len(handles)
	buf := make([]byte, 4+n+n*ptrSize)
	binary.LittleEndian.PutUint32(buf[0:], uint32(n))
	flagsOff := 4
	handlesOff := 4 + n
	for i, h := range handles {
		if h != windows.InvalidHandle && h != 0 {
			buf[flagsOff+i] = crtFOPEN | crtFPIPE
		}
		off := handlesOff + i*ptrSize
		if ptrSize == 8 {
			binary.LittleEndian.PutUint64(buf[off:], uint64(h))
		} else {
			binary.LittleEndian.PutUint32(buf[off:], uint32(h))
		}
	}
	return buf
}

func closeHandles(hs ...windows.Handle) {
	for _, h := range hs {
		if h != 0 && h != windows.InvalidHandle {
			windows.CloseHandle(h)
		}
	}
}

// startBrowserPipe launches the browser with its CDP pipe on inherited fds 3
// (commands in) and 4 (responses out).
func startBrowserPipe(exe string, args []string) (*browserProc, error) {
	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))

	// Command pipe: browser reads cmdR (fd 3); we write cmdW.
	var cmdR, cmdW windows.Handle
	if err := windows.CreatePipe(&cmdR, &cmdW, sa, 0); err != nil {
		return nil, fmt.Errorf("create command pipe: %w", err)
	}
	// Response pipe: browser writes respW (fd 4); we read respR.
	var respR, respW windows.Handle
	if err := windows.CreatePipe(&respR, &respW, sa, 0); err != nil {
		closeHandles(cmdR, cmdW)
		return nil, fmt.Errorf("create response pipe: %w", err)
	}

	// The parent-side ends must not be inherited by the child.
	windows.SetHandleInformation(cmdW, windows.HANDLE_FLAG_INHERIT, 0)
	windows.SetHandleInformation(respR, windows.HANDLE_FLAG_INHERIT, 0)

	block := buildCRTInheritBlock([]windows.Handle{
		windows.InvalidHandle, windows.InvalidHandle, windows.InvalidHandle, // fd 0,1,2
		cmdR,  // fd 3
		respW, // fd 4
	})

	cmdline := syscall.EscapeArg(exe)
	for _, a := range args {
		cmdline += " " + syscall.EscapeArg(a)
	}
	cmdlineU16, err := windows.UTF16FromString(cmdline)
	if err != nil {
		closeHandles(cmdR, cmdW, respR, respW)
		return nil, err
	}

	si := startupInfoW{}
	si.Cb = uint32(unsafe.Sizeof(si))
	si.CbReserved2 = uint16(len(block))
	si.LpReserved2 = &block[0]

	var pi windows.ProcessInformation
	r1, _, callErr := procCreateProcessW.Call(
		0,                                       // lpApplicationName (parsed from cmdline)
		uintptr(unsafe.Pointer(&cmdlineU16[0])), // lpCommandLine
		0,                                       // lpProcessAttributes
		0,                                       // lpThreadAttributes
		1,                                       // bInheritHandles = TRUE
		uintptr(windows.CREATE_NO_WINDOW),       // dwCreationFlags
		0,                                       // lpEnvironment (inherit)
		0,                                       // lpCurrentDirectory
		uintptr(unsafe.Pointer(&si)),            // lpStartupInfo
		uintptr(unsafe.Pointer(&pi)),            // lpProcessInformation
	)
	runtime.KeepAlive(block)
	runtime.KeepAlive(cmdlineU16)
	if r1 == 0 {
		closeHandles(cmdR, cmdW, respR, respW)
		return nil, fmt.Errorf("CreateProcess %s: %w", exe, callErr)
	}

	// The child holds inherited copies; drop ours and the thread handle.
	closeHandles(cmdR, respW, pi.Thread)

	hProc := pi.Process
	return &browserProc{
		write: &winPipe{h: cmdW},
		read:  &winPipe{h: respR},
		kill: func() {
			windows.TerminateProcess(hProc, 0)
			windows.CloseHandle(hProc)
		},
	}, nil
}
