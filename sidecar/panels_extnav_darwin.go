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
// once any panel has opened. The popup SETTING added below is per-view, though,
// so those other windows still route only a gestured window.open -- and they are
// never told otherwise, since only panels_runtime.go injects the page flag. That is an improvement — it also un-breaks
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
#cgo darwin CFLAGS: -x objective-c -fobjc-arc
#cgo darwin LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

extern void goPanelOpenExternal(char* url);

static const char kJarvisPanelDelegateKey;

// Returns 0 when the view will route a DEFERRED window.open to the system
// browser, non-zero when it will not: 1 the engine's UI-delegate class is not
// registered (a re-vendor that renamed it surfaces here rather than silently),
// 2 the view has no UI delegate to route through, 3 the popup setting did not
// take. Every non-zero case must stop the caller telling the page we handle
// its new windows, because a page that believes that shows the user nothing.
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
    if (wkwebview) {
        // ARC is on for this package (cgo merges every file's CFLAGS, and the
        // other darwin files pass -fobjc-arc), so the void* the engine hands
        // back needs an explicit bridge. __bridge, not __bridge_transfer: the
        // controller is owned by the engine, we must not take a reference.
        WKWebView* v = (__bridge WKWebView*)wkwebview;

        // Let a DEFERRED window.open reach the delegate above.
        //
        // This preference defaults to NO, which refuses any window.open not
        // tied to a live user gesture -- and WebKit refuses it OUTRIGHT, without
        // consulting the UI delegate, so the method added above never runs and
        // no browser opens. The onboarding wizard's Google step is exactly that
        // shape: it awaits /api/auth/google/status for the connect URL and only
        // then calls window.open, by which point the click's gesture window has
        // closed. The Integrations tab works because it uses a plain <a>.
        //
        // Popup blocking earns nothing here: every new window this engine is
        // asked for is handed to the system browser and none is ever rendered,
        // so the preference only decides whether the user's browser opens or
        // nothing happens at all.
        //
        // PER-VIEW, unlike the delegate method above, which lands on the shared
        // engine class. Each panel sets it for itself.
        //
        // READ BACK, not fire-and-forget. -[WKWebView configuration] is
        // documented to return a COPY, so whether this write reaches the live
        // page depends on that copy sharing its WKPreferences by reference. It
        // does today, but if it ever stops, the write lands on a throwaway
        // object, macOS behaves exactly as it did before the fix, and the flag
        // the caller injects would suppress the fallback message on top of it --
        // turning a visible bug into a silent one. Reading it back through a
        // fresh `configuration` costs nothing and makes that case reportable.
        v.configuration.preferences.javaScriptCanOpenWindowsAutomatically = YES;
        if (!v.configuration.preferences.javaScriptCanOpenWindowsAutomatically) {
            return 3;
        }

        // Pin the engine's (weak, autoreleased) delegate to the view's lifetime.
        // No delegate means nothing to route through, whatever the class has:
        // say so rather than reporting a hand-off that cannot happen.
        id d = v.UIDelegate;
        if (!d) return 2;
        objc_setAssociatedObject(v, &kJarvisPanelDelegateKey, d,
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return 0;
}
*/
import "C"

import (
	"log"

	webview "github.com/webview/webview_go"
)

func installPanelExternalNav(wv webview.WebView) bool {
	// Gate on the engine being up (the delegate class is registered when it
	// builds its webview); the method is added to the class, not this view.
	ctrl := webview.BrowserController(wv)
	if ctrl == nil {
		log.Printf("[panels] no browser controller; window.open will not route to the system browser")
		return false
	}
	switch C.jarvisInstallPanelExtNav(ctrl) {
	case 0:
		return true
	case 1:
		log.Printf("[panels] WebviewWKUIDelegate class not found; window.open will not route to the system browser")
	case 2:
		log.Printf("[panels] panel webview has no UI delegate; window.open will not route to the system browser")
	case 3:
		log.Printf("[panels] could not allow automatic window.open; deferred opens will not route to the system browser")
	}
	return false
}
