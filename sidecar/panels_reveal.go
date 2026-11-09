package main

import "runtime"

// panelTracksReveal is true where a panel kept hidden during its first load
// still tells its page it is visible (#886). In the Windows panel (WebView2)
// SW_HIDE is invisible to the page: WebView2 only learns of it through
// put_IsVisible, which the vendored engine never sets to FALSE, so
// document.visibilityState stays "visible" until the reveal. There the page
// is told separately, through window.__jarvis_panel_revealed, whether the
// panel has been revealed yet. Other platforms keep the plain ready script.
const panelTracksReveal = runtime.GOOS == "windows"

// panelReadyScript is injected at document start on each navigation of a
// panel that is hidden while its page loads: call the binding a beat after
// `load` so the first paint is done before the reveal.
const panelReadyScript = `(function(){try{var r=function(){if(window.__sidecar_panel_ready)window.__sidecar_panel_ready();};` +
	`if(document.readyState==='complete'){setTimeout(r,120);}` +
	`else{window.addEventListener('load',function(){setTimeout(r,120);});}}catch(e){}})();`

// panelReadyTrackingScript is panelReadyScript plus the reveal flag: the page
// starts out not revealed, and only becomes revealed once a binding answers
// true, meaning the host has shown the window. A reload after the reveal sets
// the flag false again; it then asks the side-effect-free
// __sidecar_panel_shown at once (in a timer, so the binding's own
// document-start script has defined it) rather than waiting for `load` and the
// ready binding (#1157). The dashboard reads the flag as hidden only when it
// is exactly false, so a page with no flag is unaffected.
const panelReadyTrackingScript = `window.__jarvis_panel_revealed=false;` +
	`(function(){try{var a=function(b){if(!b)return;var p=b();` +
	`if(p&&typeof p.then==='function'){p.then(function(shown){if(shown===true)window.__jarvis_panel_revealed=true;},function(){});}};` +
	`setTimeout(function(){try{a(window.__sidecar_panel_shown);}catch(e){}},0);` +
	`var r=function(){a(window.__sidecar_panel_ready);};` +
	`if(document.readyState==='complete'){setTimeout(r,120);}` +
	`else{window.addEventListener('load',function(){setTimeout(r,120);});}}catch(e){}})();`

// panelRevealedScript is evaluated when the host reveals a tracking panel, so
// a page revealed by the fallback before its `load` is not left not revealed
// until `load` fires.
const panelRevealedScript = `window.__jarvis_panel_revealed=true;`

// panelReadyInitScript is the document-start script for a panel hidden while
// its page loads.
func panelReadyInitScript(trackReveal bool) string {
	if trackReveal {
		return panelReadyTrackingScript
	}
	return panelReadyScript
}
