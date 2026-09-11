package main

import (
	"sync/atomic"
	"time"
)

// Single-instance guard.
//
// Launching jarvis while it was already running (a second click on the Start
// menu shortcut, the autostart entry racing a manual launch) booted a full
// second sidecar: a second tray icon, a second connection to the brain, and two
// processes fighting over the mic and the global hotkeys. main now claims a
// per-session lock before any of that init. A launch that finds the lock held
// hands off to the running instance (its dashboard comes forward) and exits.
//
// The lock is an OS object that process exit releases, so a crash or a taskkill
// can never leave it stale. Windows only for now (single_instance_windows.go);
// other platforms start unconditionally.

const (
	// singleInstanceWait bounds how long a normal launch waits on a held lock.
	// It covers an instance that is on its way out (Quit and then an immediate
	// relaunch, or the installer launching right after stopping the old one)
	// and one still starting up, before it has a tray window to hand off to.
	singleInstanceWait = 5 * time.Second
	// singleInstanceRelaunchWait is the same bound for an in-app restart. The
	// old process has already committed to exiting by the time it spawns us, so
	// giving up early would leave the user with no sidecar at all.
	singleInstanceRelaunchWait = 30 * time.Second
	singleInstancePoll         = 200 * time.Millisecond
)

// sidecarQuitting is set once this process starts shutting down, so a launch
// that reaches it waits for it to exit instead of handing off to it.
var sidecarQuitting atomic.Bool

// instanceHandOff is what a launch does about an instance that is already
// running.
type instanceHandOff int

const (
	// handOffShow is a plain launch: ask the running instance to show itself,
	// then exit.
	handOffShow instanceHandOff = iota
	// handOffDetect exits on reaching a running instance without opening
	// anything. For --token, which the running instance would ignore.
	handOffDetect
	// handOffNever only waits for the lock. For an in-app relaunch, whose
	// running instance is the one exiting to make room for it.
	handOffNever
)

// instanceLock is the platform half of the guard.
type instanceLock interface {
	// tryAcquire claims the lock without blocking. held reports that another
	// process owns it; err means the platform could not answer at all.
	tryAcquire() (held bool, err error)
	// handOff reports whether a running instance that is not shutting down
	// answered, and with show also asks it to bring its dashboard forward.
	// False means no instance is ready to answer (still starting, shutting
	// down, or hung).
	handOff(show bool) bool
}

// claimSingleInstance reports whether this process should go on starting. A
// lock that stays held for longer than wait ends the launch.
//
// The wait is measured on now rather than counted in polls, because a hand-off
// to a busy instance can block for a while on its own.
//
// A platform error fails open and is returned for the caller to log once
// logging is up: refusing to start over a broken lock would turn a duplicate
// sidecar into no sidecar.
func claimSingleInstance(lock instanceLock, mode instanceHandOff, wait, poll time.Duration,
	now func() time.Time, sleep func(time.Duration)) (start bool, err error) {
	deadline := now().Add(wait)
	for {
		// Hand-off comes first so a running sidecar from before this guard
		// existed (no lock, but a tray window) is still found.
		if mode != handOffNever && lock.handOff(mode == handOffShow) {
			return false, nil
		}
		held, err := lock.tryAcquire()
		if err != nil {
			return true, err
		}
		if !held {
			return true, nil
		}
		if !now().Before(deadline) {
			return false, nil
		}
		sleep(poll)
	}
}
