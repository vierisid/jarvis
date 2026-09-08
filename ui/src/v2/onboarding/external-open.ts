/**
 * Opening a URL the user has to visit (an OAuth consent screen, the hosted
 * account page) and telling whether it actually opened.
 *
 * That second half is harder than it looks, because `window.open` returns null
 * for three different reasons and only one of them is a failure:
 *
 *  1. The popup was blocked. A real failure; the user must be told.
 *  2. `noopener` was passed. Null BY SPECIFICATION, whatever happened. This
 *     repo has shipped that mistake twice in one function.
 *  3. The sidecar's panel host took the URL and handed it to the system
 *     browser. Its handler opens the URL and returns no view, and "no view" is
 *     what reaches the page. A success that looks identical to 1.
 *
 * So: never pass `noopener` when the result is inspected (2), sever the opener
 * afterwards instead, and ask the host about (3).
 */

/**
 * Does the host hand new windows to the system browser?
 *
 * `window.__jarvisOpensExternally` is injected by the sidecar's panel runtime
 * (sidecar/panels_runtime.go) and ONLY when its routing is genuinely installed
 * -- including that deferred, gesture-less opens are permitted, which is a
 * separate per-platform setting from the routing itself. Absent in an ordinary
 * browser, and absent in a panel where either half failed to install: in both
 * of those a null really does mean nothing opened.
 */
export function hostOpensExternally(): boolean {
  return typeof window !== "undefined" && window.__jarvisOpensExternally === true;
}

/**
 * Open a URL in a new tab, severing the opener without going through
 * `noopener`.
 *
 * `window.open(url, "_blank", "noopener")` would return null unconditionally,
 * which destroys the caller's ability to detect a blocked popup. Clearing
 * `opener` on the returned window gets the same protection -- the child cannot
 * reach back through `window.opener` to navigate this page -- while leaving the
 * return value meaningful. Inside a panel the point is moot (the system browser
 * receives a bare URL and there is no opener at all); it matters when the
 * dashboard runs in an ordinary browser.
 */
export function openExternal(url: string): Window | null {
  const win = window.open(url, "_blank");
  if (win) {
    try {
      win.opener = null;
    } catch {
      // Cross-origin already navigated, or a browser that refuses the write.
      // The tab is open either way, which is what the caller asked about.
    }
  }
  return win;
}

/**
 * Did the URL reach the user, one way or another?
 *
 * False only when nothing opened AND the host is not routing on our behalf --
 * the one case where the caller should tell the user to open the link
 * themselves.
 */
export function openedOrHandedOff(win: Window | null): boolean {
  return win !== null || hostOpensExternally();
}
