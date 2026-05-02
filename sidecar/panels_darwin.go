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
