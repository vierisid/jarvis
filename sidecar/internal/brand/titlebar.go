package brand

// Custom window chrome — the title bar the page draws for itself when the
// native one has been removed (Windows only; see internal/winchrome).
//
// Markup contract, for every page that opts in:
//
//	<style> TokensCSS … page rules … TitlebarCSS </style>
//	<body> … page … TitlebarHTML <script> TitlebarJS </script> </body>
//
// TitlebarHTML goes LAST in the body, after the page's content. It is fixed
// positioned, so the position in the source costs it nothing visually — and it
// puts the window controls at the end of the tab order, where chrome belongs.
// A native caption's buttons are not tab stops at all; first Tab landing on
// Minimize instead of the page is the next closest thing to wrong.
//
// Nothing here renders unless <html data-chrome="custom"> is set, and only
// winchrome.Install sets it — so the same page keeps its native title bar on
// macOS and Linux with no per-platform branching in the page itself.
//
// The strip is `position: fixed`, spanning the full window width the way a
// real title bar does. Sticky was the tempting alternative — it keeps the
// viewport as the scroller, so keyboard scrolling comes free — but next to a
// classic scrollbar it stops ~15px short of the right edge, which reads as a
// page element rather than as chrome.
//
// Fixed costs two things, and a page that opts in owes both:
//
//   - No padding on `body` (it would be replaced by the strip's offset below,
//     leaving the first element flush against the bar). Page padding goes on
//     an inner `.pagebody` wrapper.
//   - `.pagebody` is the scroll container, so its scrollbar starts below the
//     strip rather than running behind it — and because a div is not
//     focusable, the page must also carry PageBodyJS, which is what keeps
//     Space/PageDown scrolling for someone without a mouse.

// TitlebarCSS styles the strip and its window controls. The metrics follow
// the Windows convention (46×34 controls, close turns red on hover) so the
// buttons stay where a Windows user's muscle memory puts them; everything
// else is Monochrome Lab.
const TitlebarCSS = `
  .wchrome { display: none; }
  html[data-chrome="custom"] {
    /* Consumed by the body offset below, and by pages that need the metric. */
    --wchrome-h: 34px;
  }
  html[data-chrome="custom"] body {
    /* Specificity, not order, is what makes this win over a page's own
       "body { padding: … }" — which is why a chromed page must not have one.
       box-sizing:border-box (TokensCSS) means a 100%/100vh body keeps its
       height and gives the strip its share of it. */
    padding-top: var(--wchrome-h);
  }
  html[data-chrome="custom"] .wchrome {
    position: fixed; top: 0; left: 0; right: 0; height: var(--wchrome-h);
    display: flex; align-items: stretch; z-index: 2147483000;
    background: var(--raise); border-bottom: 1px solid var(--rule);
    user-select: none; -webkit-user-select: none; cursor: default;
  }
  /* The inner scroll container. Focusable, so a click inside it carries the
     keyboard with it, but never ringed — it is a viewport, not a control. */
  .pagebody:focus { outline: none; }
  /* The drag region is everything the controls don't claim. */
  .wchrome-drag {
    flex: 1 1 auto; display: flex; align-items: center; gap: 8px;
    touch-action: none;
    padding-left: 11px; min-width: 0; overflow: hidden;
  }
  /* The Pebble's silhouette at favicon scale — self-contained on purpose, so
     a page that never includes PebbleCSS still gets the brand mark. */
  .wchrome-mark {
    flex: 0 0 auto; width: 9px; height: 9px;
    border-radius: 50% 50% 50% 2px; transform: rotate(45deg);
    background: radial-gradient(circle at 50% 40%, #ff6e60, #e63b2e 62%, #b81e16);
  }
  .wchrome-title {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .07em;
    text-transform: uppercase; color: var(--ink3);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wchrome-controls { flex: 0 0 auto; display: flex; align-items: stretch; }
  .wchrome-btn {
    /* Overlaps the strip's bottom border: a close hover that stops 1px short
       of the edge is the tell that the bar is not the system's. */
    width: 46px; height: var(--wchrome-h); margin-bottom: -1px;
    padding: 0; border: 0; background: transparent;
    color: var(--ink2); display: flex; align-items: center; justify-content: center;
    cursor: default; transition: background .12s, color .12s;
  }
  .wchrome-btn:hover { background: var(--panel); color: var(--ink); }
  .wchrome-btn:active { background: var(--rule2); }
  .wchrome-btn:focus-visible { outline: 2px solid var(--speak); outline-offset: -3px; }
  .wchrome-close:hover { background: #C42B1C; color: #fff; }
  .wchrome-close:active { background: #B4271A; color: #fff; }
  /* Crisp 1px glyphs — but only for the axis-aligned ones. Turning off
     anti-aliasing on the close glyph's diagonals gives a pixel staircase, on
     the one button with a filled hover where the glyph is most looked at. */
  #wchrome-min svg, #wchrome-max svg { shape-rendering: crispEdges; }
  .wchrome-glyph-restore { display: none; }
  .wchrome.is-max .wchrome-glyph-max { display: none; }
  .wchrome.is-max .wchrome-glyph-restore { display: block; }
  /* Forced colors: the system owns every surface, so drop the brand paint and
     lean on the system keywords, including for the close hover. */
  @media (forced-colors: active) {
    html[data-chrome="custom"] .wchrome { border-bottom-color: CanvasText; }
    .wchrome-btn { color: ButtonText; }
    .wchrome-btn:hover, .wchrome-close:hover { background: Highlight; color: HighlightText; }
    .wchrome-mark { background: CanvasText; }
  }
`

// TitlebarHTML is the strip's markup: a drag region carrying the mark and the
// window title (filled from document.title by TitlebarJS), then the three
// controls. The maximize button ships both glyphs and swaps them on .is-max
// rather than rewriting its contents, so the state change can't lose the
// button's accessible name.
//
// role="presentation" on the header is deliberate: the strip is window chrome,
// not page content, and the only things in it a screen reader should reach are
// the three named buttons.
const TitlebarHTML = `<header class="wchrome" id="wchrome" role="presentation">
  <div class="wchrome-drag" id="wchrome-drag">
    <span class="wchrome-mark" aria-hidden="true"></span>
    <span class="wchrome-title" id="wchrome-title"></span>
  </div>
  <div class="wchrome-controls">
    <button type="button" class="wchrome-btn" id="wchrome-min" aria-label="Minimize" title="Minimize">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>
    </button>
    <button type="button" class="wchrome-btn" id="wchrome-max" aria-label="Maximize" title="Maximize">
      <svg class="wchrome-glyph-max" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>
      <svg class="wchrome-glyph-restore" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>
    </button>
    <button type="button" class="wchrome-btn wchrome-close" id="wchrome-close" aria-label="Close" title="Close">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>
    </button>
  </div>
</header>`

// TitlebarJS wires the strip to the window. Inert unless winchrome.Install ran
// (it is what defines __jarvisCustomChrome and the bindings), so a page can
// carry it on every platform.
//
// The gesture runs on POINTER events, not mouse events, so a Windows tablet
// can drag the window the way a native caption does (`touch-action: none` on
// the drag region keeps the browser from panning instead). Everything below
// says "press" rather than "mousedown" for that reason.
//
// The gesture model is the part worth reading. A binding call is a message
// round trip, not a synchronous call inside the press, so handing every
// press straight to the native move loop risks the loop starting after the
// button is already up — the window then follows the cursor until the next
// click. So a press only ARMS the drag, and the first real movement (4px, with
// the button still down) starts it. A press-and-release that never moved never
// enters the loop at all, which also makes press-to-press timing an honest
// signal for the double-click.
//
// Double-click is timed here rather than taken from the dblclick event,
// because the native move loop owns the mouse for the whole first gesture and
// no dblclick is guaranteed to arrive. It compares SCREEN coordinates: a drag
// carries the viewport with it, so client coordinates would call a 300px
// window move "the same spot" under a hand that never left it. The window
// picks up the user's real double-click speed from __jarvisDblClickMs.
const TitlebarJS = `
(function () {
  if (!window.__jarvisCustomChrome) return;
  try {
    var bar = document.getElementById('wchrome');
    var drag = document.getElementById('wchrome-drag');
    var titleEl = document.getElementById('wchrome-title');
    if (!bar || !drag) return;

    if (titleEl) {
      var setTitle = function () { titleEl.textContent = document.title || ''; };
      setTitle();
      // Pages that set document.title later (or swap it for a state) keep the
      // strip in sync without having to know the strip exists.
      var titleNode = document.querySelector('title');
      if (titleNode && window.MutationObserver) {
        new MutationObserver(setTitle).observe(titleNode, { childList: true });
      }
    }

    var syncMax = function (isMax) {
      if (typeof isMax === 'boolean') { bar.classList.toggle('is-max', isMax); return; }
      if (!window.__jarvis_chrome_is_maximized) return;
      window.__jarvis_chrome_is_maximized().then(function (m) {
        bar.classList.toggle('is-max', !!m);
      }).catch(function () {});
    };

    var toggleMax = function () {
      if (!window.__jarvis_chrome_toggle_maximize) return;
      window.__jarvis_chrome_toggle_maximize().then(syncMax).catch(function () {});
    };

    var dblMs = window.__jarvisDblClickMs || 500;
    var armed = false, downX = 0, downY = 0;
    var lastDownAt = 0, lastDownX = 0, lastDownY = 0;

    drag.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var now = Date.now();
      if (now - lastDownAt < dblMs &&
          Math.abs(e.screenX - lastDownX) < 6 && Math.abs(e.screenY - lastDownY) < 6) {
        lastDownAt = 0; armed = false;
        toggleMax();
        return;
      }
      lastDownAt = now; lastDownX = e.screenX; lastDownY = e.screenY;
      armed = true; downX = e.screenX; downY = e.screenY;
    });

    window.addEventListener('pointermove', function (e) {
      if (!armed) return;
      // A release delivered outside the window can be missed; the button state
      // on the next move is the reliable way to notice the gesture is over.
      if (!(e.buttons & 1)) { armed = false; return; }
      if (Math.abs(e.screenX - downX) < 4 && Math.abs(e.screenY - downY) < 4) return;
      armed = false;
      if (!window.__jarvis_chrome_drag) return;
      window.__jarvis_chrome_drag().then(function () {
        // Resolves when the window is dropped. Forget the press that started
        // it (it must not pair with the next one into a double-click) and
        // re-read the state, since a drag off a maximized window restores it.
        lastDownAt = 0;
        syncMax();
      }).catch(function () {});
    });

    window.addEventListener('pointerup', function () { armed = false; });
    window.addEventListener('pointercancel', function () { armed = false; });

    // Right-click on the caption is the system menu, the way it is on a native
    // title bar. Alt+Space still works either way (WS_SYSMENU is kept).
    bar.addEventListener('contextmenu', function (e) {
      if (!window.__jarvis_chrome_sysmenu) return;
      e.preventDefault();
      window.__jarvis_chrome_sysmenu();
    });

    var on = function (id, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    on('wchrome-min', function () { if (window.__jarvis_chrome_minimize) window.__jarvis_chrome_minimize(); });
    on('wchrome-max', toggleMax);
    on('wchrome-close', function () { if (window.__jarvis_chrome_close) window.__jarvis_chrome_close(); });

    // Snap, Win+Arrow, the taskbar and a drag off a maximized window all change
    // the state behind our back; resize is the one event they share.
    window.addEventListener('resize', function () { syncMax(); });
    syncMax();
  } catch (e) {}
})();
`

// PageBodyJS keeps the keyboard working on a page whose scroll container is the
// inner .pagebody wrapper rather than its body.
//
// A div does not take focus, and an unfocused container ignores Space,
// PageUp/PageDown, the arrows, Home and End — so without this, a window that
// overflows (the 520x560 settings window does) is unreachable to anyone not
// holding a mouse. Two halves: a click inside the container hands it focus, and
// a document-level fallback forwards the paging keys whatever has focus, since
// the very first keypress of a freshly opened window arrives before any click.
//
// It stays out of the way of the page: keys are ignored while a form control or
// a button has focus (Space there belongs to the control), and it never steals
// focus from a field the page autofocused. Not chrome-specific and not
// Windows-specific — the wrapper exists on every platform, so this ships with
// it.
const PageBodyJS = `
(function () {
  try {
    var p = document.querySelector('.pagebody');
    if (!p) return;
    if (!p.hasAttribute('tabindex')) p.setAttribute('tabindex', '-1');

    // A click into the content should carry the keyboard with it — but not
    // away from whatever the user actually clicked.
    p.addEventListener('mousedown', function (e) {
      // p itself matches the selector (it carries the tabindex above), so the
      // container must be excluded or this returns on every click.
      var hit = e.target.closest('input, textarea, select, button, a, [tabindex]');
      if (hit && hit !== p) return;
      p.focus({ preventScroll: true });
    });

    var typing = function (el) {
      return !!el && (el.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName));
    };
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.defaultPrevented) return; // the page handled it first
      if (typing(e.target)) return;
      var page = Math.max(40, p.clientHeight - 40), d = null;
      switch (e.key) {
        case ' ': d = e.shiftKey ? -page : page; break;
        case 'PageDown': d = page; break;
        case 'PageUp': d = -page; break;
        case 'ArrowDown': d = 48; break;
        case 'ArrowUp': d = -48; break;
        case 'Home': p.scrollTop = 0; e.preventDefault(); return;
        case 'End': p.scrollTop = p.scrollHeight; e.preventDefault(); return;
      }
      if (d === null) return;
      p.scrollBy(0, d);
      e.preventDefault();
    });
  } catch (e) {}
})();
`
