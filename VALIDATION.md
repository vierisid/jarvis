# Control Plane v2 — Validation Checklist

Everything on branch `worktree-control-plane-v2` is code-complete and unit-tested
but has **never run on real hardware**. This is the end-to-end pass: build the
sidecar on Windows, run the automated harnesses, then eyeball the things a
harness can't judge. Treat it as **test-and-fix** — first contact with real
apps usually surfaces a few things (accessibility-name drift in seed skills,
resolver threshold tuning, ghost-mode delivery). Capture anything that breaks
and send it back.

Do these in order; each step gates the next.

> **Status (2026-07-17):** acceptance suite at **15/16** on real Windows hardware.
> The one failure is "AX-set To field" — compose editable fields missing from the
> AX snapshot. Root cause fixed in `c9dde52` (interactive elements were being
> truncated at the 300-element cap), but the last failing run (07-16 17:02) most
> likely drove the **stale 07-15 `jarvis-sidecar.exe`** — the build-check preflight
> only detects the *old install*, not stale same-branch builds. Both exes in
> `sidecar/` were rebuilt from HEAD on 07-17; the harness now polls for the compose
> fields (up to 8s) instead of a fixed sleep. **Next action:** re-run §3 with the
> fresh `jarvis-sidecar.exe`, then §4 metrics, then §5 manual.

---

## 0. Prerequisites (once)

- A **Windows** machine (the primary wedge is Windows-native). WSL is fine for
  building; the sidecar itself must run on Windows.
- Chrome/Edge installed and **logged into Gmail** (the browser flow needs a real
  session).
- Go toolchain + mingw already work in this repo (CI uses the same recipe).

---

## 1. Build the sidecar from this branch

From the worktree, cross-build or native-build the sidecar. Native (on Windows,
in WSL with mingw — the recipe CI uses):

```bash
cd sidecar
CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++ \
  GOOS=windows GOARCH=amd64 \
  CGO_CFLAGS="-I$(pwd)/include" CGO_CXXFLAGS="-I$(pwd)/include" \
  go build -o jarvis-sidecar.exe .
```

Or `make build` on a Windows host. Install it where the daemon expects the
sidecar binary (replace the one the daemon launches), or point the daemon at it.

**Pass criteria:** builds with no errors; the sidecar connects to the daemon and
`/api/sidecars` shows it `connected` with `desktop` + `browser` capabilities.

---

## 2. Start the daemon with the debug gate — FROM SOURCE, not the global install

**Critical:** `jarvis` on your PATH is the *globally-installed* daemon (old code —
no `/api/debug/rpc`, none of the Phase 0–5 changes). Do NOT use it. Run the
daemon from source **in the worktree**, with the env var set from the start (no
restart dance needed — the var only gates the debug route; pairing persists
independently):

```bash
cd /home/vierisid/jarvis/.claude/worktrees/control-plane-v2
# stop any other daemon first — only one can own port 3142
JARVIS_DEBUG_RPC=<pick-a-long-secret> bun run src/daemon/index.ts
```

The `/api/debug/rpc` endpoint does not exist unless this env var is set. Unset it
for normal runs afterward — it can drive the desktop.

Both the daemon (above) AND the sidecar (§1, the freshly-built `jarvis-sidecar.exe`)
must come from this branch. If either is the old installed build, the test is
measuring the wrong code.

---

## 3. Automated: acceptance suite (pass/fail gate)

```bash
JARVIS_DEBUG_RPC=<secret> bun bench/control/acceptance.ts
# writes bench/control/last-report.md
```

This drives the sidecar directly (no LLM) and checks the Phase 0 + Phase 1 exit
criteria. Watch for:

- **Phase 0:** bogus-exe launch errors honestly; Notepad launch reports a
  *visible window*; typing succeeds ≥95% over 20 runs; `list_windows` is fast
  (native path, <300ms); a stale element id returns the id-churn explanation;
  `find_element` "Save" surfaces "Save As…"; `win+r` opens the Run dialog.
- **Browser:** navigation to a dead host errors (not success); `browser_ax_snapshot`
  elements carry `sig` + `backend_node_id`; the AX payload is ≥8× smaller than a
  screenshot; Compose is found + AX-clicked; To/Subject set with read-back.
- **Desktop:** `get_window_tree {semantic:true}` emits sig/path/ordinal; sigs
  re-resolve ≥95% across a re-snapshot.

**Likely-to-need-tuning:** the browser suite depends on Gmail's accessibility
names ("Compose", "To recipients", "Subject", "Message Body", "Send"). If the
Compose step can't find its element, that's name drift — note the actual names
from a `browser_ax_snapshot` and we adjust the selectors + the `gmail-compose`
seed skill.

---

## 4. Automated: metrics (the regression numbers)

```bash
JARVIS_DEBUG_RPC=<secret> bun bench/control/metrics.ts --runs 5
# writes bench/control/metrics-report.md
```

Produces the success matrix + latency + structural-vs-screenshot payload
reduction. This is what fills the decision matrix in `PHASE1_ADOPT_VS_BUILD.md`.
Send me `metrics-report.md` — the token-reduction and latency numbers are the
Phase 1 exit evidence and the marketing/reliability claims made real.

---

## 5. Manual: things a harness can't judge

Do these by hand with the real agent (via voice or chat), watching the screen.

- [ ] **Open-then-type (the original bug):** "open Notepad and type hello world."
      Expect launch to wait for the window, then typing to land in Notepad —
      not "I can't find this."
- [ ] **ui_snapshot / ui_act:** ask the agent to open an app and click something
      by structural snapshot. Confirm it uses `ui_snapshot` (accessibility list),
      not a screenshot, and that `ui_act` reports what changed.
- [ ] **Ghost mode:** ask it to do a background action ("click X in the
      background") while you keep typing in another window. Confirm your cursor
      and focus are NOT stolen. If it reports `background_unavailable`, note which
      app/element — that tells us where PostMessage delivery falls short.
- [ ] **Run a seed skill:** `run_skill gmail-compose` with test params. If steps
      fail on element lookup, capture the failing step — almost always name drift.
- [ ] **Record a skill (the killer feature):** `record_skill start`, do a short
      task (e.g. open Notepad, type, save), `record_skill stop <name>`. Confirm it
      captured interactions and compiled a skill with parameters. Then `run_skill`
      it. This exercises the Windows input hooks — the least-tested code.
- [ ] **Small-model path (optional but valuable):** point a provider at a local
      7B–8B model via an OpenAI-compatible endpoint (or native Ollama) and repeat
      the Notepad flow. This validates the P0 Ollama fix + the small-model
      interface work.

---

## 6. What to send back

- `bench/control/last-report.md` and `bench/control/metrics-report.md`
- For any manual step that failed: the app, the step, and (if a lookup failed) a
  `browser_ax_snapshot` / `desktop_snapshot {semantic:true}` of the surface so I
  can see the real element names.
- Anything that felt slow, wrong, or dishonest — same complaint lens as the
  original audit.

Once this pass is in, we (a) fix what broke, (b) fill the Phase 1 decision matrix
from the real numbers, and (c) decide which deferred items (mac/linux parity,
grounding model, best-of-N wiring, browser attach, cua-driver) are worth building
— that decision is much better informed with real coverage/latency data than
without it.
```
