//go:build !windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"syscall"
	"time"
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
	// Own process group so kill() can take out the whole browser tree:
	// SIGKILL to the main process alone leaves renderer/GPU/crashpad
	// children running, still writing to the profile dir.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

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
			if proc == nil {
				return
			}
			// Group kill first (negative pid), then the direct kill as a
			// fallback in case the group signal failed.
			syscall.Kill(-proc.Pid, syscall.SIGKILL)
			proc.Kill()
			// Block until the process is reaped (bounded): callers like
			// closeActiveCDP rely on the browser being GONE when this
			// returns — the parity test's profile TempDir is removed right
			// after, and a still-dying Chrome racing that removal is a
			// "directory not empty" flake. On timeout the waiter goroutine
			// lingers until the process is eventually reaped (one bounded
			// goroutine per launch).
			done := make(chan struct{})
			go func() {
				cmd.Wait()
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				log.Printf("[browser] kill: process %d not reaped after 5s; proceeding anyway", proc.Pid)
			}
		},
	}, nil
}
