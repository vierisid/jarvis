//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>
#include <stdlib.h>

// Show a native warning alert. NSAlert must run on the main thread; we marshal
// onto the main queue (the tray's [NSApp run] loop pumps it) and run it modally
// there. Fire-and-forget so the caller's goroutine isn't blocked.
static void jarvisShowAlert(const char* title, const char* message) {
    NSString* t = [NSString stringWithUTF8String:title];
    NSString* m = [NSString stringWithUTF8String:message];
    dispatch_async(dispatch_get_main_queue(), ^{
        NSAlert* a = [[NSAlert alloc] init];
        a.messageText = t;
        a.informativeText = m;
        a.alertStyle = NSAlertStyleWarning;
        [a addButtonWithTitle:@"OK"];
        [a runModal];
    });
}
*/
import "C"

import "unsafe"

func platformShowAlert(title, message string) {
	ct := C.CString(title)
	cm := C.CString(message)
	defer C.free(unsafe.Pointer(ct))
	defer C.free(unsafe.Pointer(cm))
	C.jarvisShowAlert(ct, cm)
}
