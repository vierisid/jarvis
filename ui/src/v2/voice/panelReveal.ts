/**
 * The page's visibility as far as a spoken answer is concerned (#886).
 *
 * The Windows sidecar panel keeps itself hidden with SW_HIDE while its page
 * first loads (until `load`, or a 6s fallback), and WebView2 does not see
 * that, so `document.visibilityState` says "visible" while nothing is on
 * screen. The panel marks such a page with
 * `window.__jarvis_panel_revealed = false` until it has been shown
 * (`sidecar/panels_reveal.go`). After a reload of a shown panel the flag is
 * false again until `load`, which refuses rather than accepts. Only an exact
 * `false` counts: a browser tab, or a panel on another platform, has no flag
 * and keeps what the page reports.
 */
export function effectiveVisibility(visibilityState: string, panelRevealed: unknown): string {
  return panelRevealed === false ? "hidden" : visibilityState;
}

/** Reads the live page: `document.visibilityState` and the panel's reveal flag. */
export function currentVisibility(): string {
  const flag = (window as unknown as { __jarvis_panel_revealed?: unknown }).__jarvis_panel_revealed;
  return effectiveVisibility(document.visibilityState, flag);
}
