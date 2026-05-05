# Phase 2 spike: engine sandboxing under Bun

**Status:** resolved -- `SANDBOX_PROCESS` execution mode is viable. We will not depend on `isolated-vm`.

## Question

Activepieces' engine package depends on `isolated-vm@6.0.2`, a Node N-API native addon. The original Phase 2 plan flagged this as the highest-risk unknown: if `isolated-vm` does not load under Bun, the entire vendoring approach is at risk.

## Finding

Activepieces already supports two distinct execution modes via the `AP_EXECUTION_MODE` env var (see `packages/server/engine/src/lib/core/code/code-sandbox.ts`):

| Mode | Sandbox | Dependency |
|---|---|---|
| `UNSANDBOXED` | child process | `node:child_process` |
| `SANDBOX_PROCESS` | child process | `node:child_process` |
| `SANDBOX_CODE_ONLY` | V8 isolate | `isolated-vm` |
| `SANDBOX_CODE_AND_PROCESS` | V8 isolate | `isolated-vm` |

Both child-process modes load `no-op-code-sandbox.ts`, which spawns a fresh interpreter via `spawn(process.execPath, ['--eval', runner], { stdio: [..., 'ipc'] })` and exchanges JSON over the IPC channel. **No `isolated-vm` import is reached.**

`scripts/spike-bun-ipc.ts` mirrors this pattern under Bun. All required tests pass:

| Test | Result |
|---|---|
| IPC round-trip via `bun -e` with `'ipc'` stdio slot | PASS |
| Child `require()`s a CJS file and runs user `code()` function | PASS |
| `unhandledRejection` in child propagates via IPC and exits non-zero | PASS |
| Child memory pressure terminates gracefully | needs external watchdog (informational) |

## Decision

**Run the engine in `SANDBOX_PROCESS` mode.** Implications:

1. We do not vendor or depend on `isolated-vm`. The `v8-isolate-code-sandbox.ts` file stays in the vendored tree but is never loaded at runtime.
2. The trust model: Jarvis is a personal-AI daemon executing workflows the user explicitly defined or asked the assistant to define. OS-level process isolation is sufficient; we do not need the V8 isolate's memory-limit and timeout primitives because:
   - Memory limits are enforced via a watchdog in the worker (poll RSS, SIGKILL on threshold).
   - Timeouts are enforced by the worker's per-run deadline.
   - SSRF and network egress controls already exist in the engine (`ssrf-guard.ts`).
3. We must set `AP_EXECUTION_MODE=SANDBOX_PROCESS` whenever invoking the engine.

## What we keep / what we drop

- Keep: the entire `code-sandbox.ts` loader, `no-op-code-sandbox.ts`, `code-sandbox-common.ts`. These work as-is under Bun.
- Drop at runtime: `v8-isolate-code-sandbox.ts` is never imported when `AP_EXECUTION_MODE` is `SANDBOX_PROCESS`. Source stays in tree to keep diff vs upstream small and to preserve the option to switch modes later.
- Reproduce the spike: `bun run scripts/spike-bun-ipc.ts`. Re-run after major Bun version bumps.
