//go:build windows

package main

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"

	ole "github.com/go-ole/go-ole"
)

// Which programs are playing sound right now.
//
// It is one of the signs the notch reads to tell a video from a page
// (notch_video.go). Windows keeps, for the default output device, a list of
// audio sessions and the process each belongs to; a session is active while
// its program has a stream running. Nothing is listened to: only "is this
// program playing" is asked.
//
// The caller's goroutine must be locked to its thread and have COM started.

var (
	notchClsidDeviceEnumerator  = ole.NewGUID("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
	notchIidDeviceEnumerator    = ole.NewGUID("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
	notchIidAudioSessionManager = ole.NewGUID("{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}") // IAudioSessionManager2
	notchIidAudioSessionControl = ole.NewGUID("{BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D}") // IAudioSessionControl2
)

// Slots in each interface's method table, after the three every COM object has.
const (
	notchVtGetDefaultAudioEndpoint = 4  // IMMDeviceEnumerator
	notchVtActivate                = 3  // IMMDevice
	notchVtGetSessionEnumerator    = 5  // IAudioSessionManager2
	notchVtGetCount                = 3  // IAudioSessionEnumerator
	notchVtGetSession              = 4  // IAudioSessionEnumerator
	notchVtGetState                = 3  // IAudioSessionControl
	notchVtGetProcessID            = 14 // IAudioSessionControl2

	notchAudioRender        = 0 // eRender: an output device
	notchAudioMultimedia    = 1 // eMultimedia: the one music and video go to
	notchClsctxAll          = 0x17
	notchAudioSessionActive = 1
)

func notchComCall(obj *ole.IUnknown, slot int, args ...uintptr) uintptr {
	table := (*[32]uintptr)(unsafe.Pointer(obj.RawVTable))
	all := make([]uintptr, 0, len(args)+1)
	all = append(all, uintptr(unsafe.Pointer(obj)))
	all = append(all, args...)
	hr, _, _ := syscall.SyscallN(table[slot], all...)
	return hr
}

// notchProgramsPlayingSound returns the programs with a running audio stream
// on the default output device, as lower-case file names without the ending.
func notchProgramsPlayingSound() ([]string, error) {
	enumerator, err := ole.CreateInstance(notchClsidDeviceEnumerator, notchIidDeviceEnumerator)
	if err != nil || enumerator == nil {
		return nil, fmt.Errorf("audio device list: %v", err)
	}
	defer enumerator.Release()

	var device *ole.IUnknown
	if hr := notchComCall(enumerator, notchVtGetDefaultAudioEndpoint,
		notchAudioRender, notchAudioMultimedia, uintptr(unsafe.Pointer(&device))); hr != 0 || device == nil {
		// No output device at all is not an error: nothing is playing.
		return nil, nil
	}
	defer device.Release()

	var manager *ole.IUnknown
	if hr := notchComCall(device, notchVtActivate,
		uintptr(unsafe.Pointer(notchIidAudioSessionManager)), notchClsctxAll, 0,
		uintptr(unsafe.Pointer(&manager))); hr != 0 || manager == nil {
		return nil, fmt.Errorf("audio session manager: %#x", hr)
	}
	defer manager.Release()

	var sessions *ole.IUnknown
	if hr := notchComCall(manager, notchVtGetSessionEnumerator, uintptr(unsafe.Pointer(&sessions))); hr != 0 || sessions == nil {
		return nil, fmt.Errorf("audio session list: %#x", hr)
	}
	defer sessions.Release()

	var count int32
	if hr := notchComCall(sessions, notchVtGetCount, uintptr(unsafe.Pointer(&count))); hr != 0 {
		return nil, fmt.Errorf("audio session count: %#x", hr)
	}
	var playing []string
	for i := int32(0); i < count && i < 256; i++ {
		var control *ole.IUnknown
		if hr := notchComCall(sessions, notchVtGetSession, uintptr(i), uintptr(unsafe.Pointer(&control))); hr != 0 || control == nil {
			continue
		}
		if name := notchSessionProgram(control); name != "" {
			playing = append(playing, name)
		}
		control.Release()
	}
	return playing, nil
}

// notchSessionProgram is the program behind one audio session if that session
// is playing, else "".
func notchSessionProgram(control *ole.IUnknown) string {
	var state int32
	if hr := notchComCall(control, notchVtGetState, uintptr(unsafe.Pointer(&state))); hr != 0 || state != notchAudioSessionActive {
		return ""
	}
	control2, err := control.QueryInterface(notchIidAudioSessionControl)
	if err != nil || control2 == nil {
		return ""
	}
	defer control2.Release()
	var pid uint32
	// The system sounds session answers with a status that is not zero and
	// process 0. Neither is a program.
	notchComCall(&control2.IUnknown, notchVtGetProcessID, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return ""
	}
	return strings.ToLower(processBaseName(pid))
}
