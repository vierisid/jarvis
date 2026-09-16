# Control-plane acceptance harness

Drives the paired Go sidecar through the daemon's gated debug-RPC endpoint to
check the Phase 0 (honesty/reliability) and Phase 1 (structural) exit criteria
from `docs/control-plane/STRUCTURAL_RUNTIME_ROADMAP.md`. It bypasses the LLM and calls sidecar
RPCs directly, so a failure is attributable to the control stack, not model
choices.

## Prerequisites

1. Build + install a sidecar that implements the suites you want to run:
   - **Phase 0** and **browser** (Phase 1) run on any current `main` build: the
     semantic-refs RPCs (`browser_ax_*` and `get_window_tree {semantic:true}`)
     have landed there.
   - The **desktop** suite (Phase 1) needs a **Windows** sidecar on top of
     that. Only the UIA walk reads `semantic`, so on macOS and Linux its checks
     skip and no rebuild changes that. See
     [`docs/sidecar/SIDECAR_PROTOCOL.md`](../../docs/sidecar/SIDECAR_PROTOCOL.md),
     "Surface Limits".

   ```
   cd sidecar && make build      # on Windows, or use the CI artifact
   ```
   Checks the connected sidecar cannot run (an RPC or feature its build lacks,
   or a missing capability) are reported as SKIP, not FAIL. If checks you
   expected to run are skipped, a stale auto-started sidecar has probably
   reconnected in place of the one you built: stop every `jarvis-sidecar`
   process and start only the fresh binary.
2. Generate a random secret and start the daemon with the debug gate set to it:
   ```
   export JARVIS_DEBUG_RPC="$(openssl rand -hex 24)"
   jarvis start
   ```
   The route stays disabled when the secret is shorter than 16 characters, and
   always on an install that counts as hosted (a `usejarvis_ai` block is
   configured, or `daemon.listen` is a `unix:` socket). Every call must echo the
   secret as `x-debug-rpc-token` (compared in constant time), and the daemon
   logs a warning at startup for as long as the gate is on.
3. Pair + connect a sidecar with the `desktop` and `browser` capabilities.
4. For the browser suite: be logged into Gmail in the sidecar's Chrome profile
   (the compose flow needs a real session), or pass `--gmail-url` to a page you
   are logged into.

## Run

From a shell that has `JARVIS_DEBUG_RPC` exported (or pass `--token`):

```
# everything, default Notepad app, 20 Notepad runs:
bun bench/control/acceptance.ts

# just one suite:
bun bench/control/acceptance.ts --suite browser
bun bench/control/acceptance.ts --suite desktop
bun bench/control/acceptance.ts --suite phase0 --runs 20

# point at a specific sidecar + a logged-in mail URL:
bun bench/control/acceptance.ts --target my-pc --gmail-url https://mail.google.com/...
```

Options: `--base` (default `http://127.0.0.1:3142`), `--target` (sidecar name
or id), `--suite` (`phase0|browser|desktop|all`), `--app` (default
`notepad.exe`), `--runs`, `--gmail-url`, `--out` (report path), `--token`.

## Output

Prints PASS/FAIL/SKIP per check and writes a markdown table to
`bench/control/last-report.md` (gitignored). The exit code is 0 when at least
one check ran and none failed, 1 when a check failed or every check was skipped,
and 2 when the harness could not run (unknown `--suite`, daemon unreachable,
gate closed or wrong token, no connected sidecar). Latency and payload-size
numbers are single-run; run a few times and average before recording them in
`docs/control-plane/PHASE1_ADOPT_VS_BUILD.md`'s decision matrix.

Phase 0 and the desktop suite launch `--app` repeatedly and leave those windows
open: there is no close RPC, and closing by keystroke could land in the wrong
window. Close them without saving afterwards. Text is only typed into a window
the sidecar reports it has just focused; a run whose focus does not succeed
sends no input.

## What it checks (maps to roadmap exit criteria)

**Phase 0** - bogus-exe launch errors honestly; Notepad launch reports a
visible window and typing succeeds >=95% over N runs; `list_windows` is fast
(native path); a stale element id returns the id-churn explanation;
`find_element` miss returns near-miss candidates; the `win+r` chord dispatches.

**Browser (Phase 1)** - navigation to a dead host errors instead of claiming
success; `browser_ax_snapshot` returns elements carrying `sig` +
`backend_node_id`; the AX payload is >=8x smaller than a screenshot; Compose is
found and clicked by ref; To/Subject set via `browser_ax_set_value` with
read-back; >=95% of elements keep a distinct sig across a re-snapshot. (The
draft is left unsent for manual inspection.)

**Desktop (Phase 1)** - `get_window_tree {semantic:true}` emits sig/path/
ordinal on every element; >=95% of elements keep a distinct sig across a
re-snapshot. Windows only; the skip off Windows names the platform rather than
blaming the build.

## Note on the debug endpoint

`/api/debug/rpc` is a deliberate, double-gated backdoor for this harness (a
secret set at daemon startup, echoed back on every request). Whoever holds the
secret can call any RPC the connected sidecars registered: shell commands, file
read/write, clipboard, browser JavaScript and desktop input. Those calls skip
the approval step and the audit trail; the daemon only logs each one to its
console. The sidecar's own capability settings and command blocklist still
apply.

The secret protects against network callers, not against code running as the
daemon's user. The daemon deletes it from its environment after reading it, but
a process it spawns without an explicit environment still inherits it, and on
Linux any same-user process can read it from `/proc/<daemon pid>/environ`. That
includes commands the agent's terminal tool runs. Do not leave
`JARVIS_DEBUG_RPC` set on a normally-running daemon, and do not let agents work
on that daemon while the gate is open.
