package main

import "fmt"

// desktop_element_identity.go -- what makes a desktop element id still mean
// the element a snapshot showed the model (#661). Shared by every platform's
// action path; each platform decides how to read the element back.
//
// A desktop element id is not an identity. On Linux and macOS it is the
// element's index in the last tree walk; on Windows it is a counter that
// restarts at 1 on every snapshot. Either way it is a small integer a model
// can produce without having seen any snapshot, and before #661 nothing tied
// it to the surface it described: Linux and macOS clicked the coordinates the
// walk recorded however long ago that was, and the cache stamped a timestamp
// nothing read. So an id from an earlier turn dispatched a real click at
// wherever that element USED to be -- onto whatever the window moved to
// uncover, or onto a different control now occupying the index.
//
// The browser closed the same class with a document identity and a
// generation (#592, #603: refuseStaleElement in browser_snapshot.go). The
// desktop has no loaderId to compare, so the check is the most direct one
// available: read the element back at action time and refuse unless it is
// still what the snapshot reported.
//
// There is deliberately NO time bound. A click is safe because its target is
// the element the model was shown, not because the showing was recent: an
// element verified identical a minute later is a correct click, and one that
// moved a second later is not. The browser path has no TTL for the same
// reason, and any number picked here would be a guess rather than a
// measurement.

// desktopElementPrint is what a snapshot told the model about one element:
// enough to recognise it again, and nothing that changes as a side effect of
// using it (enabled/focused state flip when the element is clicked). autoID
// is the UIA AutomationId on Windows and always empty on Linux and macOS,
// whose walks have no such concept.
type desktopElementPrint struct {
	name, role, autoID string
	x, y, w, h         int
}

// desktopElementChange reports how `live` differs from `snap`, as the clause
// a refusal uses, or "" when it is still the element the snapshot listed.
//
// `positional` says whether the caller dispatches AT the recorded position.
// Linux and macOS do -- they click the centre of the rect the walk returned --
// so a moved element is a stale one there. Windows does not: it acts through
// the live COM element and reads its bounds at click time, so a window that
// moved has not made the id point anywhere else.
func desktopElementChange(snap, live desktopElementPrint, positional bool) string {
	if snap.role != live.role || snap.name != live.name || snap.autoID != live.autoID {
		return "is a different element now"
	}
	if positional && (snap.x != live.x || snap.y != live.y || snap.w != live.w || snap.h != live.h) {
		return "has moved"
	}
	return ""
}

// desktopStaleElementCode marks a refusal made BEFORE anything was dispatched,
// so the daemon may report it as not started (NOT_STARTED_RPC_CODES in
// src/actions/tools/sidecar-route.ts). Every error carrying it must be
// returned before the first click, keystroke or pattern call.
const desktopStaleElementCode = "DESKTOP_STALE_ELEMENT"

func desktopElementNotCached(id int) error {
	return &codedError{code: desktopStaleElementCode, err: fmt.Errorf(
		"element [%d] is not in the current element cache, so nothing was done. Only ids from the most recent "+
			"desktop_snapshot or desktop_find_element are valid: run desktop_snapshot again and use an id from that result", id)}
}

func desktopElementStale(id int, why string) error {
	return &codedError{code: desktopStaleElementCode, err: fmt.Errorf(
		"element [%d] %s since the snapshot that listed it, so nothing was done. "+
			"Run desktop_snapshot again and use an id from that result", id, why)}
}

// desktopTargetObscuredCode marks a click refused because the window under the
// element's centre is not the element's own (#705). The pointer has moved; no
// button went down and no key was pressed, so it may be reported as not
// started (NOT_STARTED_RPC_CODES in src/actions/tools/sidecar-route.ts).
const desktopTargetObscuredCode = "DESKTOP_TARGET_OBSCURED"

// desktopElementSuperseded is the refusal for a snapshot that refilled the
// cache while an action was confirming one of its ids: the id the model sent
// was minted by the snapshot before, and the cache now answers for the new one.
func desktopElementSuperseded(id int) error {
	return &codedError{code: desktopStaleElementCode, err: fmt.Errorf(
		"a new snapshot replaced element [%d] while this call was confirming it, so nothing was done. "+
			"Run desktop_snapshot again and use an id from that result", id)}
}
