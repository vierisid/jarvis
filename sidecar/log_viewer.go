package main

// Local log viewer — a small webview window that shows the sidecar's own log
// file (~/.jarvis/sidecar.log) with search, copy, and export. Entirely local:
// it is NOT a dashboard room and never talks to the brain. Reuses the webview_go
// dependency (same as the setup window / panels); the UI is local HTML in the
// shared Monochrome Lab brand (brand_css.go).

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	webview "github.com/webview/webview_go"

	"github.com/jarvis/sidecar/internal/winchrome"
)

// OpenLogViewer opens the log viewer window on its own OS-locked goroutine
// (webview owns its thread, like the panels). No-op-safe.
func (c *SidecarClient) OpenLogViewer() {
	go runLogViewer(filepath.Join(configDir, logFileName))
}

func runLogViewer(logPath string) {
	runLocalWebview("JARVIS — Logs", 900, 600, webview.HintNone, winchrome.CustomTitleBar, func(w webview.WebView) func() {

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

		w.SetHtml(logViewerHTML)
		return nil
	})
}

const logViewerHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>JARVIS — Logs</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>` + brandTokensCSS + `
  /* Monochrome Lab (Brand Book III) — shared tokens from brand_css.go,
     dark follows the OS. */
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; font-size: 13px; }
  .bar {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px;
    background: var(--raise); border-bottom: 1px solid var(--rule); flex: 0 0 auto;
  }
  .eyebrow {
    font-family: var(--mono); font-size: 10px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--ink3); margin-right: 2px;
  }
  input {
    flex: 1; min-width: 80px; padding: 7px 11px; border-radius: var(--corner-sm);
    border: 1px solid var(--rule); background: var(--panel2); color: var(--ink);
    font-family: var(--sans); font-size: 13px; outline: none;
    transition: border-color .12s, box-shadow .12s, background .12s;
  }
  input::placeholder { color: var(--faint); }
  input:focus {
    border-color: var(--speak); background: var(--raise);
    box-shadow: 0 0 0 3px rgba(45,120,255,.14);
  }
  #count { font-family: var(--mono); font-size: 11px; color: var(--ink3); white-space: nowrap; }
  button {
    border: 1px solid var(--rule); background: var(--raise); color: var(--ink2);
    border-radius: var(--corner-sm); padding: 7px 13px; font-family: var(--sans);
    font-size: 12.5px; cursor: pointer; white-space: nowrap;
    transition: background .12s, border-color .12s, color .12s;
  }
  button:hover { background: var(--panel); color: var(--ink); border-color: var(--rule-hi); }
  button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  button.primary:hover { filter: brightness(1.08); }
  pre {
    flex: 1 1 auto; margin: 0; padding: 12px 14px; overflow: auto;
    font-family: var(--mono); font-size: 12px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
    background: var(--bg); color: var(--ink2);
  }
  pre::-webkit-scrollbar { width: 11px; height: 11px; }
  pre::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 8px; border: 3px solid var(--bg); }
  pre::-webkit-scrollbar-thumb:hover { background: var(--rule-hi); }
  #msg {
    flex: 0 0 auto; padding: 6px 14px; font-family: var(--mono); font-size: 11px;
    min-height: 22px; color: var(--ink3); border-top: 1px solid var(--rule);
    background: var(--raise);
  }
` + brandTitlebarCSS + `
</style>
</head>
<body>
  <div class="bar">
    <span class="eyebrow">Logs</span>
    <input id="q" placeholder="Search logs…" autofocus>
    <span id="count"></span>
    <button onclick="copyLogs()">Copy</button>
    <button onclick="doExport()">Export</button>
    <button class="primary" onclick="refresh()">Refresh</button>
  </div>
  <pre id="logs"></pre>
  <div id="msg"></div>` + brandTitlebarHTML + `
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
` + brandTitlebarJS + `
</script>
</body>
</html>`
