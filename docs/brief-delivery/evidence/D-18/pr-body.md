The Brief workflow page now uses the existing graph editor inside the working area, with a vertical default layout and a 320px inline inspector. Node selection, graph focus and unfinished fields stay intact when the inspector, Pebble or sidebar changes. Configure, Input and Output retain the real settings and clearly distinguish configured input from test samples.

The editor still owns serialization, save and undo. This also repairs defects uncovered by the new tests: edits and positions on detached descendants, detached insertion/deletion and unique names, first save of a published version, and workflow-name discard. Enter/Space opens a node inspector and closing it returns keyboard focus.

The review corrections unify node-name allocation across every connected/detached descendant, preserve promoted-node positions through drag/save/Undo, and keep compact JSON samples saved after node changes. Delayed sample saves preserve newer typing. Each finding has a reproduced failure and a passing regression; actual-browser checks verify both saved sample sections and promoted-node drag/save/reflow.

**Stack:** targets `brief/d-17` ([#780](https://github.com/vierisid/jarvis/pull/780)). Keep this PR and the stack unmerged. The production room remains unregistered. Activation requires F-21, scoped host integration and D-33 verification; no live F-21 compatibility or workflow execution is claimed. Runs and Context remain explicit D-19/D-20 handoffs.

Validation:
- 443 affected tests passed, 4,468 assertions; two optional F07/F08 compatibility tests skipped.
- 19 focused editor/sample-draft regressions passed, 89 assertions.
- TypeScript and UI build passed; existing Tailwind warnings remain.
- Actual Chrome editor: eight theme/sidebar/chat layouts, 80 pointer cycles, ten rapid keyboard reversals, ten node inspectors, per-node sample retention, edit/save, graph focal point and zoom, narrow/reduced-motion checks, and no external mutations.

[Handoff and rollback](docs/brief-delivery/D-18.md) · [Receipt](docs/brief-delivery/D-18.json) · [Evidence](docs/brief-delivery/evidence/D-18/)

Quick review: `http://127.0.0.1:4398/?brief=preview&specimen=workflow-canvas#/_brief_preview`. Select **Draft the follow-up**, edit it and toggle Pebble/sidebar. Use the review checkbox for branches, loops and disconnected nodes. Fixture saves stay in memory; Run does not execute work.
