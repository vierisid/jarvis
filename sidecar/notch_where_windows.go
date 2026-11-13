//go:build windows

package main

// Where the person is, on Windows: heard from the system, not asked for.
//
// A window event hook says the moment another window comes to the front or
// the keyboard moves to another control. From that this file reads which
// program it is, its name, its window's title and its own icon, and whether
// the control that has the keyboard is a password field. The decisions made
// from it are in notch_where.go.
//
// The hook has a thread of its own. The notch's key watch has one too, but
// Windows takes a keyboard hook away from a thread that answers slowly, so
// nothing else is put on that one.

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"log"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	whereUser32  = syscall.NewLazyDLL("user32.dll")
	whereShell32 = syscall.NewLazyDLL("shell32.dll")
	whereGdi32   = syscall.NewLazyDLL("gdi32.dll")
	whereVersion = syscall.NewLazyDLL("version.dll")

	procWhereSetWinEventHook = whereUser32.NewProc("SetWinEventHook")
	procWhereUnhookWinEvent  = whereUser32.NewProc("UnhookWinEvent")
	procWhereGetMessage      = whereUser32.NewProc("GetMessageW")
	procWherePostThreadMsg   = whereUser32.NewProc("PostThreadMessageW")
	procWhereEnumChild       = whereUser32.NewProc("EnumChildWindows")
	procWhereGetClassName    = whereUser32.NewProc("GetClassNameW")
	procWhereGetWindowLong   = whereUser32.NewProc("GetWindowLongW")
	procWhereGetIconInfo     = whereUser32.NewProc("GetIconInfo")
	procWhereDestroyIcon     = whereUser32.NewProc("DestroyIcon")
	procWhereGetDC           = whereUser32.NewProc("GetDC")
	procWhereReleaseDC       = whereUser32.NewProc("ReleaseDC")
	procWhereSHGetFileInfo   = whereShell32.NewProc("SHGetFileInfoW")
	procWhereGetDIBits       = whereGdi32.NewProc("GetDIBits")
	procWhereGetObject       = whereGdi32.NewProc("GetObjectW")
	procWhereDeleteObject    = whereGdi32.NewProc("DeleteObject")
	procWhereVerSize         = whereVersion.NewProc("GetFileVersionInfoSizeW")
	procWhereVerInfo         = whereVersion.NewProc("GetFileVersionInfoW")
	procWhereVerQuery        = whereVersion.NewProc("VerQueryValueW")
	procWhereThreadID        = kernel32.NewProc("GetCurrentThreadId")
)

const (
	whereEventForeground = 0x0003 // EVENT_SYSTEM_FOREGROUND
	whereEventFocus      = 0x8005 // EVENT_OBJECT_FOCUS
	whereOutOfContext    = 0x0000 // WINEVENT_OUTOFCONTEXT
	whereSkipOwnProcess  = 0x0002 // WINEVENT_SKIPOWNPROCESS
	whereWmQuit          = 0x0012
)

// Where the hook's callback puts what it heard. The callback does nothing
// else: it runs on the hook's thread, between two messages.
var (
	whereSignals  atomic.Pointer[chan byte]
	whereHookOnce sync.Once
	whereHookProc uintptr
)

// notchWhereHook is the callback of both hooks. 'f': another window is in
// front. 'k': the keyboard went to another control.
func notchWhereHook(hook, event, hwnd, idObject, idChild, thread, when uintptr) uintptr {
	ch := whereSignals.Load()
	if ch == nil {
		return 0
	}
	kind := byte('k')
	if event == whereEventForeground {
		kind = 'f'
	}
	select {
	case *ch <- kind:
	default: // One is waiting already: it will read the same state.
	}
	return 0
}

// whereApp is what is known about a program, read once per program file.
type whereApp struct {
	key, name string
	icon      []byte
}

// platformNotchWhereStart starts hearing where the person is and telling w.
// The function it returns stops it.
func platformNotchWhereStart(w *NotchWhere) (stop func()) {
	signals := make(chan byte, 4)
	whereSignals.Store(&signals)
	quit := make(chan struct{})
	ready := make(chan uint32, 1)
	hookDone := make(chan struct{})

	go func() {
		defer close(hookDone)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		tid, _, _ := procWhereThreadID.Call()
		whereHookOnce.Do(func() { whereHookProc = syscall.NewCallback(notchWhereHook) })
		front, _, _ := procWhereSetWinEventHook.Call(whereEventForeground, whereEventForeground, 0, whereHookProc, 0, 0, whereOutOfContext|whereSkipOwnProcess)
		focus, _, _ := procWhereSetWinEventHook.Call(whereEventFocus, whereEventFocus, 0, whereHookProc, 0, 0, whereOutOfContext|whereSkipOwnProcess)
		if front == 0 {
			// Without it the worker's own look once a second still finds the app.
			log.Printf("[notch] could not hear window changes from Windows; the front app is looked up once a second instead")
		}
		ready <- uint32(tid)
		var msg [64]byte // room for a MSG
		for {
			r, _, _ := procWhereGetMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
			if int32(r) <= 0 {
				break
			}
		}
		if front != 0 {
			procWhereUnhookWinEvent.Call(front)
		}
		if focus != 0 {
			procWhereUnhookWinEvent.Call(focus)
		}
	}()
	tid := <-ready

	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		apps := map[string]whereApp{}
		password := false
		look := time.NewTicker(time.Second)
		defer look.Stop()
		hands := time.NewTicker(500 * time.Millisecond)
		defer hands.Stop()
		read := func(ask bool) {
			if ask {
				password = notchPasswordFocused(password, signals)
			}
			notchWhereRead(w, apps, password)
		}
		read(true)
		for {
			select {
			case <-quit:
				return
			case <-signals:
				// A window change comes as several events at once. Let them land.
				time.Sleep(30 * time.Millisecond)
				for drained := false; !drained; {
					select {
					case <-signals:
					default:
						drained = true
					}
				}
				read(true)
			case <-look.C:
				// A title changes without any of the events above: another tab,
				// another page. Reading it is one call.
				read(false)
			case <-hands.C:
				w.SetStill(notchIdleMs() >= notchStillMs)
			}
		}
	}()

	var once sync.Once
	return func() {
		once.Do(func() {
			close(quit)
			procWherePostThreadMsg.Call(uintptr(tid), whereWmQuit, 0, 0)
			<-hookDone
			<-workerDone
			whereSignals.Store(nil)
		})
	}
}

// notchWhereRead reads the window in front and tells w.
func notchWhereRead(w *NotchWhere, apps map[string]whereApp, password bool) {
	front := win32GetForegroundWindow()
	// The notch itself coming to the front (its text field) is not somewhere
	// the person went: they are still where they were.
	if front == 0 || ownWindow(front) {
		return
	}
	pid := win32GetWindowPid(front)
	path := processImagePath(pid)
	// Calculator, Settings and the Store all live inside one host program.
	// The program that is really the app owns a window inside its frame.
	if strings.EqualFold(filepath.Base(strings.ReplaceAll(path, `\`, "/")), "ApplicationFrameHost.exe") {
		if hosted := whereHostedPid(front, pid); hosted != 0 {
			if hostedPath := processImagePath(hosted); hostedPath != "" {
				path = hostedPath
			}
		}
	}
	title := win32WindowTitle(front)
	if path == "" {
		// A program that cannot be asked about (it runs as administrator):
		// named by what Windows will say of it.
		name := processBaseName(pid)
		w.SetFront(notchFront{App: name, Name: whereTitleCase(name), Title: title, Password: password}, nil)
		return
	}
	app, known := apps[path]
	if !known {
		base := strings.TrimSuffix(filepath.Base(strings.ReplaceAll(path, `\`, "/")), filepath.Ext(path))
		app = whereApp{key: notchAppKey(base), name: exeDisplayName(path), icon: exeIconPNG(path)}
		if app.name == "" {
			app.name = whereTitleCase(base)
		}
		if len(apps) > 200 {
			for old := range apps {
				delete(apps, old)
			}
		}
		apps[path] = app
	}
	w.SetFront(notchFront{App: app.key, Name: app.name, Title: title, Password: password}, app.icon)
}

func whereTitleCase(name string) string {
	if name == "" {
		return name
	}
	return strings.ToUpper(name[:1]) + name[1:]
}

// processImagePath is the full path of a process's program, or "" when
// Windows will not say.
func processImagePath(pid uint32) string {
	const processQueryLimitedInformation = 0x1000
	if pid == 0 {
		return ""
	}
	h, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer procNativeCloseHandle.Call(h)
	var buf [1024]uint16
	size := uint32(len(buf))
	if ok, _, _ := procQueryFullImageName.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:size])
}

// The child windows of a frame are walked through a callback that cannot
// carry state, so the state is here, behind a lock.
var (
	whereChildMu   sync.Mutex
	whereChildOnce sync.Once
	whereChildProc uintptr
	whereChildSkip uint32
	whereChildPid  uint32
)

func whereChildCallback(hwnd, _ uintptr) uintptr {
	if pid := win32GetWindowPid(hwnd); pid != 0 && pid != whereChildSkip {
		whereChildPid = pid
		return 0 // found: stop
	}
	return 1
}

// whereHostedPid is the process of the app shown inside a host's frame
// window, or 0.
func whereHostedPid(frame uintptr, hostPid uint32) uint32 {
	whereChildOnce.Do(func() { whereChildProc = syscall.NewCallback(whereChildCallback) })
	whereChildMu.Lock()
	defer whereChildMu.Unlock()
	whereChildSkip, whereChildPid = hostPid, 0
	procWhereEnumChild.Call(frame, whereChildProc, 0)
	return whereChildPid
}

// exeDisplayName is what a program calls itself: the description in its
// version information ("Notepad", "Google Chrome"). "" when it has none.
func exeDisplayName(path string) string {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	var handle uint32
	size, _, _ := procWhereVerSize.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&handle)))
	if size == 0 || size > 4<<20 {
		return ""
	}
	buf := make([]byte, size)
	if ok, _, _ := procWhereVerInfo.Call(uintptr(unsafe.Pointer(p)), 0, size, uintptr(unsafe.Pointer(&buf[0]))); ok == 0 {
		return ""
	}
	defer runtime.KeepAlive(buf)
	query := func(sub string) []uint16 {
		s, err := syscall.UTF16PtrFromString(sub)
		if err != nil {
			return nil
		}
		var block unsafe.Pointer
		var n uint32
		ok, _, _ := procWhereVerQuery.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(s)), uintptr(unsafe.Pointer(&block)), uintptr(unsafe.Pointer(&n)))
		if ok == 0 || block == nil || n == 0 || n > 512 {
			return nil
		}
		return unsafe.Slice((*uint16)(block), n)
	}
	// Which language the strings are in. English (United States), Unicode, when it does not say.
	lang, page := uint16(0x0409), uint16(0x04b0)
	if t := query(`\VarFileInfo\Translation`); len(t) >= 2 {
		lang, page = t[0], t[1]
	}
	for _, field := range []string{"FileDescription", "ProductName"} {
		if value := query(fmt.Sprintf(`\StringFileInfo\%04x%04x\%s`, lang, page, field)); value != nil {
			if name := strings.TrimSpace(syscall.UTF16ToString(value)); name != "" {
				return truncateRunes(name, 60)
			}
		}
	}
	return ""
}

// exeIconPNG is a program's own icon as a PNG, or nil.
func exeIconPNG(path string) []byte {
	type shFileInfo struct {
		hIcon       uintptr
		iIcon       int32
		attributes  uint32
		displayName [260]uint16
		typeName    [80]uint16
	}
	const shgfiIcon, shgfiLargeIcon = 0x100, 0x0
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil
	}
	var info shFileInfo
	r, _, _ := procWhereSHGetFileInfo.Call(uintptr(unsafe.Pointer(p)), 0, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), shgfiIcon|shgfiLargeIcon)
	if r == 0 || info.hIcon == 0 {
		return nil
	}
	defer procWhereDestroyIcon.Call(info.hIcon)
	return iconPNG(info.hIcon)
}

// iconPNG draws an icon into a PNG. An icon is two bitmaps, a colour one and
// a mask; the colour one of every icon made in the last twenty years carries
// its own transparency, and that is the one read.
func iconPNG(hIcon uintptr) []byte {
	type iconInfo struct {
		fIcon              int32
		xHotspot, yHotspot uint32
		mask, colour       uintptr
	}
	type bitmap struct {
		bmType, width, height, widthBytes int32
		planes, bitsPixel                 uint16
		bits                              uintptr
	}
	type bitmapInfo struct {
		size                          uint32
		width, height                 int32
		planes, bitCount              uint16
		compression, sizeImage        uint32
		xPelsPerMeter, yPelsPerMeter  int32
		coloursUsed, coloursImportant uint32
		masks                         [3]uint32
	}
	var info iconInfo
	if ok, _, _ := procWhereGetIconInfo.Call(hIcon, uintptr(unsafe.Pointer(&info))); ok == 0 {
		return nil
	}
	if info.mask != 0 {
		defer procWhereDeleteObject.Call(info.mask)
	}
	if info.colour == 0 {
		return nil
	}
	defer procWhereDeleteObject.Call(info.colour)
	var bm bitmap
	if n, _, _ := procWhereGetObject.Call(info.colour, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); n == 0 {
		return nil
	}
	width, height := int(bm.width), int(bm.height)
	if width <= 0 || height <= 0 || width > 256 || height > 256 {
		return nil
	}
	// Top row first (a negative height), four bytes a pixel: blue, green, red, alpha.
	bmi := bitmapInfo{size: 40, width: int32(width), height: -int32(height), planes: 1, bitCount: 32}
	pixels := make([]byte, width*height*4)
	dc, _, _ := procWhereGetDC.Call(0)
	if dc == 0 {
		return nil
	}
	lines, _, _ := procWhereGetDIBits.Call(dc, info.colour, 0, uintptr(height), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&bmi)), 0)
	procWhereReleaseDC.Call(0, dc)
	if lines == 0 {
		return nil
	}
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	seeThrough := true
	for i := 0; i < width*height; i++ {
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = pixels[i*4+2], pixels[i*4+1], pixels[i*4], pixels[i*4+3]
		if pixels[i*4+3] != 0 {
			seeThrough = false
		}
	}
	if seeThrough {
		// An old icon with no transparency of its own: drawn solid.
		for i := 3; i < len(img.Pix); i += 4 {
			img.Pix[i] = 255
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil
	}
	return out.Bytes()
}

var wherePasswordAsking atomic.Bool

// notchPasswordFocused says whether the control that has the keyboard is a
// password field. A plain Windows edit box says so by its style. Everything
// else (a browser, a modern app) is asked through UI Automation, which can be
// slow in a program that is busy: it is given 700 ms, and if it has not
// answered the last known answer stands and its answer, when it comes, makes
// the worker look again.
func notchPasswordFocused(last bool, again chan byte) bool {
	const gwlStyle, esPassword = 0xFFFFFFF0, 0x0020 // GWL_STYLE is -16
	if gui, ok := win32ForegroundGUIInfo(); ok && gui.HwndFocus != 0 {
		var class [64]uint16
		procWhereGetClassName.Call(gui.HwndFocus, uintptr(unsafe.Pointer(&class[0])), uintptr(len(class)))
		if strings.EqualFold(syscall.UTF16ToString(class[:]), "Edit") {
			style, _, _ := procWhereGetWindowLong.Call(gui.HwndFocus, gwlStyle)
			return style&esPassword != 0
		}
	}
	// One question at a time: in a program that does not answer, more of them
	// would only wait in a row behind the first.
	if !wherePasswordAsking.CompareAndSwap(false, true) {
		return last
	}
	answer := make(chan bool, 1)
	go func() {
		defer wherePasswordAsking.Store(false)
		val, err := comThread.call(func(state *uiaState) (any, error) {
			elem, err := uiaGetFocusedElement(state.automation)
			if err != nil || elem == nil {
				return false, nil
			}
			defer elem.Release()
			return uiaElementGetPropertyBool(elem, UIA_IsPasswordPropertyId), nil
		})
		is, _ := val.(bool)
		answer <- err == nil && is
	}()
	select {
	case is := <-answer:
		return is
	case <-time.After(700 * time.Millisecond):
		go func() {
			if is := <-answer; is != last {
				select {
				case again <- 'k':
				default:
				}
			}
		}()
		return last
	}
}
