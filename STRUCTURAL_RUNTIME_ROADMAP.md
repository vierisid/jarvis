# JARVIS — Control Plane v2 · Structural Runtime Roadmap

**Codename:** Structural Runtime v2 (a.k.a. "ship the wedge, then push past it")
**Owner:** _TBD_ · **Status legend:** ☐ todo · ◐ in progress · ☑ done
**v2 changelog (2026-07-13):** rebuilt around the full control-stack audit + ecosystem research in `CONTROL_STACK_AUDIT.md`. v1's architecture (SemanticRef, resolver, verification, Skills, recorder) survives intact — the audit *confirmed* every gap it named with file:line evidence. What changed: a new Phase 0 (honesty/latency hotfixes — the current stack lies and stalls in ways no rewrite should inherit), an explicit **adopt-vs-build gate** (trycua's cua-driver already implements most of v1's target architecture, MIT, and is what Hermes runs on), a **small-model-native** track (the audit found provider bugs and tool-bloat that break local models regardless of runtime quality), and a **boundary-pushing** Phase 5 (background no-cursor-theft operation, speculative perception, self-benchmarking) so we don't just reach 2026 parity — we pass it.

**Thesis (unchanged, sharpened):** operate apps through their **own accessibility model** (UIAutomation / AX / AT-SPI / CDP ARIA), not pixels — *structural, rot-proof, cheaper-than-vision* — and make it **verified** (every action postconditioned), **honest** (no success without evidence), **small-model-native** (an 8B local model must be able to drive it), and **invisible** (background operation that never steals the user's cursor). The moat is stable-addressed + verified + recordable + governed structural operation. Nobody ships that as an owned end-user product — including Hermes, which composes the same MIT pieces but is cloud-model-first and has no authority/trust layer.

> **Evidence base:** `CONTROL_STACK_AUDIT.md` — every claim below about the current stack is file:line-cited there. Strategic frame: System 1 of the two-system reframe (System 2 = Trust Layer).

---

## 0. Ground truth after the audit

**What we have** (substrate worth keeping):
- Persistent UIA COM thread with pattern actions and element search (`sidecar/uia_*_windows.go`) — the one fast path.
- CDP sessions to Chrome from both TS and Go; macOS AX tree read via JXA; Linux AT-SPI via Python bridge.
- Tool routing, authority gating, prompt injection points — all real and load-bearing.

**What the audit proved is broken** (v1 underestimated some of these):
1. **The stack lies.** No handler verifies its effect: `win32Click` is void (cannot fail), `launch_app` success = "process spawned" not "window visible", Go `browser_navigate` ignores `Page.navigate.errorText`, and a 30s RPC timeout is reported to the model as "running in the background."
2. **The stack stalls.** `list_windows`/`focus_window` recompile inline C# in a fresh PowerShell *per call* (~0.7–1.5s); typing shells PowerShell per call; fixed sleeps (100ms–2s) pepper both stacks; snapshots probe 7 UIA patterns per element at depth 8.
3. **The launch→act race is unhandled.** Nothing anywhere waits for a window after `launch_app` — the direct cause of "opened Notepad, can't type into it."
4. **Two divergent browser stacks** (TS/WebSocket vs Go/pipe) are silently selected per call; neither supports iframes, shadow DOM, or tabs; the Chrome debug-port relaunch approach is dead upstream (broken for default profiles since Chrome M136).
5. **Small models are sabotaged before the runtime is even reached:** the Ollama provider drops assistant `tool_calls` from history and defaults to a ~128-token generation cap; ~35 tool schemas (~3.4k tokens) ship on every call with no filtering; desktop schemas have no enums and no launch→confirm→type procedure.
6. **Addressing rots by design** (v1 §0 confirmed): element ids are ephemeral integers cleared on every snapshot; templates are keyword-matched markdown prose disconnected from the live tree; no verification/self-heal anywhere.

**What the ecosystem now offers** (research, July 2026 — details + URLs in the audit §5):
- **trycua/cua-driver** (MIT): layered UIA+MSAA Windows control, PostMessage-first *background* input with a synthetic agent cursor (never steals the real one), macOS AX + pid-scoped event posting, Linux AT-SPI + XTest/Wayland, honest `background_unavailable` errors, ships as CLI + MCP server. **This is Hermes Agent's desktop engine** — Hermes (Nous Research, ~214k★) is a composition of cua-driver + CDP-attach + a11y-snapshot refs + learned skills.
- **Consensus LLM contract:** filtered a11y-tree serialized as numbered text elements with **stable refs** + a tiny typed action space (Playwright MCP, Stagehand, Hermes `mode='ax'`, Windows-MCP). This is what makes 7B–32B models reliable.
- **Chrome 144+ official agent auto-connect** (and Playwright-MCP-style extension mode) replaces debug-port relaunch.
- **Grounding-specialist small models** (Holo2, UI-TARS-1.5-7B) for the low-a11y-coverage residue; WindowsAgentArena's best config = UIA tree + visual parser hybrid.
- **Benchmark reality:** OSWorld frontier ~85%, Agent S3 above human baseline via best-of-N; nobody at the top runs PowerShell scripting or naive screenshots.

---

## 1. Target architecture (v1 core, kept — with v2 amendments)

```
┌────────────────────────────────────────────────────────────────┐
│  AGENT LOOP (orchestrator.ts)                                    │
│    tools: ui_snapshot · ui_act · run_skill · record_skill        │
│    v2: relevance-filtered tool set · forced post-act verify ·    │
│        slim control prompt · ax-text mode for non-vision models  │
├────────────────────────────────────────────────────────────────┤
│  STRUCTURAL RUNTIME (daemon: src/structural/)                    │
│   • SemanticSurface / SemanticNode / SemanticRef + Resolver      │
│   • Salience filter + coverage score (vision-last policy)        │
│   • Verifier (postcondition diff, self-heal ladder)              │
│   • Skill runtime + Recorder (src/skills/)                       │
│   • v2: Grounding fallback adapter (Holo2/UI-TARS, optional)     │
├────────────────────────────────────────────────────────────────┤
│  SURFACE PROVIDERS (sidecar RPC)                                 │
│   Option A: cua-driver subprocess (MCP/stdio) — adopt            │
│   Option B: enhanced native Go UIA/AX/AT-SPI — build             │
│   Browser: CDP attach (auto-connect ≥144 / extension / managed)  │
│            Accessibility.getFullAXTree + DOM refs                │
│   + Recorder observer (input hook × focused-element capture)     │
└────────────────────────────────────────────────────────────────┘
```

### 1.1 The model — `SemanticNode` / `SemanticRef` (unchanged from v1)

```ts
// src/structural/types.ts
type SemanticRef = {
  role: string;
  name: string;                 // accessible name
  stableId?: string;            // UIA AutomationId / DOM id / AX identifier when present
  path: Array<{ role: string; name?: string }>;  // ancestry from window/document root
  ordinal: number;              // disambiguator among same-signature siblings
  sig: string;                  // hash(role|name|stableId|path) — the DURABLE key
};

type SemanticNode = {
  ref: SemanticRef;
  role: string; name: string; value: string | null;
  state: { enabled: boolean; focused: boolean; selected?: boolean;
           expanded?: boolean; checked?: boolean; offscreen?: boolean };
  bounds: { x: number; y: number; width: number; height: number } | null;
  actions: string[];            // from supported UIA/AX patterns (invoke/toggle/setValue/expand…)
  children: SemanticNode[];
  sessionId: number;            // ephemeral [id] kept for in-turn ergonomics
};

type SemanticSurface = {
  provider: 'uia' | 'ax' | 'atspi' | 'cdp' | 'cua';   // v2: +cua
  root: { app: string; title: string; pid?: number; url?: string };
  nodes: SemanticNode[];        // salience-filtered by default
  coverage: number;             // 0–1: named-interactable bounds ÷ visible bounds
  capturedAt: number;
};
```

- **Resolver** (`src/structural/resolver.ts`): `resolveRef(ref, liveSurface) → {node, confidence}`; scoring `stableId (1.0) > path+name (0.8) > role+name+ordinal (0.6) > fuzzy (≤0.5)`. Below floor → self-heal ladder.
- **Salience + coverage**: interactable-first snapshot (~10× token cut), `full:true` opt-in; coverage <~0.4 ⇒ canvas/custom-drawn ⇒ vision fallback, **logged**.
- **Verify + self-heal ladder** (the reliability fix): every `ui_act`/skill step carries a postcondition (`element_gone | value_equals | element_present | title_changed | focus_moved | window_appeared`*)*; after acting, scoped re-snapshot + diff. On failure: ① re-resolve ② retry with settle ③ grounding-model/vision fallback (logged) ④ ask via Authority. *(v2 adds `window_appeared` — the launch→act race becomes just another postcondition.)*
- **Skills** (`src/skills/types.ts`, unchanged): parameterized `SkillStep[]` with refs + postconditions, `provenance: recorded|authored|marketplace`, `successRate`. Replaces `webapp_templates` markdown (which the audit found live but half-built: message-text-only matching, no UI, dead exports, zero tests).

### 1.2 v2 amendment — the LLM contract is a first-class deliverable

The audit's small-model findings mean the *interface* matters as much as the runtime:
- **`ui_snapshot` returns numbered text elements with refs** (`[3] button "Send" @b3f2` style) — consumable by non-vision local models (Hermes `mode='ax'` / Windows-MCP pattern).
- **Tiny typed action space with real JSON-Schema enums**: `ui_act(ref, action∈{click,set_value,toggle,select,expand,press_keys,focus}, value?)`. No 12-value prose enums.
- **Relevance-filtered tools**: a desktop task ships desktop tools, not 35 schemas.
- **Forced verification in the loop**: after any mutating act, the runtime appends the scoped diff to the tool result itself — the model doesn't get to skip checking.
- **Slim control prompt** with the scripted procedure the audit found missing (launch → wait window_appeared → snapshot → act → verify).

---

## 2. Phased plan

### Phase 0 — Stop lying, stop stalling (hotfix sprint on the CURRENT stack) · ◐ code complete 2026-07-13, awaiting Windows manual validation (branch `worktree-control-plane-v2`, based on the rebrand branch so it tests against the new voice system)
The rewrite must not inherit users' distrust. These are bounded bug fixes, all located in the audit:
- ☑ **Wait-for-window** (`P0: wait-for-window on launch + native Win32 window/input layer`): `launch_app` on all 3 platforms polls ≤5s for a visible window; success now means "window visible", with honest notes for windowless/exited processes; Windows falls back to process-name matching for packaged apps (calc→Calculator); Linux bails early when the process dies.
- ☑ **Honest results** (`P0: honest browser handlers`, `P0: honest RPC timeouts`): `Page.navigate.errorText` checked; navigate waits for the real `Page.loadEventFired` (10s cap, honest `loaded` flag) instead of a blind 1s sleep; click/type return real errors with live element counts; detached-RPC "running in the background" masquerade removed for all interactive tools (kept for `run_command` with an explicit "output will not be reported" caveat). Locked in by `sidecar-route.test.ts` + updated `handlers_test.go`.
- ☑ **Kill PowerShell-per-call** (`win32_native_windows.go`): `list_windows` native EnumWindows (~1ms, was ~0.7-1.5s C# recompile), `focus_window` native with actionable errors, `type_text` SendInput Unicode injection, `press_keys` SendInput VK chords (real Windows-key support).
- ☑ **Fix the Ollama provider** (`P0: fix Ollama provider for multi-step tool use`): tool_calls replayed in history, tool results anchored (tool_name + tool_call_id), num_predict default 4096, num_ctx pinned to the history budget (configurable `context_window`), temperature 0.2 default on tool turns. 9 new tests.
- ◐ **One browser stack**: per-call stack attribution now logged (`resolveBrowserTarget`); consolidation deliberately deferred to Phase 1's browser spike — deleting the TS stack now would strand daemon-only (no-sidecar) installs, and Phase 1's attach-first architecture replaces both anyway.
- ☑ **Actionable errors**: `find_element` miss returns up to 8 `similar` candidates + hint; HRESULTs translated to next-step guidance (`uiaOpError`/`hresultText`); stale-id error explains snapshot id churn.
- **Exit criterion:** "open Notepad and type hello" ≥95% over 20 runs with (a) Claude and (b) an 8B local model via OpenAI-compatible endpoint; zero false-success in a scripted failure suite (bad URL, missing app, occluded window).
- **⚠ Manual validation still required on a real Windows machine** (this branch was built/vetted via mingw cross-compile in WSL):
  1. Rebuild + install the sidecar (`make build` in `sidecar/` on Windows, or CI artifact).
  2. Notepad flow ×20: "open notepad and type hello world" — expect `launch_app` to return `window_visible: true` + title, typing to land in Notepad.
  3. Failure suite: `launch_app` a bogus exe (expect error), `browser_navigate` to `https://nonexistent.invalid` (expect navigation error, NOT success), `desktop_click` with a stale id (expect the id-churn explanation), `desktop_find_element` name="Save" in Notepad (expect `similar` with "Save As…" etc.), `desktop_press_keys` "win,r" (expect the Run dialog — first real Windows-key chord).
  4. Ollama path: same Notepad flow with a local 8B model via the native Ollama provider.

### Phase 1 — Adopt-vs-build gate (de-risk spike) · ◐ spikes implemented 2026-07-14, awaiting Windows measurements · **GATE THE PROGRAM ON THIS**
Run two desktop spikes + one browser spike against the same acceptance test, then decide. Working notes + decision matrix: **`PHASE1_ADOPT_VS_BUILD.md`**.
- ◐ **Spike A (adopt):** cua-driver — integration facts VERIFIED (MIT; prebuilt `cua-driver-rs-v0.7.1` win-x64 zip, 7.76 MB; `mcp` stdio server with element-token tree API — exactly Hermes' backend; `call` CLI for one-shots; `manifest` as the churn contract). Known risks recorded: 0.x churn, open Windows background-delivery bugs (#2201/#2206/#2058), telemetry to audit, and their installer's elevated Scheduled Task which we must not replicate. Remaining: on-machine latency/tree-quality measurements.
- ☑ **Spike B (build):** `get_window_tree {semantic:true}` emits `{path, ordinal, sig}` from our UIA walk (opt-in, no default payload growth); shared `sidecar/semantic.go` sig; daemon `src/structural/` model + resolver with the full scoring ladder (12 unit tests). RuntimeId skipped deliberately — not durable across sessions; sig/path/ordinal are the durable parts.
- ◐ **Browser spike:** `browser_ax_snapshot` / `browser_ax_click` / `browser_ax_set_value` implemented in `sidecar/browser_ax.go` (CDP `Accessibility.getFullAXTree`, backendDOMNodeId-addressed actions, set_value read-back). Remaining: attach-first strategy (① Chrome 144+ auto-connect ② extension mode ③ managed Chrome last resort — never debug-port-relaunch the default profile, dead since M136) and the chrome-devtools-mcp/Playwright-MCP vendoring evaluation.
- ☐ **Acceptance test (from v1):** drive **Gmail (CDP)** and **Slack or Outlook (desktop)** compose+send end-to-end with zero vision tokens; mutate the UI (resize/theme/relayout) and confirm ref re-resolution by `sig`; measure tokens vs screenshot baseline.
- **Exit criterion:** ≥90% step success on both flows, re-resolution ≥95%, ≥8× token reduction — via whichever option wins. Decision recorded with the matrix (latency / coverage / maintenance / license / packaging). Preliminary read: the daemon structural core is needed under both outcomes; leaning "B as default Windows engine + A as optional engine behind a config flag" — the SemanticSurface model keeps providers interchangeable.

### Phase 2 — Structural runtime core · ◐ core built 2026-07-14 (awaiting end-of-roadmap validation)
Daemon-side, provider-agnostic (needed whichever way Phase 1 goes):
- ☑ `src/structural/{types,resolver,surface,verifier,telemetry}.ts`; salience filter + coverage score; `ui_snapshot`/`ui_act` tools (`src/actions/tools/ui.ts`, registered in `BUILTIN_TOOLS`) with postcondition verify + self-heal ladder (re_resolve→retry→vision→ask); perception policy in `tool-guide.ts` (structural-first, vision-last). 23 structural unit tests. `ui_act` re-snapshots and returns a scoped diff so the model needn't snapshot again to confirm.
- ☐ Route awareness screen-capture to prefer structural where coverage is high (OCR stays for low-coverage) — screenpipe's "event + a11y-text" pattern. **Deferred to Phase 4/5** — awareness rewiring is higher-risk and not on the critical path to the acceptance test; the coverage score it needs already exists.
- ☑ Coverage/vision-usage telemetry (`src/structural/telemetry.ts`): every action records structural-vs-vision + coverage + verify outcome; vision fallbacks are logged with a reason (feeds §4 metrics + System 2 ledger). `perceptionStats()` exposes the structural ratio for the metrics harness.

### Phase 3 — Small-model-native interface · ☐
- ☐ Relevance-filtered tool sets per task class (`orchestrator.ts:704-710`).
- ☐ Real enums + when-to-use text on all control schemas; scripted launch→confirm→act procedure in the control prompt; slim prompt variant for text control tasks (the voice path already proved the ~10k→lean win).
- ☐ Forced post-act verify: runtime appends scoped diff to mutating tool results.
- ☐ `ax` text mode end-to-end with a 7B–32B local model as a CI target, not an afterthought.
- ☐ Optional **grounding fallback adapter**: Holo2-8B or UI-TARS-1.5-7B resolves elements when coverage is low (WAA's hybrid finding); strictly behind the coverage gate, always logged.

### Phase 4 — Skills + learn-by-watching (the killer feature) · ☐
- ☐ `Skill` store (`src/vault/skills.ts`), `run_skill` executor over `ui_act` with the self-heal ladder; migrate `webapp_templates` (dual-run; make matching URL/active-tab-aware in the interim; add the missing tests).
- ☐ Prompt swap: compact Skill index + `run_skill` instead of markdown prose injection — the model exits the per-click loop.
- ☐ Recorder: input hook × focused-element `SemanticRef` capture (`recorder_windows.go` first) → `ui_interaction` events; compiler coalesces steps, infers params, derives postconditions from snapshot diffs; secret redaction; Authority-gated.
- ☐ Hand-author 5 seed skills (Gmail, Slack, Calendar, Notion, Sheets) to validate the schema first.
- **Acceptance:** demonstrate a 6-step task once → parameterized skill replays; move one element → self-heal recovers. Author time <2 min.

### Phase 5 — Push the boundaries (past 2026 parity) · ☐
What none of the incumbents ship together — our headline capabilities:
- ☐ **Ghost mode (background operation):** actions via UIA patterns / PostMessage with a synthetic agent cursor — JARVIS operates apps *while the user keeps typing elsewhere*, never stealing focus or the real cursor. (Free if Phase 1 picks cua-driver; a scoped port if not.) Honest `background_unavailable` downgrade to foreground with user notice.
- ☐ **Speculative perception:** the awareness subsystem pre-warms `SemanticSurface` snapshots for the foreground app (event-driven, diff-only), so the agent's first action starts from a hot cache — perceived latency → near-zero.
- ☐ **Self-benchmark harness:** an OSWorld-style local suite (N tasks × M runs across Notepad/Chrome/Gmail/Slack) runnable nightly and on PR; publishes the success matrix + structural-vs-vision ratio + token cost. Reliability claims become regression-tested numbers — and marketing material.
- ☐ **Best-of-N for high-stakes steps:** Agent S3-style parallel candidate rollouts judged before irreversible actions (send/delete/pay), integrated with the Authority gate.
- ☐ **Cross-platform parity:** macOS acts via AX actions (not coordinates); Linux AT-SPI without the python3 dependency.
- ☐ **Marketplace hooks:** skill export/import (signed manifest), `successRate` surfacing, imported skills always run under Authority + ledger.

---

## 3. File-level change map (delta from v1)

| Area | Files | Change |
|---|---|---|
| Hotfixes (P0) | `sidecar/desktop_windows.go`, `sidecar/browser.go`, `src/actions/tools/sidecar-route.ts`, `src/llm/ollama.ts`, `src/agents/orchestrator.ts` | wait-for-window, errorText check, COM-thread migration, SendInput, tool_calls history, max_tokens |
| Model + resolver | `src/structural/{types,resolver,surface}.ts` (new) | SemanticNode/Ref, resolver, salience+coverage |
| Provider (A) | `src/sidecar/cua-bridge.ts` or Go subprocess mgmt | cua-driver MCP/stdio lifecycle, surface mapping |
| Provider (B) | `sidecar/desktop_windows.go`, `sidecar/uia_*_windows.go` | emit AutomationId/RuntimeId/path/patterns/state |
| Browser | `sidecar/browser.go` (or vendored MCP server) | attach-first strategy, `Accessibility.getFullAXTree` provider, iframe/tab support |
| Tools | `src/actions/tools/ui.ts` (new), `builtin.ts`, `desktop.ts` | `ui_snapshot`/`ui_act`/`run_skill`/`record_skill`; enums; relevance filtering |
| Skills | `src/skills/{types,runtime,compiler,recorder}.ts`, `src/vault/skills.ts` (new) | store/run/record; `webapp_templates` migration |
| Prompt | `src/roles/prompt-builder.ts`, `src/daemon/agent-service.ts` | perception policy, skill index, slim control prompt |
| Bench | `bench/control/` (new) | self-benchmark harness (P5) |

Legacy `desktop_*`/`browser_*` tools remain as the low-level escape hatch.

---

## 4. Success metrics (regression-tested via the P5 harness; targets from audit + ecosystem)

- **Honesty:** zero false-success — every mutating action verified or explicitly `unverified`; scripted failure suite stays green.
- **Latency:** structural action cycle **<300ms** (tree read <100ms); "open Notepad and type hello" **<6s end-to-end**; first action on foreground app <1s with speculative perception.
- **Small-model reliability:** the Notepad flow ≥95% with an 8B local model; ≥90% success on 8-step skills with verification.
- **Structural coverage:** ≥85% of actions on top-10 apps served with zero vision tokens; ≥8–10× token reduction vs screenshot baseline.
- **Rot-proofing:** ≥95% ref re-resolution after minor UI change.
- **Authoring:** 6-step demonstrated skill working + parameterized in <2 min.
- **Browser:** attach success ≥95% including already-running-Chrome; exactly one stack in the wild.

---

## 5. Risks & mitigations (v2)

| Risk | Mitigation |
|---|---|
| cua-driver dependency risk (external project, packaging weight) | It's the *spike option*, not a commitment; MIT allows vendoring/forking; Spike B keeps the build path warm; the daemon-side runtime (§1) is provider-agnostic either way |
| Chrome auto-connect requires user opt-in (144+) / older Chromes | attach ladder: auto-connect → extension mode → managed isolated-profile Chrome; never relaunch the default profile |
| A11y coverage varies (canvas/Electron/games) | coverage score + grounding-model fallback (Holo2/UI-TARS) + vision-last, all logged |
| Ref stability weaker on mac/linux (no AutomationId) | path+name+ordinal sig, lower confidence floor, more self-heal |
| Recorder captures secrets | redact password fields + secret patterns; local-only; Authority-gated |
| Scope creep vs rebrand branch | separate branch; rebrand is UI-only, non-overlapping |
| Phase 0 fixes reduce urgency, program stalls | Phase 0 exit test becomes the permanent regression floor; Phase 1 gate is time-boxed to 2 weeks |

---

## 6. Why this ordering

Phase 0 restores *trust* (the product lies today — no architecture survives that). Phase 1 spends two weeks to avoid six months (the ecosystem already built most of v1's target; we should prove we can't adopt it before hand-building). Phases 2–3 make the wedge real *and small-model-cheap* — the retention story ("works with the free local model, near-$0") depends on the interface as much as the runtime. Phase 4 converts one-off wins into compounding assets (recorded, verified, parameterized Skills — the marketplace artifact). Phase 5 is the boundary push: background ghost-mode operation + speculative perception + published self-benchmarks is a combination nobody — Hermes included — ships as an owned, governed end-user product.
