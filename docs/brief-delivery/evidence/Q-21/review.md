# Q-21 direct review

No findings.

Read-only implementer review followed the Review Agent skill, compared the complete main merge-base diff, and inspected callers, tests, prompt framing, UI rendering and the new browser fixture. This is not independent human approval.

An initial review found that turning an image into a link could nest anchors when the Markdown already linked that image. The implementation now preserves the outer link and renders the image label inside it; the added regression passes. Re-review found no remaining actionable defects introduced by this change.

Checks: 912 wider regressions passed before that final UI correction; 157 focused tests passed afterward, along with TypeScript and UI build. Three removed fixes were each detected and restored. The final browser probe was rebuilt and rerun on all three production components: zero automatic image requests/active elements/executable links, three image links/tables, no script execution. Normal implementation hooks ran 197 tests with zero failures.

Limits: deterministic mocked model output is not measured resistance of a deployed model; existing workflow-template provenance, live hosting, combined Brief integration and native-webview verification remain unverified. See docs/TRUST_BOUNDARIES.md.

Final test review moved the billing signature assertion outside the transport callback (the product catches callback failures) and asserts the success response. This prevents a broken signer from producing a false-green regression. No production behavior changed in this test correction.

Follow-up PR review identified three additional defects: trusted routing instructions were disclaimed by environment framing, generated footnote attributes were dropped, and prompt provenance retained the old version. All three are now fixed. Re-review inspected the inventory/rule separation and its callers, scoped DOM navigation including repeated and non-ASCII footnotes, URL protections, preserved styling, and persisted `w8-3` provenance. No remaining actionable findings. The 287-test correction run, three removed-fix checks and fresh browser evidence are recorded in [review-fixes.json](review-fixes.json).
