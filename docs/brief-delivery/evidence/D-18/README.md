# D-18 verification artifacts

`browser-check.cjs` uses Playwright/Chromium against the built UI. Set `PLAYWRIGHT_MODULE` to a local Playwright package if it is not on the module path. Set `BRIEF_PREVIEW_URL` to change the default 4398 preview.

- `browser-results.json`: final verified layout/interaction matrix, real node identities, request/error monitoring.
- Theme/sidebar/chat PNGs: final representative Input state with retained unsaved JSON. Other final images cover advanced/orphan/chat and narrow inspector layouts.
- `affected-tests.log`, `focused-tests.log`, `typescript.log`, `build.log`: command output. Empty TypeScript log denotes no diagnostics; D-18.json records its checked exit status.
- `regression-notes.md`: observed failures and corrections, distinguished from final passing evidence.

Start the isolated built preview from the worktree: `bun install --frozen-lockfile`, `bun run build:ui`, then `python3 -m http.server 4398 --bind 127.0.0.1 --directory ui/dist`. The existing review server exposes this same static dist through WSL. No real daemon or account database is required.

The source uses the real workflow hook and React Flow. An owner-scoped in-memory request function supplies only these examples; there is no global fetch mock or network fallback. Saved samples/draft changes last until the review instance is reset or reloaded.

Review corrections use `review-graph-red.log` and `review-samples-red.log` for reproduced failures; `review-focused.log`, `review-affected-tests.log`, `review-typecheck.log` and `review-build.log` are the repaired checks. `review-browser-check.cjs` and `review-browser-results.json` cover actual saved-sample remounts and promoted-node dragging. The two `review-*.png` screenshots show the verified endpoints. All browser scripts use the isolated fixture; none execute a workflow.
