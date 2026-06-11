//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
)

// startBrowserPipe launches the browser with its CDP pipe wired to inherited
// file descriptors 3 (commands in) and 4 (responses out). On POSIX this is a
// straight exec.Cmd.ExtraFiles mapping: ExtraFiles[0] -> fd 3, [1] -> fd 4.
func startBrowserPipe(exe string, args []string) (*browserProc, error) {
	// Command pipe: browser reads cmdR (fd 3); we write cmdW.
	cmdR, cmdW, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("create command pipe: %w", err)
	}
	// Response pipe: browser writes respW (fd 4); we read respR.
	respR, respW, err := os.Pipe()
	if err != nil {
		cmdR.Close()
		cmdW.Close()
		return nil, fmt.Errorf("create response pipe: %w", err)
	}

	cmd := exec.Command(exe, args...)
	cmd.ExtraFiles = []*os.File{cmdR, respW} // -> fd 3, fd 4

	if err := cmd.Start(); err != nil {
		cmdR.Close()
		cmdW.Close()
		respR.Close()
		respW.Close()
		return nil, err
	}

	// The child holds its own copies of the pipe ends now.
	cmdR.Close()
	respW.Close()

	proc := cmd.Process
	return &browserProc{
		write: cmdW,
		read:  respR,
		kill: func() {
			if proc != nil {
				proc.Kill()
				go cmd.Wait() // reap
			}
		},
	}, nil
}
