# Control-plane acceptance harness

Drives the paired Go sidecar through the daemon's gated debug-RPC endpoint to
check the Phase 0 (honesty/reliability) and Phase 1 (structural) exit criteria
from `STRUCTURAL_RUNTIME_ROADMAP.md`. It bypasses the LLM and calls sidecar
RPCs directly, so a failure is attributable to the control stack, not model
choices.

## Prerequisites

1. Build + install the sidecar **from this branch** (Phase 0/1 changes):
   ```
   cd sidecar && make build      # on Windows, or use the CI artifact
   ```
2. Start the daemon with the debug gate set to any secret string:
   ```
   JARVIS_DEBUG_RPC=some-long-secret jarvis start
   ```
   The `/api/debug/rpc` route does not exist unless this env var is set, and
   every call must echo it back as `x-debug-rpc-token`.
3. Pair + connect a sidecar with the `desktop` and `browser` capabilities.
4. For the browser suite: be logged into Gmail in the sidecar's Chrome profile
   (the compose flow needs a real session), or pass `--gmail-url` to a page you
   are logged into.

## Run

```
# everything, default Notepad app, 20 Notepad runs:
JARVIS_DEBUG_RPC=some-long-secret bun bench/control/acceptance.ts

# just one suite:
... bun bench/control/acceptance.ts --suite browser
... bun bench/control/acceptance.ts --suite desktop
... bun bench/control/acceptance.ts --suite phase0 --runs 20

# point at a specific sidecar + a logged-in mail URL:
... bun bench/control/acceptance.ts --target my-pc --gmail-url https://mail.google.com/...
```

Options: `--base` (default `http://127.0.0.1:3142`), `--target`, `--suite`
(`phase0|browser|desktop|all`), `--app` (default `notepad.exe`), `--runs`,
`--gmail-url`, `--out` (report path), `--token`.

## Output

Prints PASS/FAIL per check and writes a markdown table to
`bench/control/last-report.md`. Latency and payload-size numbers are
single-run — run a few times and average before recording them in
`PHASE1_ADOPT_VS_BUILD.md`'s decision matrix.

## What it checks (maps to roadmap exit criteria)

**Phase 0** — bogus-exe launch errors honestly; Notepad launch reports a
visible window and typing succeeds ≥95% over N runs; `list_windows` is fast
(native path); a stale element id returns the id-churn explanation;
`find_element` miss returns near-miss candidates; the `win+r` chord dispatches.

**Browser (Phase 1)** — navigation to a dead host errors instead of claiming
success; `browser_ax_snapshot` returns elements carrying `sig` +
`backend_node_id`; the AX payload is ≥8× smaller than a screenshot; Compose is
found and clicked by ref; To/Subject set via `browser_ax_set_value` with
read-back; sigs re-resolve ≥95% across a re-snapshot. (The draft is left
unsent for manual inspection.)

**Desktop (Phase 1)** — `get_window_tree {semantic:true}` emits sig/path/
ordinal on every element; sigs re-resolve ≥95% across a re-snapshot.

## Note on the debug endpoint

`/api/debug/rpc` is a deliberate, double-gated backdoor for this harness
(env-var existence + shared-secret header). It can drive the desktop, so do
not leave `JARVIS_DEBUG_RPC` set on a normally-running daemon.
