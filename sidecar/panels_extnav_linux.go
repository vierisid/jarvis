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

static void jarvisInstallPanelExtNav(void* webkit_view) {
    if (!webkit_view) return;
    g_signal_connect(WEBKIT_WEB_VIEW(webkit_view), "create",
                     G_CALLBACK(jarvisPanelOnCreate), NULL);
}
*/
import "C"

import (
	"log"

	webview "github.com/webview/webview_go"
)

func installPanelExternalNav(wv webview.WebView) {
	ctrl := webview.BrowserController(wv)
	if ctrl == nil {
		log.Printf("[panels] no browser controller; window.open will not route to the system browser")
		return
	}
	C.jarvisInstallPanelExtNav(ctrl)
}
