# JARVIS — Desktop & Browser Control Stack: Full Audit + Modernization Research

**Date:** 2026-07-13 · **Status:** audit complete, awaiting prioritization
**Scope:** why desktop/app/browser control is slow, why it fails with lower-end models, why it claims success falsely, the state of "web app templates," and what the 2025–26 open-source ecosystem (incl. Hermes) offers.
**Companion doc:** `STRUCTURAL_RUNTIME_ROADMAP.md` (the strategy). This audit **validates that roadmap's diagnosis with fresh evidence** and adds findings it doesn't cover (false-success paths, dual browser stacks, the Ollama provider bugs, ecosystem adoption options).

---

## 0. Executive summary — the three symptoms, root-caused

| Symptom | Root causes (all evidenced below) |
|---|---|
| **"It's slow"** | Per-call PowerShell process spawns — two tools recompile C# on *every* call (~0.7–1.5s each) (§1.1); 4+ WebSocket round-trip "dance" per logical action (§1.3); full depth-8 UIA dumps with 7 COM pattern-probes per element (§1.3); fixed sleeps everywhere (100ms–2s) (§1.2, §2.2); ~9k tokens of prompt+tool schemas resent every turn (§3.1); Chrome attach polls up to 15s with no retry strategy (§2.1) |
| **"Open Notepad works, typing into it fails"** | `desktop_launch_app` returns a PID **before the window exists**; nothing anywhere waits for the window (§1.4); element ids die on every snapshot (cache `.clear()`), so any two-snapshot flow guarantees dead ids (§1.5); `type_text` sends to "whatever is focused," never the launched app (§1.6); errors reach the model as raw HRESULTs or empty arrays it can't act on (§1.8) |
| **"It says it opened it, but it didn't"** | **Not one handler verifies its effect.** `win32Click` is a void function that literally cannot fail; Go `browser_navigate` returns `success:true` while ignoring Chrome's `errorText`; a 30s RPC timeout is reported to the model as "task dispatched, running in background" (§1.7, §2.4); the Ollama provider then *also* drops the model's own tool-call history, so local models can't even see what they did (§3.5) |

**Bonus finding:** there are **two complete, divergent browser implementations** (TS/WebSocket and Go/pipe) selected silently per-call — inconsistency is built in (§2.0).

**Web app templates verdict:** wired and live (YAML → SQLite → keyword match → prompt injection), but it's prompt-prose only, has no UI/API surface, ~4 dead exported functions, naive substring matching, and zero tests (§4).

**The good news:** the fix direction in `STRUCTURAL_RUNTIME_ROADMAP.md` is exactly what the 2026 ecosystem converged on — and the best pieces (cua-driver, a11y-snapshot-with-refs, Chrome auto-connect, skill caching) are MIT-licensed and adoptable rather than buildable (§5–6). "Hermes" = **Nous Research's Hermes Agent** (~214k★), and its acclaimed app control is literally a composition of those same adoptable pieces (§5.4).

---

## 1. Desktop control pipeline — findings

Pipeline: `orchestrator.executeTool()` (`src/agents/orchestrator.ts:720`) → `src/actions/tools/desktop.ts` → `routeToSidecar()` (`sidecar-route.ts:72`) → `manager.dispatchRPC()` (`manager.ts:660`) → WebSocket JSON → Go `handlers.go:52` → `sidecar/desktop_{windows,darwin,linux}.go`.

### 1.1 Per-call PowerShell spawns (dominant Windows latency)
Four of eight Windows RPCs spawn a fresh `powershell.exe` per call via `runPS` (`sidecar/desktop_windows.go:306-316`):
- `list_windows` (`:17-84`) and `focus_window` (`:240-277`) embed inline C# via `Add-Type @'...'@` → **csc.exe compilation on every call**: ~700ms–1.5s each. Nothing cached.
- `type_text` (`:157-166`), `press_keys` (`:185-194`), `launch_app` (`:221-229`): no csc, but still ~250–500ms pure process-spawn per call.
- Meanwhile `get_window_tree` / `click_element` / `find_element` run on a **persistent STA COM goroutine** (`uia_windows.go:82-155`) — fast. The fix is to route *everything* through that thread and delete the PowerShell layer.

### 1.2 Fixed sleeps in the action path
- 100ms sleep before every element-targeted type, all platforms (`desktop_windows.go:151`, `desktop_darwin.go:279`, `desktop_linux.go:403`, `desktop.ts:436`).
- 50–100ms `procSleep` inside every coordinate click (`uia_windows.go:778-795`).
- macOS `launch_app`: fixed 500ms + pgrep (`desktop_darwin.go:343`). Linux `xdotool type --delay 12` = 12ms/char (`desktop_linux.go:406`).

### 1.3 Round-trip and snapshot cost
One logical action = `list_windows → snapshot → find → click` = 4+ WebSocket round trips, each paying §1.1. `desktop_snapshot` walks to depth 8 (default, `desktop_windows.go:93`) with **7 `GetCurrentPattern` COM probes per element** (`uia_windows.go:494-517`) — hundreds×7 cross-process COM calls per snapshot, plus a big JSON payload the LLM re-reads every turn.

### 1.4 No wait-for-window-ready — THE "open then type" bug
`launch_app` (win) runs `Start-Process -PassThru` and returns the PID **immediately** (`desktop_windows.go:205-236`); Linux returns after `cmd.Start()` with zero delay (`desktop_linux.go:454-466`). **No code anywhere polls for a window to appear.** The next call hits `findWindowByPid` (`uia_windows.go:520-541`) → `"no window found for PID %d"` (`:538`). The agent gets an error with no retry signal — this is the reported second-step failure, verbatim.

### 1.5 Ephemeral ids churn on every snapshot
`uiaInspect` calls `state.cache.clear()` at the start of every snapshot (`uia_windows.go:611`), releasing all prior COM pointers — every previously returned `[id]` is dead. (Confirms roadmap §0 gap 1.) Stale ids yield `"element %d not found in cache — run desktop_snapshot first"` (`uia_actions_windows.go:19-21`), which triggers a re-snapshot that churns ids again. Name matching in `find_element` is **exact-equality only** — "Save" won't match "Save As…" (`uia_windows.go:653-680`, `desktop.ts:275-287`).

### 1.6 Focus is assumed, never ensured
`type_text`/`press_keys` send to whatever is focused (SendKeys `desktop_windows.go:159,188`; osascript `desktop_darwin.go:288`; xdotool `desktop_linux.go:406,423`) — never targeted at the launched PID. `double_click`/`right_click`/Invoke-fallback move the **real cursor** and click screen coordinates (`uia_windows.go:776-798`) — if another window overlaps, the click lands on it. `focus_window` is a separate manual step the model must remember. Also: `win` modifier is knowingly mapped to an "approximate" `^{ESC}` (`desktop_windows.go:337`).

### 1.7 Honesty: zero verification, structurally
Every handler returns `success:true` if the command didn't error:
- `launch_app`: success = process spawned, not window visible (all 3 platforms).
- `type_text`/`press_keys`/`set_value`: never read the value back (`desktop_windows.go:167-200`, `uia_patterns_windows.go:65-85`).
- `click_element`: `win32Click` is **void — cannot fail** (`uia_windows.go:776`); no tree-diff postcondition anywhere.
- `orchestrator.ts:883` stringifies `{"success":true}` straight into the model's context → the model truthfully-but-wrongly reports success.
- **Timeout masquerades as success:** after 30s (`protocol.ts:82-85`) the RPC resolves as `"detached"` → the model is told "Task dispatched … running in the background" (`sidecar-route.ts:107-109`) and the real result is discarded.

### 1.8 Error text is unactionable
Raw HRESULTs reach the model (`"Invoke failed: HRESULT 0x80004005"`, `uia_patterns_windows.go:33`). `find_element` miss returns `{"match_count":0,"elements":[]}` — **no near-miss candidate list** (`uia_windows.go:713,728`), so the model retries blindly.

### 1.9 Cross-platform reality
- **Windows:** UIA COM (good substrate) + PowerShell shell-outs (bad paths).
- **macOS:** reads the AX tree via JXA but **acts entirely by coordinates** (`cliclick`/Quartz, `desktop_darwin.go:239-264`) — structural perception, pixel action.
- **Linux:** AT-SPI only if `python3-gi` + `gir1.2-atspi-2.0` installed, else xprop stub (`desktop_linux.go:262-310`); actions via xdotool coordinates.

---

## 2. Browser control pipeline — findings

### 2.0 Headline: TWO live, divergent browser stacks
- **Path A (TS local):** `src/actions/browser/{session,cdp,chrome-launcher,stealth}.ts` — CDP over WebSocket to port 9222, daemon-launched Chrome.
- **Path B (Go sidecar):** `sidecar/browser.go` + `browser_pipe_{unix,windows}.go` — CDP over inherited fd 3/4 pipe (`--remote-debugging-pipe`).
- Selection is silent: `autoTargetForCapability("browser")` (`sidecar-route.ts:32-40`) — **if any browser-capable sidecar is connected, Path B wins**, else Path A. The two differ in element targeting, navigation waiting, stealth, profiles, and honesty → "sometimes works, sometimes lies" is partly *which stack ran today*. (`sidecar/browser_windows.go` referenced in old notes does not exist; the nhooyr websocket is only the sidecar control channel.)

### 2.1 Launch/attach
- Path A: static executable path lists incl. WSL2 (`chrome-launcher.ts:35-74`), isolated profile `~/.jarvis/browser/profile`, polls `/json/version` every 200ms up to **15s**, then hard-fails (`:222-246`). **One attempt, no retry/backoff.** Known trap: if a prior jarvis Chrome holds the fixed profile dir, the singleton lock makes the new process forward-and-exit → 15s timeout with no lock detection.
- Path B: better discovery (OS default browser + PATH, `platform_*.go`), per-brand temp profile, hand-rolled `CreateProcessW` fd-inheritance on Windows (`browser_pipe_windows.go:122-197` — fragile), attach polls 100ms up to 3s.
- **Ecosystem note (§5.3):** attaching a debug port to Chrome's *default profile* is broken since Chrome M136; Chrome 144+ ships an official auto-connect path for agents. Hand-rolled relaunch-with-port is a dead end.

### 2.2 Latency
Persistent connections in both (good). But: full `querySelectorAll` (~15 selector groups) + `body.innerText` snapshot on **every** navigate/snapshot (`session.ts:30-87`, `browser.go:642-663`); fixed sleeps — Path A: 800ms post-load, 1000ms post-click, 2000ms post-submit (`session.ts:205,279,341-353`); Path B: **unconditional `time.Sleep(1s)` after navigate** (`browser.go:385`).

### 2.3 Navigation waiting — divergent
Path A waits for `Page.loadEventFired` (30s) but **silently swallows the timeout** (`session.ts:187-203`). Path B waits for **nothing** — navigate, sleep 1s, snapshot (`browser.go:379-388`): SPAs get snapshotted mid-load.

### 2.4 Honesty
- **Path B `navigate` returns `success:true` unconditionally** — `Page.navigate`'s `errorText` (DNS failure, `net::ERR_*`) is **never checked** (`browser.go:390-395`). This is the literal "claims it opened Chrome when it didn't."
- Path B click on a missing element returns `{error:"Element not found"}` *inside a successful RPC result* (`browser.go:415-447`).
- Path A `click()` returns hard-coded `"Clicked element [id]"` with no outcome check (`session.ts:281`).
- No postcondition/re-snapshot-diff in either stack.

### 2.5 Targeting & structure
Path A: snapshot ids → viewport coordinates + `window.__jarvis_elements` DOM refs. Path B: **live index into a fresh `querySelectorAll` at click time** (`browser.go:428-436`) — the id can silently point at a *different element* if the DOM changed. **Neither supports iframes or shadow DOM.** Both attach to exactly one page target — no tab management; new windows are invisible. CDP's accessibility tree (`Accessibility.getFullAXTree`) is **unused** (roadmap already flags this).

### 2.6 Cruft
`browser_close` handler exists in Go with no LLM tool binding (`browser.go:615`, `handlers.go:72`); `stealth.ts` only on Path A; dead char-by-char typing branch in Path B (`browser.go:486-499`).

---

## 3. Why lower-end models fail — LLM/tool ergonomics

### 3.1 Tool bloat, no filtering
`getLLMTools()` sends the **entire registry — ~34-35 tools — on every request** (`orchestrator.ts:704-710`), for every task type. The codebase itself documents the cost: *"~5.6k-token prompt + ~32 tool definitions (~3.4k tokens) = ~10k tokens before every reply — the dominant per-turn latency"* (`agent-service.ts:696-703`). A lean prompt exists **only for voice** (`buildRealtimeVoiceInstructions`); the desktop/browser text path always pays full freight. Every extra schema is also a mis-selection distractor for a small model.

### 3.2 Schema quality
`toolDefToLLMTool` (`builtin.ts:35-58`) strips everything but `type` + `description` — **no enums, no examples, no defaults**. Worst offenders:
- `desktop_click.action`: a 12-value enum shipped as prose (`desktop.ts:369-373`); local executor silently supports only 4 of them (`desktop.ts:387-393`).
- `desktop_press_keys`: format-by-example only; `"ctrl+s"` parses as one bogus key (`desktop.ts:268-273,456-459`).
- `desktop_launch_app`: described as fire-and-forget; no "wait, then confirm window" guidance (`desktop.ts:476-477`).
- The only procedural guidance lives in 5.6k tokens of system-prompt prose (`tool-guide.ts:141-164`) — and even there, **the launch→confirm-window→type sequence is never scripted**.

### 3.3 Agent loop is fire-and-forget
`MAX_TOOL_ITERATIONS = 200` (`orchestrator.ts:43`); three near-duplicate loop implementations; no forced verification step after actions; no error classifier / retry scaffolding — failures are appended as plain `Error:` strings the model must notice on its own (`orchestrator.ts:371-391,891-893`). No orchestrator-level history compaction (only Ollama compacts).

### 3.4 System prompt optimizes for governance, not control
The biggest block is Intent Gating / approval rules (`prompt-builder.ts:155-179`); desktop procedure is thin and buried. No model-size-aware prompt for text tasks.

### 3.5 Ollama provider bugs (CRITICAL for local models)
- **(a) `convertMessages` drops assistant `tool_calls` entirely** (`ollama.ts:261-291`): the model replays a history where its own tool calls never happened — tool-only turns appear as *empty assistant messages*. It cannot see what it already did → re-issues steps, hallucinates success. `tool_call_id` is also never forwarded (b). The OpenAI-compatible provider does this correctly (`openai.ts:42-43`, `openai-compatible.ts:13-23`) — the same local model behaves better via an OpenAI-compatible endpoint than via native Ollama.
- **(d) 128-token generation cap:** orchestrator passes only `{tools}` — no `max_tokens` (`orchestrator.ts:360,449-463,570`); Ollama only sets `num_predict` when given one (`ollama.ts:99-106`), so generations default to **~128 tokens** and truncated tool-call JSON is reported as a normal finish (`ollama.ts:231,327`).
- (e) No temperature control for tool turns (model default ~0.8 → malformed JSON). (f) Hardcoded 32k context budget regardless of the model's real window (`ollama.ts:89,133`). (g) Screenshot blocks on `role:'tool'` messages likely never reach the vision model correctly (`ollama.ts:274-289`).
- Retry structure: 3 retries × 90s timeout per provider tier (`src/llm/manager.ts:25-26`) — up to ~270s burned on a stuck local model.

---

## 4. Web app templates — verdict

**What it is:** per-web-app browser playbooks as YAML (9 built-ins: gmail, gcal, gdocs, gsheets, gslides, gdrive, notion, slack, whatsapp in `webapp-templates/`), seeded to SQLite at startup (`daemon/index.ts:363`, `webapp-template-seeds.ts:81-116`), keyword/substring-matched against each user message (`webapp-templates.ts:169-212`), injected as prose into the system prompt (`prompt-builder.ts:193-199`).

**Verdict: wired and live — but prompt-prose only, and half-built:**
- ✅ The load → store → match → inject pipeline runs on every turn (incl. voice).
- ❌ No dashboard UI or HTTP API — manageable only by hand-editing YAML. The `enabled` column and 4 exported helpers (`getWebappTemplateByName/ByDomain/…`, `webapp-templates.ts:106-162`) have **zero callers** — a planned management layer that was never built.
- ❌ Matching reads the **chat message text only** — never the actual browser URL/active tab, despite the `domains` field implying URL awareness. (`getWebappTemplateByDomain` is unused *and* has a latent bug: gdocs/gsheets/gslides all claim `docs.google.com`.)
- ❌ Naive substring matching → multiple templates injected for one message.
- ❌ **Zero tests.**
- Strategic: roadmap §0 gap 3 already calls this out — instructions are markdown disconnected from the live tree; the planned replacement is parameterized, verified **Skills** (roadmap §1.5–1.6).

---

## 5. Online research — the 2026 landscape

### 5.1 Consensus architecture (what everyone converged on)
1. **Accessibility tree first, vision last.** A11y-API action cycles run **<200ms** vs 2–5s for screenshot+vision. Windows Agent Arena's own best config = **UIA tree + visual parser hybrid** ([paper](https://arxiv.org/pdf/2409.08264)).
2. **Snapshot-with-stable-refs as the LLM contract.** Playwright MCP (`ref=e12`), Stagehand (switched from raw DOM to a11y tree as default), Hermes (`@eN` refs), vercel agent-browser — all serialize a filtered a11y tree as numbered text elements + a tiny typed action space (`click(ref)`, `type(ref, text)`). This is *the* technique that makes 7B–32B/local models reliable.
3. **Verification + deterministic skill caching.** terminator's cached YAML workflows ("100x faster, >95% success" claims), Notte's script-first hybrid ("AI only on drift, 50%+ cost cut"), Hermes' self-improving skills. Matches roadmap §1.4–1.6 exactly.

### 5.2 Key projects (desktop)
| Project | What matters for us |
|---|---|
| **trycua/cua + cua-driver** (19.6k★, MIT) | The roadmap, already built: Windows UIA+MSAA layered fallbacks, PostMessage-first background input (no cursor theft, synthetic agent cursor), explicit `background_unavailable` errors, macOS AX + pid-scoped event posting, Linux AT-SPI + XTest/Wayland. Ships as CLI **and MCP server**. This is what Hermes uses under the hood. |
| **mediar-ai/terminator** (Rust, MIT, Windows-only) | "Playwright for Windows": UIA semantic targeting, deterministic YAML workflows + AI recovery, MCP server + Node/Python SDKs. Most embeddable Windows-side alternative. |
| **CursorTouch/Windows-Use / Windows-MCP** (Python, MIT) | Best reference for **tree-as-text serialization for small models** — 13 providers incl. Ollama, no vision model needed, 19-tool MCP surface. Copy the design. |
| **UI-TARS-desktop / UI-TARS-1.5/2** (ByteDance, 32k★) | Pure-vision opposite of our plan, but the leading open **grounding fallback weights** (UI-TARS-2: 50.6 WindowsAgentArena). |
| **Agent S3 (Simular)** | Orchestration ideas: planner/executor split, experience memory, best-of-N (72.6% OSWorld — above human baseline). |
| **Microsoft OmniParser V2 / Fara-7B / Magentic-UI** | OmniParser = screenshot→structured elements (license caveat: AGPL-tainted detector); Fara-7B = 7B pixels-only web CUA (73.5% WebVoyager) proving small on-device agents work; Magentic-UI = human-in-the-loop approval UX patterns for our Authority system. |
| **screenpipe** (mediar) | Awareness blueprint: event-driven capture **paired with a11y-tree text** instead of OCR — cheaper and searchable. |
| **Holo2 (H Company)** | Grounding-specialist models (4B/8B/30B-A3B; 66.1 ScreenSpot-Pro) to resolve elements the tree misses. |

### 5.3 Key findings (browser)
- **browser-use** (105k★): left Playwright for typed direct CDP; indexed interactive-element DOM+a11y representation; profile-sync to reuse the user's logged-in Chrome.
- **Stagehand**: a11y tree is now the default page representation; solved iframe stitching (we support neither iframes nor shadow DOM).
- **Chrome attach:** debug-port-on-default-profile is **broken since Chrome M136**; **Chrome 144+ has official agent auto-connect** (user opt-in at `chrome://inspect/#remote-debugging`, per-session permission), and Playwright MCP ships an extension/native-messaging mode to drive the user's real logged-in Chrome. Hand-rolled relaunch-with-port (our Path A) is a dead end; vendoring chrome-devtools-mcp or Playwright MCP beats maintaining bespoke CDP in Go.

### 5.4 Hermes, identified
**Nous Research's `hermes-agent`** (github.com/nousresearch/hermes-agent, ~214k★, MIT, v0.18.2 July 2026). Its acclaimed desktop/app control is a *composition of adoptable MIT pieces*:
- Desktop: **MCP-over-stdio to trycua's cua-driver** (UIA/AX/AT-SPI, background input, no cursor theft). Dual mode: screenshots for vision models or **`mode='ax'` tree-only with numbered elements for text-only models** — works with "any tool-capable model," incl. local OpenAI-compatible endpoints. Screenshot token budgeting (~1500 tok/image, keep 3).
- Browser: CDP attach to the user's own running Chrome (`/browser connect`) with logins intact; pages rendered as a11y snapshots with `@eN` refs.
- Reliability: **skills learned from experience** — repeated tasks become cached procedures instead of fresh reasoning.

**Implication: we don't compete with or embed Hermes — we adopt the same substrate under our own daemon.**

### 5.5 Benchmarks (July 2026)
OSWorld-Verified: frontier ~83–85%; Agent S3+bBoN 72.6% (above ~72% human baseline); open small models: UI-TARS-2 47.5, OpenCUA-7B 26.7. WindowsAgentArena: UI-TARS-2 50.6; best input config = OmniParser + UIA tree. WebVoyager saturated (~94% top OSS). **No leader runs PowerShell scripting or naive screenshots with a general LLM.**

---

## 6. Recommendations

### Tier 0 — Quick wins (days; fix real bugs before any rewrite)
1. **Fix the Ollama provider**: forward `tool_calls` + `tool_call_id` in `convertMessages` (`ollama.ts:261-291`); pass `max_tokens` + low temperature from the orchestrator (kills the 128-token trap). Likely the single biggest small-model reliability win.
2. **Wait-for-window after `launch_app`**: poll `findWindowByPid` up to ~5s before returning; return `{pid, window_title, hwnd}` or an honest "process started, window not yet visible". Kills the "open then type" failure.
3. **Stop lying**: check `Page.navigate.errorText` (`browser.go:390-395`); return Go errors (not embedded `{error:...}` JSON) from click/type; replace the `"detached"→"running in background"` masquerade for desktop tools; have `launch_app` success mean "window visible."
4. **Kill the per-call PowerShell/csc spawns**: move `list_windows`/`focus_window` onto the existing COM thread; replace SendKeys typing with `SendInput`.
5. **Actionable errors**: `find_element` miss returns nearest candidates ("not found; similar: …"); map HRESULTs to plain language.
6. **Pick ONE browser stack** (or at minimum make selection explicit + log which ran).

### Tier 1 — Small-model ergonomics (1–2 weeks)
7. Relevance-filter tools per task (`orchestrator.ts:704-710`) — a desktop task shouldn't ship 8 browser + workflow/goals/vault schemas.
8. Real JSON-Schema enums + "when to use" text + a scripted launch→confirm→type procedure in the desktop tool schemas.
9. Forced verify step in the loop: after any mutating desktop/browser action, auto-append a scoped snapshot/diff instead of trusting the model to check.

### Tier 2 — Structural (the roadmap, updated by this research)
10. **Adopt, don't build, the driver layer**: evaluate **cua-driver as the desktop engine** (MCP-over-stdio subprocess from the sidecar, exactly Hermes' integration) *or* terminator (Windows-only, Rust). This can replace the entire PowerShell/Win32 layer and delivers macOS/Linux background control we'd otherwise build in Phase 4. Spike it against roadmap Phase 0's acceptance test before committing to hand-building `SemanticRef`/resolver from scratch.
11. **Browser: attach, don't relaunch** — Chrome 144+ auto-connect or extension mode; consume CDP `Accessibility.getFullAXTree` snapshots with stable refs (roadmap Phase 0 browser provider), or vendor Playwright MCP/chrome-devtools-mcp instead of maintaining bespoke CDP.
12. **Skills over templates**: migrate `webapp_templates` markdown to parameterized, verified Skills (roadmap §1.5–1.6); interim, make template matching URL/active-tab-aware and add tests.
13. Optional **grounding fallback model** (Holo2-8B or UI-TARS-1.5-7B) for low-coverage surfaces, per the WindowsAgentArena hybrid finding.

### Success metrics (inherit roadmap §6, plus)
- "Open Notepad and type hello" with an 8B local model: ≥95% success, <6s end-to-end.
- Zero false-success reports: every mutating action verified or explicitly marked unverified.
- One browser stack; Chrome attach success ≥95% incl. already-running-Chrome case.
