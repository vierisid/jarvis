# Phase 1 — Adopt-vs-Build Gate: Working Notes & Decision Matrix

**Status:** spikes implemented, awaiting on-machine measurements (Windows) · 2026-07-14
**Companion:** `STRUCTURAL_RUNTIME_ROADMAP.md` (Phase 1), `CONTROL_STACK_AUDIT.md` (evidence base)

## Spike A — adopt cua-driver (verified facts, July 2026)

Source-verified against github.com/trycua/cua (primary URLs in commit history / research notes):

- **Packaging:** prebuilt binaries on GitHub Releases; latest `cua-driver-rs-v0.7.1` (2026-07-07), `cua-driver-rs-0.7.1-windows-x86_64.zip` = **7.76 MB**, with `checksums.txt`. Source: Cargo workspace at `libs/cua-driver/rust/` (9 crates). Not on crates.io/npm.
- **License:** MIT (repo + crate manifests); no GPL deps in the Windows platform crate. One flag: optional runtime ffmpeg install for *recording* features (we wouldn't use it). Audit/disable `telemetry.rs` phone-home before shipping.
- **Protocol:** `cua-driver mcp` = MCP JSON-RPC 2.0 over stdio (what hermes-agent spawns); also `serve` (daemon + socket), and **`call --tool <name> --json-args <json>`** one-shots (debug path; per-call process spawn). `manifest --pretty` is the machine-readable churn-protection contract — hermes deliberately doesn't pin versions and reads the manifest at runtime.
- **Tool surface is element-based, not just pixels:** `get_window_state`/`get_accessibility_tree` return a structured element list with **`element_token`** (opaque per-snapshot handle), role/label/bounds + optional screenshot; actions `click(element_index|x,y)`, `set_value(element_token)`, `type_text`, `hotkey`, `launch_app`, `bring_to_front`; shared `delivery_mode: background|foreground`; it self-reports low-coverage trees (Electron/games) and tells the model to fall back to pixels — i.e. it already implements our coverage-gate idea.
- **Hermes' `mode='ax'`** is nothing special on the wire: it just calls `get_window_state` and parses `structuredContent.elements` — the tree intelligence lives in cua-driver.
- **Maturity:** ~35 driver releases to 0.7.1, weekly cadence. Open Windows issues that matter to us: background-click misses in Chrome (#2201), foreground-delivery race (#2206), PID-only targeting ambiguity (#2200), Win10 classic Notepad failures (#2058). OS-level limits: can't automate elevated windows from a medium-integrity process; their installer registers an **elevated logon Scheduled Task** — we must NOT replicate that silently; the sidecar should supervise the child itself.

**Integration path (if adopted):** sidecar downloads + pins the release zip (checksum-verified) under `~/.jarvis/bin/cua-driver/`, spawns `cua-driver mcp` as a supervised stdio child, speaks MCP from Go, maps `structuredContent.elements` → `SemanticSurface` (element_token → `stableId`), honors `manifest`/`doctor --json` at startup.

## Spike B — build (status: implemented)

- `get_window_tree` with `semantic: true` now emits `{path, ordinal, sig}` per element from our own UIA walk (`sidecar/uia_windows.go`, `sidecar/semantic.go`), opt-in so default snapshots don't grow.
- Daemon-side `src/structural/` (types + resolver, 12 unit tests) implements the rot-proof scoring ladder; provider-agnostic — **needed under BOTH spike outcomes** (cua-driver's element_token is per-snapshot, so durable re-resolution is still ours to do).

## Browser spike (status: implemented)

- `sidecar/browser_ax.go`: `browser_ax_snapshot` (CDP `Accessibility.getFullAXTree`, filtered interactable-first list with `backend_node_id` + path/ordinal/sig refs), `browser_ax_click` (scrollIntoView + box-model center + real mouse events), `browser_ax_set_value` (native setter + input/change events + read-back verification). Element-addressed — no more live `querySelectorAll` index races.
- Attach strategy (auto-connect / extension mode) not yet implemented — next browser step after the acceptance test.

## Decision matrix (fill on Windows validation)

| Criterion | A: cua-driver | B: own UIA (semantic) | Notes |
|---|---|---|---|
| License | MIT ✅ (audit telemetry) | n/a (ours) | |
| Packaging weight | +7.76 MB pinned zip | 0 | |
| Cross-platform | Win/mac/Linux today ✅ | Windows only (mac/linux later) | Biggest A advantage |
| Background (no cursor theft) | ✅ designed-in, with open bugs #2201/#2206 | ❌ (foreground SendInput) | Phase 5 ghost-mode dependency |
| Tree quality on Slack/Outlook/Notepad | **measure** | **measure** | |
| Action latency (snapshot / click) | **measure** (stdio child) | **measure** (COM thread) | |
| Maintenance | upstream 0.x churn; manifest contract | our COM code, already written | |
| Elevated windows | blocked (same OS limit) | blocked | tie |
| Verification/self-heal | ours either way | ours either way | daemon `src/structural/` |

**Preliminary read:** the daemon-side structural core is required regardless; the driver choice is about *breadth* (A: mac/linux + background input for free, at the cost of an external 0.x dependency) vs *control* (B: no dependency, Windows-only, foreground-only). A pragmatic outcome is **B as default Windows engine + A as the optional engine behind a config flag** measured against the same acceptance test — the `SemanticSurface` model makes them interchangeable providers.

## What must be measured on the Windows machine (acceptance test, roadmap Phase 1)

1. Gmail (browser): `browser_ax_snapshot` → compose+send via `browser_ax_click`/`browser_ax_set_value`, zero vision tokens; token count vs screenshot baseline.
2. Slack or Outlook (desktop): `get_window_tree {semantic:true}` → drive compose+send via element ids; then resize/theme-change and confirm `resolveRef` re-finds the stored refs (≥95%).
3. Same flows through cua-driver (`cua-driver call` or MCP) for the matrix columns.
4. Exit: ≥90% step success, re-resolution ≥95%, ≥8× token reduction — whichever option wins.
