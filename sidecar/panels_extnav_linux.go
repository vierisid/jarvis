//go:build linux

package main

// Linux: route the panel webview's window.open / target=_blank to the system
// browser (see panels_extnav.go). WebKitGTK emits "create" when a page wants a
// new WebKitWebView (window.open, a target=_blank link); the vendored engine
// connects no handler, so we add one that opens the URL externally and returns
// NULL — no nested webview. The //export sink lives in the bridge file so this
// file's preamble may carry the C definitions (cgo forbids both together).

/*
#cgo pkg-config: gtk+-3.0 webkit2gtk-4.0
#include <webkit2/webkit2.h>

extern void goPanelOpenExternal(char* url);

static GtkWidget* jarvisPanelOnCreate(WebKitWebView* web_view,
                                      WebKitNavigationAction* nav,
                                      gpointer user_data) {
    (void)web_view; (void)user_data;
    WebKitURIRequest* req = webkit_navigation_action_get_request(nav);
    if (req) {
        const gchar* uri = webkit_uri_request_get_uri(req);
        if (uri) goPanelOpenExternal((char*)uri);
    }
    return NULL;
}

// Returns 1 when the view will actually route a DEFERRED window.open, 0 when
// it will only route a gestured one. See the settings note below.
static int jarvisInstallPanelExtNav(void* webkit_view) {
    if (!webkit_view) return 0;
    WebKitWebView* view = WEBKIT_WEB_VIEW(webkit_view);
    g_signal_connect(view, "create", G_CALLBACK(jarvisPanelOnCreate), NULL);

    // Let a DEFERRED window.open reach the "create" handler above.
    //
    // WebKitGTK shares WebCore's allowPopUp check with Cocoa: a window.open is
    // refused outright, before any chrome client is consulted, unless it is
    // inside a user gesture or this setting is on. It defaults to FALSE. The
    // onboarding wizard's Google step awaits a fetch for the connect URL and
    // only then opens it, by which point the click's gesture window has closed
    // -- so without this the handler never runs, exactly as on macOS.
    WebKitSettings* settings = webkit_web_view_get_settings(view);
    if (!settings) return 0;
    webkit_settings_set_javascript_can_open_windows_automatically(settings, TRUE);
    // Read back rather than trust the write: the caller injects a flag telling
    // the page that a null from window.open means "the host took it", and a
    // setting that did not stick would turn that into a lie the user sees as
    // nothing happening at all.
    return webkit_settings_get_javascript_can_open_windows_automatically(settings) ? 1 : 0;
}
*/
import "C"

import (
	"log"

	webview "github.com/webview/webview_go"
)

func installPanelExternalNav(wv webview.WebView) bool {
	ctrl := webview.BrowserController(wv)
	if ctrl == nil {
		log.Printf("[panels] no browser controller; window.open will not route to the system browser")
		return false
	}
	if C.jarvisInstallPanelExtNav(ctrl) == 0 {
		// Gestured opens still route (the "create" handler is connected); it is
		// only the deferred ones that will not. Report false so the caller does
		// NOT tell the page we handle its new windows -- a page that believes
		// that stops showing the user the link it could not open.
		log.Printf("[panels] could not allow automatic window.open; deferred opens will not route to the system browser")
		return false
	}
	return true
}
