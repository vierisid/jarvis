//go:build windows

package main

import (
	"fmt"
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

// These use the real CreateMutexW under a per-test name, so a Jarvis running on
// the same machine can't interfere. The part only Windows can prove is x/sys
// reporting an existing mutex as ERROR_ALREADY_EXISTS, which has to come out
// as "held" rather than as a failure (which would fail open and start anyway).

func testInstanceLock(t *testing.T) *windowsInstanceLock {
	return &windowsInstanceLock{name: fmt.Sprintf(`Local\Jarvis.Sidecar.Test.%d.%s`, os.Getpid(), t.Name())}
}

func TestSingleInstanceMutexSecondClaimIsHeld(t *testing.T) {
	first := testInstanceLock(t)
	held, err := first.tryAcquire()
	if err != nil || held {
		t.Fatalf("first claim: held=%v err=%v, want it free", held, err)
	}
	defer windows.CloseHandle(first.handle)

	second := testInstanceLock(t)
	held, err = second.tryAcquire()
	if err != nil || !held {
		t.Fatalf("second claim: held=%v err=%v, want it held", held, err)
	}
	if second.handle != 0 {
		t.Fatal("a held claim kept a handle to the mutex, which would keep it alive past its holder")
	}
}

// Closing the only handle stands in for the holder exiting.
func TestSingleInstanceMutexFreesWhenHolderCloses(t *testing.T) {
	first := testInstanceLock(t)
	if held, err := first.tryAcquire(); err != nil || held {
		t.Fatalf("first claim: held=%v err=%v, want it free", held, err)
	}
	windows.CloseHandle(first.handle)

	second := testInstanceLock(t)
	held, err := second.tryAcquire()
	if err != nil || held {
		t.Fatalf("claim after release: held=%v err=%v, want it free", held, err)
	}
	windows.CloseHandle(second.handle)
}
