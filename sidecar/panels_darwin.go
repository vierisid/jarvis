//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

static void jarvis_panel_apply_flags(
    void* nswindow_ptr,
    int alwaysOnTop,
    int clickThrough,
    int transparent,
    int frameless,
    int resizable
) {
    if (!nswindow_ptr) return;
    NSWindow* w = (__bridge NSWindow*)nswindow_ptr;

    if (alwaysOnTop) {
        [w setLevel:NSFloatingWindowLevel];
        [w setCollectionBehavior:
            NSWindowCollectionBehaviorCanJoinAllSpaces |
            NSWindowCollectionBehaviorTransient |
            NSWindowCollectionBehaviorIgnoresCycle];
        [w setHidesOnDeactivate:NO];
    }
    if (clickThrough) {
        [w setIgnoresMouseEvents:YES];
    }
    if (transparent) {
        [w setOpaque:NO];
        [w setBackgroundColor:[NSColor clearColor]];
        [w setHasShadow:NO];
    }
    if (frameless) {
        NSUInteger mask = [w styleMask];
        mask |= NSWindowStyleMaskBorderless;
        mask &= ~(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable);
        if (resizable) {
            mask |= NSWindowStyleMaskResizable;
        } else {
            mask &= ~NSWindowStyleMaskResizable;
        }
        [w setStyleMask:mask];
        [w setTitlebarAppearsTransparent:YES];
        [w setTitleVisibility:NSWindowTitleHidden];
        [w setMovableByWindowBackground:YES];
    }
}

static void jarvis_panel_focus(void* nswindow_ptr) {
    if (!nswindow_ptr) return;
    NSWindow* w = (__bridge NSWindow*)nswindow_ptr;
    [NSApp activateIgnoringOtherApps:YES];
    [w makeKeyAndOrderFront:nil];
}

static void jarvis_panel_destroy(void* nswindow_ptr) {
    if (!nswindow_ptr) return;
    NSWindow* w = (__bridge NSWindow*)nswindow_ptr;
    [w close];
}

// 0=normal, 1=minimized, 2=maximized — matches platformSetWindowState.
static void jarvis_panel_set_window_state(void* nswindow_ptr, int state) {
    if (!nswindow_ptr) return;
    NSWindow* w = (__bridge NSWindow*)nswindow_ptr;
    if (state == 1) {
        [w miniaturize:nil];
    } else if (state == 2) {
        if ([w isMiniaturized]) [w deminiaturize:nil];
        if (![w isZoomed]) [w zoom:nil];
    } else {
        if ([w isMiniaturized]) [w deminiaturize:nil];
        if ([w isZoomed]) [w zoom:nil];
        [w makeKeyAndOrderFront:nil];
    }
}

static void jarvis_panel_set_visible(void* nswindow_ptr, int visible) {
    if (!nswindow_ptr) return;
    NSWindow* w = (__bridge NSWindow*)nswindow_ptr;
    if (visible) [w makeKeyAndOrderFront:nil]; else [w orderOut:nil];
}

static void jarvis_panel_set_click_through(void* nswindow_ptr, int clickThrough) {
    if (!nswindow_ptr) return;
    NSWindow* w = (__bridge NSWindow*)nswindow_ptr;
    [w setIgnoresMouseEvents:(clickThrough ? YES : NO)];
}

// Returns cursor position in screen coordinates with origin at top-left
// (Cocoa native is bottom-left; we flip Y so the value matches the
// cross-platform contract used by the tracker goroutine).
static void jarvis_panel_cursor_pos(int* x, int* y) {
    NSPoint p = [NSEvent mouseLocation];
    NSScreen* main = [[NSScreen screens] firstObject];
    CGFloat screenH = main ? main.frame.size.height : 0;
    *x = (int)p.x;
    *y = (int)(screenH - p.y);
}

static void jarvis_panel_move_window(void* nswindow_ptr, int x, int y) {
    if (!nswindow_ptr) return;
    NSWindow* w = (__bridge NSWindow*)nswindow_ptr;
    NSRect frame = [w frame];
    NSScreen* main = [[NSScreen screens] firstObject];
    CGFloat screenH = main ? main.frame.size.height : 0;
    NSPoint origin = NSMakePoint((CGFloat)x, screenH - (CGFloat)y - frame.size.height);
    [w setFrameOrigin:origin];
    // Re-assert floating level + order in front so the window stays above
    // other apps even if they were promoted to floating.
    [w setLevel:NSFloatingWindowLevel];
    [w orderFrontRegardless];
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func boolToCInt(b bool) C.int {
	if b {
		return 1
	}
	return 0
}

func applyPlatformFlags(handle unsafe.Pointer, spec PanelSpec) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	C.jarvis_panel_apply_flags(
		handle,
		boolToCInt(spec.AlwaysOnTop),
		boolToCInt(spec.ClickThrough),
		boolToCInt(spec.Transparent),
		boolToCInt(spec.Frameless),
		boolToCInt(spec.Resizable),
	)
	return nil
}

func platformFocusWindow(handle unsafe.Pointer) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	C.jarvis_panel_focus(handle)
	return nil
}

func platformGetCursorPos() (int, int, error) {
	var x, y C.int
	C.jarvis_panel_cursor_pos(&x, &y)
	return int(x), int(y), nil
}

func platformMoveWindow(handle unsafe.Pointer, x, y int) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	C.jarvis_panel_move_window(handle, C.int(x), C.int(y))
	return nil
}

// platformGetWindowRect — macOS port deferred (needs an NSWindow.frame
// reader bridge). Returning an error here causes the poll to skip
// without spamming the daemon. W3 state persistence is Windows-first.
func platformGetWindowRect(handle unsafe.Pointer) (int, int, int, int, error) {
	return 0, 0, 0, 0, fmt.Errorf("platformGetWindowRect not implemented on darwin")
}

// platformMoveWindowKeepZOrder — on macOS there's no global topmost
// concept the way Win32 has; platformMoveWindow already preserves
// order. Forwarding keeps the cross-platform API parity.
func platformMoveWindowKeepZOrder(handle unsafe.Pointer, x, y int) error {
	return platformMoveWindow(handle, x, y)
}

// platformSetInteractiveRegions on macOS is non-trivial (requires custom
// NSView hit-testing + masking) — deferred to a follow-up. For now this
// is a no-op; the entire window stays interactive and visible.
func platformSetInteractiveRegions(handle unsafe.Pointer, rects []PanelRect) error {
	return nil
}

func platformSetClickThrough(handle unsafe.Pointer, clickThrough bool) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	C.jarvis_panel_set_click_through(handle, boolToCInt(clickThrough))
	return nil
}

func platformGetScreenSize() (int, int) {
	// Stub — fullscreen mode is currently Windows-only.
	return 1920, 1080
}

func platformGetVirtualScreenOrigin() (int, int) {
	return 0, 0
}

func platformReassertTopmost(handle unsafe.Pointer) error {
	// macOS NSWindow level reassertion; reuses the same C bridge.
	if handle == nil {
		return nil
	}
	C.jarvis_panel_focus(handle)
	return nil
}

func platformDestroyWindow(handle unsafe.Pointer) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	C.jarvis_panel_destroy(handle)
	return nil
}

func platformSetWindowState(handle unsafe.Pointer, state PanelWindowState) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	var s C.int
	switch state {
	case PanelWindowMinimized:
		s = 1
	case PanelWindowMaximized:
		s = 2
	case PanelWindowNormal:
		s = 0
	default:
		return fmt.Errorf("unknown window state: %q", state)
	}
	C.jarvis_panel_set_window_state(handle, s)
	return nil
}

// platformWindowAlive — best-effort on macOS. Returns true so the Windows-only
// close watcher is a no-op here.
func platformWindowAlive(handle unsafe.Pointer) bool { return handle != nil }

func platformSetWindowVisible(handle unsafe.Pointer, visible bool) error {
	if handle == nil {
		return fmt.Errorf("nil NSWindow*")
	}
	v := C.int(0)
	if visible {
		v = 1
	}
	C.jarvis_panel_set_visible(handle, v)
	return nil
}
