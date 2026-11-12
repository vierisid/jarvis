//go:build windows

package main

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// The notch's keys on Windows: a low-level keyboard hook.
//
// A hook, because the keys are pairs of modifiers held and let go, and a
// registered hotkey only says "pressed". It is built like the input recorder's
// hooks (recorder_windows.go): its own thread pumping messages, every function
// the callback calls resolved before the hook goes in, and a callback that
// does as little as it can, because Windows waits on it before any key goes
// anywhere. Nothing is logged from inside it.
//
// What the callback looks at: whether a key is Esc, a modifier, or "another
// key" (notch_keys_winlogic.go). It never passes on, logs or keeps which other
// key it was.
//
// What it changes: Esc is kept from the app in front while the notch has
// something Esc would close, and never otherwise. No other key is ever kept.
// When a pair has been understood, one harmless key is sent, so that letting
// go of the Windows key or Alt does not open the Start menu or the menu bar.

const (
	notchWhKeyboardLL = 13
	notchWmKeyDown    = 0x0100
	notchWmSysKeyDown = 0x0104
	notchWmTimer      = 0x0113

	// Twice a second the watch checks the keys it believes are down against
	// what Windows says (notchWinWatch.heal).
	notchKeysHealMs = 500
	// And every this many checks, while no key is down, the hook is put back.
	// Windows takes a low-level hook away, without a word, if its callback is
	// ever too slow, and there is no way to ask whether that happened.
	notchKeysRenewEvery = 120
)

var (
	procNotchSetTimer  = user32.NewProc("SetTimer")
	procNotchKillTimer = user32.NewProc("KillTimer")
)

// notchKbdEvent mirrors Win32 KBDLLHOOKSTRUCT.
type notchKbdEvent struct {
	VkCode    uint32
	ScanCode  uint32
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

// One callback for the life of the process: a Windows callback made from Go is
// never given back, so it is made once and pointed at the watch of the moment.
var (
	notchKeyHookOnce sync.Once
	notchKeyHookProc uintptr
	notchKeyWatchNow atomic.Pointer[notchWinWatch]
)

func notchKeyHook(nCode int32, wParam uintptr, lParam uintptr) uintptr {
	if nCode == 0 {
		if w := notchKeyWatchNow.Load(); w != nil {
			// The documented exception to vet's unsafe.Pointer rule: lParam IS
			// a pointer, handed over by Windows for the length of this call.
			ev := (*notchKbdEvent)(unsafe.Pointer(lParam))
			down := wParam == notchWmKeyDown || wParam == notchWmSysKeyDown
			if w.see(notchWinKey{Vk: ev.VkCode, Scan: ev.ScanCode, Flags: ev.Flags, Extra: ev.ExtraInfo, Down: down}) {
				return 1
			}
		}
	}
	ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
	return ret
}

func notchKeyHeld(vk uint32) bool {
	state, _, _ := procGetAsyncKeyState.Call(uintptr(vk))
	return state&asyncKeyHeldHi != 0
}

// notchSendMask sends the harmless key, down and up, marked as ours.
func notchSendMask() {
	_ = sendInputs([]kbdInput{
		{inputType: inputKeyboard, vk: notchVkMask, extraInfo: notchKeyTag},
		{inputType: inputKeyboard, vk: notchVkMask, flags: keyeventfKeyUp, extraInfo: notchKeyTag},
	})
}

// notchWarmKeyProcs resolves every function the callback can reach before the
// hook goes in. The first call of a function looks it up in its DLL, and that
// must not happen inside a callback Windows is timing.
func notchWarmKeyProcs() error {
	for _, p := range []*syscall.LazyProc{procCallNextHookEx, procGetAsyncKeyState, procSendInput} {
		if err := p.Find(); err != nil {
			return fmt.Errorf("resolving %s: %w", p.Name, err)
		}
	}
	return nil
}

// platformNotchKeysAvailable says whether the keys can be watched here.
func platformNotchKeysAvailable() string { return notchKeysWatch }

// platformNotchKeysStart installs the hook on a thread of its own. The
// function it returns takes the hook away and ends the thread.
func platformNotchKeysStart(kb *notchKeyboard) (stop func(), err error) {
	if err := notchWarmKeyProcs(); err != nil {
		return nil, err
	}
	notchKeyHookOnce.Do(func() { notchKeyHookProc = syscall.NewCallback(notchKeyHook) })

	// What the keys said goes to the page from one goroutine of its own: the
	// callback never waits on the page's window, and "talk ended" can never
	// overtake "talk started".
	//
	// The harmless key is sent from there too, and not from inside the
	// callback. Inside, it would enter the stream BEFORE the key-down the
	// callback is still deciding on, and so would not lie between that key's
	// down and its up: tapping Alt then Win would still open Start. Sent just
	// after, it lies inside both.
	said := make(chan notchKeyAction, 32)
	masks := make(chan struct{}, 4)
	done := make(chan struct{})
	deliver := kb.say
	kb.say = func(action notchKeyAction) {
		select {
		case said <- action:
		default:
			// The page is not taking them. Dropping one is better than holding
			// up every key on the machine.
		}
	}
	kb.mask = func() {
		select {
		case masks <- struct{}{}:
		default:
		}
	}
	go func() {
		for {
			select {
			case <-done:
				return
			case <-masks:
				notchSendMask()
			case action := <-said:
				if deliver != nil {
					deliver(action)
				}
			}
		}
	}()

	type started struct {
		tid uint32
		err error
	}
	ready := make(chan started, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		tid, _, _ := procGetCurrentThread.Call()
		hMod, _, _ := procGetModuleHandleW.Call(0)
		install := func() (uintptr, error) {
			h, _, callErr := procSetWindowsHookExW.Call(uintptr(notchWhKeyboardLL), notchKeyHookProc, hMod, 0)
			if h == 0 {
				return 0, fmt.Errorf("the keyboard hook could not be installed: %v", callErr)
			}
			return h, nil
		}
		watch := &notchWinWatch{feed: kb.key, held: notchKeyHeld}
		hook, err := install()
		if err != nil {
			ready <- started{err: err}
			return
		}
		notchKeyWatchNow.Store(watch)
		timer, _, _ := procNotchSetTimer.Call(0, 0, notchKeysHealMs, 0)
		ready <- started{tid: uint32(tid)}
		renewed, ticks := 0, 0
		for {
			var msg w32Msg
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			// 0 is WM_QUIT, -1 an error: either way the loop is over.
			if r == 0 || int32(r) == -1 {
				break
			}
			if msg.Message != notchWmTimer {
				continue
			}
			// This runs on the hook's own thread, between two keys, so it
			// never meets the callback half way.
			watch.heal()
			ticks++
			if ticks < notchKeysRenewEvery || !watch.idle() {
				continue
			}
			ticks = 0
			// Put the hook back while nothing is held.
			if fresh, err := install(); err == nil {
				procUnhookWindowsHookEx.Call(hook)
				hook = fresh
				renewed++
			}
		}
		if timer != 0 {
			procNotchKillTimer.Call(0, timer)
		}
		notchKeyWatchNow.CompareAndSwap(watch, nil)
		procUnhookWindowsHookEx.Call(hook)
		log.Printf("[notch] keys: no longer watching (the watch was renewed %d times)", renewed)
	}()

	s := <-ready
	if s.err != nil {
		close(done)
		kb.say = deliver
		return nil, s.err
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			procPostThreadMsg.Call(uintptr(s.tid), wmQuit, 0, 0)
			<-finished
			close(done)
		})
	}, nil
}
