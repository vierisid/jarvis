# Regression evidence

The first D-18 real-hook run failed `real graph edits serialize branch, loop, nested orphan settings and positions`: expected `Updated orphan child`, received the original `Keep the whole detached chain editable.` The orphan mutation lookup only accepted an orphan root, although the graph rendered descendants. The repaired lookup and recursive position retention pass this same test; the full suite adds detached insertion/deletion/undo coverage.

The published-version test asserts that a LOCKED version uses POST versions on first save, never PATCH. The rename/discard test verifies that the saved name returns. Browser verification found a missing step-name binding in the new per-node sample cache before delivery; TypeScript and the actual browser component caught it and the binding was corrected before the final run.

Recorded passes and limitations are in D-18.json. Historical failed screenshots from test harness development are not final evidence.

The final keyboard experiment also reproduced Enter selecting a React Flow node without opening its inspector. Brief now handles Enter/Space on the node target, opens its inspector and returns focus to that node on close. `keyboard-check.cjs` passes ten rapid cycles with both keys; the main matrix includes the same relationship on the detached node.
