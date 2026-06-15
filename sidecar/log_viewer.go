package main

// Local log viewer — a small webview window that shows the sidecar's own log
// file (~/.jarvis/sidecar.log) with search, copy, and export. Entirely local:
// it is NOT a dashboard room and never talks to the brain. Reuses the webview_go
// dependency (same as the setup window / panels); the UI is plain HTML, to be
// branded later.

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	webview "github.com/webview/webview_go"
)

// OpenLogViewer opens the log viewer window on its own OS-locked goroutine
// (webview owns its thread, like the panels). No-op-safe.
func (c *SidecarClient) OpenLogViewer() {
	go runLogViewer(filepath.Join(configDir, logFileName))
}

func runLogViewer(logPath string) {
	runLocalWebview("JARVIS — Logs", 900, 600, webview.HintNone, func(w webview.WebView) {

		// loadLogs returns the current log file contents.
		_ = w.Bind("loadLogs", func() string {
			data, err := os.ReadFile(logPath)
			if err != nil {
				return fmt.Sprintf("(could not read %s: %v)", logPath, err)
			}
			return string(data)
		})

		// exportLogs writes a timestamped copy next to the log and returns its path
		// (shown in the UI). Avoids needing a native save dialog.
		_ = w.Bind("exportLogs", func() string {
			data, err := os.ReadFile(logPath)
			if err != nil {
				return ""
			}
			dst := filepath.Join(configDir, fmt.Sprintf("sidecar-log-%d.txt", time.Now().Unix()))
			if err := os.WriteFile(dst, data, 0600); err != nil {
				log.Printf("[logs] export failed: %v", err)
				return ""
			}
			return dst
		})

		// The vendored webview creates the window hidden (no flash); reveal it once
		// the page has loaded.
		revealWebviewOnLoad(w)
		w.SetHtml(logViewerHTML)
	})
}

const logViewerHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* Force the sidecar's own light theme regardless of the OS appearance:
     color-scheme: light keeps the engine from dark-rendering form controls /
     scrollbars, and there is no prefers-color-scheme override. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f2eb; color: #1a1a1a;
  }
  .bar {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    background: #efeae0; border-bottom: 1px solid #cbc3b2; flex: 0 0 auto;
  }
  input {
    flex: 1; min-width: 80px; padding: 6px 10px; border-radius: 6px;
    border: 1px solid #cbc3b2; background: #fff; color: #1a1a1a; font-size: 13px;
  }
  #count { font-size: 12px; opacity: 0.7; white-space: nowrap; }
  button {
    border: 1px solid #cbc3b2; background: #fff; color: #1a1a1a; border-radius: 6px;
    padding: 6px 12px; font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  button:hover { filter: brightness(0.96); }
  pre {
    flex: 1 1 auto; margin: 0; padding: 10px 12px; overflow: auto;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
    background: #fbf9f4;
  }
  #msg {
    flex: 0 0 auto; padding: 4px 12px; font-size: 12px; min-height: 20px;
    color: #6a675f; border-top: 1px solid #cbc3b2;
  }
</style>
</head>
<body>
  <div class="bar">
    <input id="q" placeholder="Search logs..." autofocus>
    <span id="count"></span>
    <button onclick="copyLogs()">Copy</button>
    <button onclick="doExport()">Export</button>
    <button onclick="refresh()">Refresh</button>
  </div>
  <pre id="logs"></pre>
  <div id="msg"></div>
<script>
  var raw = "";
  var pre = document.getElementById('logs');
  var q = document.getElementById('q');
  var count = document.getElementById('count');

  async function refresh() {
    raw = await window.loadLogs();
    render(true);
  }
  function render(scroll) {
    var query = q.value.trim();
    if (!query) {
      pre.textContent = raw;
      count.textContent = "";
      if (scroll) pre.scrollTop = pre.scrollHeight;
      return;
    }
    var ql = query.toLowerCase();
    var matched = raw.split("\n").filter(function (l) { return l.toLowerCase().indexOf(ql) !== -1; });
    pre.textContent = matched.join("\n");
    count.textContent = matched.length + (matched.length === 1 ? " match" : " matches");
  }
  q.addEventListener('input', function () { render(false); });

  async function copyLogs() {
    try { await navigator.clipboard.writeText(pre.textContent); msg("Copied to clipboard."); }
    catch (e) { msg("Copy failed: " + e); }
  }
  async function doExport() {
    var path = await window.exportLogs();
    msg(path ? ("Exported to " + path) : "Export failed.");
  }
  function msg(t) {
    var m = document.getElementById('msg');
    m.textContent = t;
    setTimeout(function () { if (m.textContent === t) m.textContent = ""; }, 5000);
  }
  refresh();
</script>
</body>
</html>`
