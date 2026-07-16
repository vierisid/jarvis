package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ── Snapshot parity with the daemon's local browser ──────────────────
//
// This file is a faithful port of the daemon's snapshot pipeline
// (src/actions/browser/session.ts SNAPSHOT_SCRIPT + src/actions/tools/
// builtin.ts formatSnapshot). Webapp templates are written against that
// exact output format and its 1-based element ids; the sidecar must produce
// the same text or every template behaves differently when the browser is
// remote. If you change one side, change the other.

// browserSnapshotScript matches the daemon's SNAPSHOT_SCRIPT: same selector
// list, same visibility filtering, same attributes, 1-based ids, element
// refs stashed on window.__jarvis_elements for focus-based typing, and the
// same same-origin iframe traversal with coordinates offset to top-page
// space (change both together).
const browserSnapshotScript = `(() => {
  const els = [];
  const seen = new WeakSet();
  const sel = [
    'a', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="textbox"]',
    '[role="combobox"]', '[role="menuitem"]', '[role="option"]',
    '[role="row"]', '[role="gridcell"]',
    '[onclick]', '[contenteditable="true"]', '[tabindex="0"]',
    '[data-testid]'
  ].join(', ');

  const frames = [];
  const collectFrames = (doc, ox, oy, depth) => {
    frames.push({ doc, ox, oy });
    if (depth >= 3 || frames.length >= 10) return;
    for (const f of doc.querySelectorAll('iframe, frame')) {
      let child = null;
      try { child = f.contentDocument; } catch { continue; }
      if (!child) continue;
      const r = f.getBoundingClientRect();
      collectFrames(child, ox + r.x, oy + r.y, depth + 1);
    }
  };
  collectFrames(document, 0, 0, 0);

  for (const frame of frames) {
    const doc = frame.doc;
    const win = doc.defaultView || window;
    const inFrame = doc !== document;
    doc.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);

      const rect = el.getBoundingClientRect();
      const isTypingTarget = el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';
      const style = win.getComputedStyle(el);
      if (style.display === 'none') return;
      if (!isTypingTarget) {
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.width < 5 || rect.height < 5) return;
        if (style.visibility === 'hidden') return;
        if (style.opacity === '0') return;
      }

      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      const attrs = {};
      for (const a of ['href', 'name', 'placeholder', 'type', 'aria-label', 'title', 'id', 'role', 'data-testid', 'contenteditable']) {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v.slice(0, 200);
      }
      if ('value' in el && el.value) attrs.value = String(el.value).slice(0, 200);
      if (inFrame) attrs.iframe = 'true';
      els.push({
        _el: el,
        tag,
        text,
        attrs,
        x: Math.round(frame.ox + rect.x + rect.width / 2),
        y: Math.round(frame.oy + rect.y + rect.height / 2)
      });
    });
  }

  window.__jarvis_elements = els.map(e => e._el);
  els.forEach((el, i) => { el.id = i + 1; delete el._el; });

  let bodyText = (document.body && document.body.innerText) || '';
  for (const frame of frames) {
    if (frame.doc === document) continue;
    const t = frame.doc.body && frame.doc.body.innerText;
    if (t && t.trim()) bodyText += '\n' + t;
  }
  bodyText = bodyText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);

  return JSON.stringify({
    title: document.title,
    url: location.href,
    text: bodyText,
    elements: els
  });
})()`

type pageElement struct {
	ID    int               `json:"id"`
	Tag   string            `json:"tag"`
	Text  string            `json:"text"`
	Attrs map[string]string `json:"attrs"`
	X     float64           `json:"x"`
	Y     float64           `json:"y"`
}

type pageSnapshot struct {
	Title    string        `json:"title"`
	URL      string        `json:"url"`
	Text     string        `json:"text"`
	Elements []pageElement `json:"elements"`
}

// takePageSnapshot runs the snapshot script, stores element coordinates on
// the client (for click/hover by id), and returns the parsed snapshot.
func takePageSnapshot(cdp *cdpClient) (*pageSnapshot, error) {
	result, err := cdp.send("Runtime.evaluate", map[string]any{
		"expression":    browserSnapshotScript,
		"returnByValue": true,
		"awaitPromise":  true,
	})
	if err != nil {
		return nil, fmt.Errorf("snapshot failed: %w", err)
	}

	var wrapper struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
		ExceptionDetails json.RawMessage `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(result, &wrapper); err != nil {
		return nil, fmt.Errorf("parse snapshot reply: %w", err)
	}
	if wrapper.ExceptionDetails != nil {
		return nil, fmt.Errorf("snapshot failed: %s", string(wrapper.ExceptionDetails))
	}

	var snap pageSnapshot
	if err := json.Unmarshal([]byte(wrapper.Result.Value), &snap); err != nil {
		return nil, fmt.Errorf("parse snapshot payload: %w", err)
	}

	cdp.elemMu.Lock()
	cdp.elemCoords = make(map[int][2]float64, len(snap.Elements))
	for _, el := range snap.Elements {
		cdp.elemCoords[el.ID] = [2]float64{el.X, el.Y}
	}
	cdp.elemMu.Unlock()

	return &snap, nil
}

// elementCoords returns the stored viewport center for a snapshot element id.
func (c *cdpClient) elementCoordsFor(id int) ([2]float64, bool) {
	c.elemMu.Lock()
	defer c.elemMu.Unlock()
	coords, ok := c.elemCoords[id]
	return coords, ok
}

// Formatter limits — keep in sync with src/actions/tools/builtin.ts.
const (
	maxPageText = 2000
	maxElements = 80
	maxSameRole = 15
)

// formatBrowserSnapshot is a faithful port of the daemon's formatSnapshot.
func formatBrowserSnapshot(snap *pageSnapshot) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("Page: %s", snap.Title))
	lines = append(lines, fmt.Sprintf("URL: %s", snap.URL))
	lines = append(lines, "")
	lines = append(lines, "--- Page Text ---")
	if len(snap.Text) > maxPageText {
		lines = append(lines, snap.Text[:maxPageText])
		lines = append(lines, fmt.Sprintf("... (%d chars truncated)", len(snap.Text)-maxPageText))
	} else {
		lines = append(lines, snap.Text)
	}
	lines = append(lines, "")

	if len(snap.Elements) == 0 {
		lines = append(lines, "(no interactive elements found)")
		return strings.Join(lines, "\n")
	}

	// Pre-count aria-label frequency to identify repeated vs unique labels
	labelFreq := map[string]int{}
	for _, el := range snap.Elements {
		if label := el.Attrs["aria-label"]; label != "" {
			labelFreq[label]++
		}
	}

	isHighValue := func(el pageElement) bool {
		return el.Tag == "input" || el.Tag == "textarea" || el.Tag == "select" ||
			el.Tag == "button" ||
			el.Attrs["contenteditable"] == "true" || el.Attrs["role"] == "textbox"
	}

	roleCounts := map[string]int{}
	var shown, deferred []pageElement
	for _, el := range snap.Elements {
		role := el.Attrs["role"]
		if role == "" {
			role = el.Tag
		}
		label := el.Attrs["aria-label"]
		hasUniqueLabel := label != "" && labelFreq[label] == 1
		if isHighValue(el) || hasUniqueLabel {
			shown = append(shown, el)
		} else if roleCounts[role] < maxSameRole {
			shown = append(shown, el)
			roleCounts[role]++
		} else {
			deferred = append(deferred, el)
		}
	}

	if budget := maxElements - len(shown); budget > 0 {
		if budget > len(deferred) {
			budget = len(deferred)
		}
		shown = append(shown, deferred[:budget]...)
	}

	sort.Slice(shown, func(i, j int) bool { return shown[i].ID < shown[j].ID })

	// Highlight key interactive elements at the top
	var keyLines []string
	for _, el := range shown {
		if el.Tag == "input" || el.Tag == "textarea" || el.Tag == "select" ||
			el.Attrs["contenteditable"] == "true" || el.Attrs["role"] == "textbox" {
			label := el.Attrs["aria-label"]
			if label == "" {
				label = el.Attrs["placeholder"]
			}
			if label == "" {
				label = el.Attrs["name"]
			}
			if label == "" {
				label = el.Tag
			}
			suffix := ""
			if el.Attrs["contenteditable"] != "" {
				suffix = " (contenteditable)"
			}
			keyLines = append(keyLines, fmt.Sprintf("[%d] INPUT: %s%s", el.ID, label, suffix))
		}
	}
	for _, el := range shown {
		if (el.Tag == "button" || el.Attrs["role"] == "button") && el.Attrs["aria-label"] != "" {
			keyLines = append(keyLines, fmt.Sprintf("[%d] BUTTON: %s", el.ID, el.Attrs["aria-label"]))
		}
	}
	if len(keyLines) > 0 {
		lines = append(lines, "--- Key Elements ---")
		lines = append(lines, keyLines...)
		lines = append(lines, "")
	}

	lines = append(lines, fmt.Sprintf("--- Interactive Elements (%d/%d) ---", len(shown), len(snap.Elements)))
	for _, el := range shown {
		var attrParts []string
		addAttr := func(key, format string) {
			if v := el.Attrs[key]; v != "" {
				attrParts = append(attrParts, fmt.Sprintf(format, v))
			}
		}
		addAttr("name", `name="%s"`)
		addAttr("placeholder", `placeholder="%s"`)
		addAttr("type", `type="%s"`)
		if href := el.Attrs["href"]; href != "" {
			if len(href) > 80 {
				href = href[:80]
			}
			attrParts = append(attrParts, fmt.Sprintf(`href="%s"`, href))
		}
		addAttr("aria-label", `aria-label="%s"`)
		addAttr("role", `role="%s"`)
		addAttr("contenteditable", `contenteditable="%s"`)
		addAttr("data-testid", `data-testid="%s"`)
		addAttr("iframe", `iframe="%s"`)

		textStr := ""
		if el.Text != "" {
			text := el.Text
			if len(text) > 50 {
				text = text[:50]
			}
			textStr = fmt.Sprintf(" %q", text)
		}
		attrStr := ""
		if len(attrParts) > 0 {
			attrStr = " " + strings.Join(attrParts, " ")
		}
		lines = append(lines, fmt.Sprintf("[%d] %s%s%s", el.ID, el.Tag, textStr, attrStr))
	}
	if hidden := len(snap.Elements) - len(shown); hidden > 0 {
		lines = append(lines, fmt.Sprintf("(%d repeated list items hidden. All inputs, buttons, and textboxes are shown above.)", hidden))
	}

	return strings.Join(lines, "\n")
}

// takeFormattedSnapshot snapshots the page and returns the LLM-facing text.
func takeFormattedSnapshot(cdp *cdpClient) (string, error) {
	snap, err := takePageSnapshot(cdp)
	if err != nil {
		return "", err
	}
	return formatBrowserSnapshot(snap), nil
}
