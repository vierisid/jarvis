//go:build darwin

package main

// macOS: route the panel webview's window.open / target=_blank to the system
// browser (see panels_extnav.go). WKWebView asks its UI delegate to build a
// sub-view for such requests via
// -webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:.
// The vendored engine's own delegate (WebviewWKUIDelegate) does not implement
// it, so we ADD that method to that class rather than swap the delegate out —
// which keeps the engine's file-open panel (its one delegate method) working
// and sidesteps UIDelegate's weak reference. The added method opens the URL
// externally and returns nil (no nested webview). Idempotent: added once.
//
// PROCESS-WIDE, unlike the per-view Windows/Linux hooks: the method lands on the
// shared engine class, so EVERY webview the vendored engine builds (panels, and
// also the settings / log / hosted windows) gains this window.open behaviour
// once any panel has opened. That is an improvement — it also un-breaks
// window.open in the hosted sign-in shell — but it is not panel-scoped; don't
// assume parity with the other two platforms.
//
// Delegate lifetime: WKWebView.UIDelegate is a WEAK reference and the engine
// assigns it an autoreleased instance, so we pin that instance to the view (an
// associated object) — otherwise the pool could drain it, the delegate would go
// nil, and neither this method nor the engine's file panel would ever fire.
//
// COMPILE-UNVERIFIED: CGO/ObjC, built only on macOS — it cannot be compiled or
// run in the Linux dev box and must be checked on a Mac, same caveat as
// tray_darwin.go. In particular the delegate-lifetime pinning above needs a
// runtime check that window.open actually reaches the browser.

/*
#cgo darwin CFLAGS: -x objective-c
#cgo darwin LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

extern void goPanelOpenExternal(char* url);

static const char kJarvisPanelDelegateKey;

// Returns 0 on success, 1 if the engine's UI-delegate class is not registered
// yet (a re-vendor that renamed it would surface here rather than silently).
static int jarvisInstallPanelExtNav(void* wkwebview) {
    Class cls = objc_getClass("WebviewWKUIDelegate");
    if (!cls) return 1;
    SEL sel = @selector(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:);
    if (!class_getInstanceMethod(cls, sel)) {
        IMP imp = imp_implementationWithBlock(^WKWebView*(id self, WKWebView* wv,
                WKWebViewConfiguration* cfg, WKNavigationAction* action,
                WKWindowFeatures* features) {
            (void)self; (void)wv; (void)cfg; (void)features;
            NSURL* url = action.request.URL;
            if (url) {
                const char* s = [[url absoluteString] UTF8String];
                if (s) goPanelOpenExternal((char*)s);
            }
            return nil; // do not open a nested webview
        });
        class_addMethod(cls, sel, imp, "@@:@@@@");
    }
    // Pin the engine's (weak, autoreleased) delegate to the view's lifetime.
    if (wkwebview) {
        WKWebView* v = (WKWebView*)wkwebview;
        id d = v.UIDelegate;
        if (d) {
            objc_setAssociatedObject(v, &kJarvisPanelDelegateKey, d,
                                     OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
    }
    return 0;
}
*/
import "C"

import (
	"log"

	webview "github.com/webview/webview_go"
)

func installPanelExternalNav(wv webview.WebView) {
	// Gate on the engine being up (the delegate class is registered when it
	// builds its webview); the method is added to the class, not this view.
	ctrl := webview.BrowserController(wv)
	if ctrl == nil {
		log.Printf("[panels] no browser controller; window.open will not route to the system browser")
		return
	}
	if C.jarvisInstallPanelExtNav(ctrl) != 0 {
		log.Printf("[panels] WebviewWKUIDelegate class not found; window.open will not route to the system browser")
	}
}
