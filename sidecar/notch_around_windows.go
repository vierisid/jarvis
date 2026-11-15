//go:build windows

package main

import (
	"os"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

// Windows keeps, for the person's own eyes (Settings, Privacy, Microphone), a
// record of which programs used the microphone and when. It is read here, a
// few times a minute. Nothing is opened, listened to or recorded.
const notchMicRecord = `Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone`

// How often the two facts are looked at.
const notchAroundEvery = 3 * time.Second

func notchMicUseOf(parent registry.Key, name string) (notchMicUse, bool) {
	key, err := registry.OpenKey(parent, name, registry.QUERY_VALUE)
	if err != nil {
		return notchMicUse{}, false
	}
	defer key.Close()
	start, _, errStart := key.GetIntegerValue("LastUsedTimeStart")
	stop, _, errStop := key.GetIntegerValue("LastUsedTimeStop")
	if errStart != nil || errStop != nil {
		return notchMicUse{}, false
	}
	return notchMicUse{App: name, Start: start, Stop: stop}, true
}

// readNotchMicRecord gives every program in the record: the ones installed
// from the Store by their package, and the others, one level down, by path.
func readNotchMicRecord() []notchMicUse {
	root, err := registry.OpenKey(registry.CURRENT_USER, notchMicRecord, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil
	}
	defer root.Close()
	var record []notchMicUse
	names, _ := root.ReadSubKeyNames(-1)
	for _, name := range names {
		if name == "NonPackaged" {
			continue
		}
		if use, ok := notchMicUseOf(root, name); ok {
			record = append(record, use)
		}
	}
	if other, err := registry.OpenKey(root, "NonPackaged", registry.ENUMERATE_SUB_KEYS); err == nil {
		defer other.Close()
		names, _ := other.ReadSubKeyNames(-1)
		for _, name := range names {
			if use, ok := notchMicUseOf(other, name); ok {
				record = append(record, use)
			}
		}
	}
	return record
}

var procInternetGetConnectedState = syscall.NewLazyDLL("wininet.dll").NewProc("InternetGetConnectedState")

// notchOnline asks the system whether this machine has a connection. Nothing
// is sent anywhere to find out: it is what the system already knows.
func notchOnline() bool {
	var flags uint32
	ok, _, _ := procInternetGetConnectedState.Call(uintptr(unsafe.Pointer(&flags)), 0)
	return ok != 0
}

func platformNotchAroundStart(a *NotchAround) {
	self, _ := os.Executable()
	go func() {
		for {
			a.SetCall(notchOnCall(readNotchMicRecord(), self, time.Now()))
			a.SetOnline(notchOnline())
			time.Sleep(notchAroundEvery)
		}
	}()
}
