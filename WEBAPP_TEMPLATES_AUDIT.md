# Webapp Templates Audit — 2026-07-13

Full audit of the 9 templates in `webapp-templates/` ahead of the library expansion for launch.
Branch: `worktree-webapp-templates` (worktree at `.claude/worktrees/webapp-templates`, branched from `6fa5cfb`).

Audited against the **real runtime**, not the templates' own assumptions. Key source files:
- Matcher/injection: `src/vault/webapp-templates.ts:169-207` (case-insensitive **substring** match of app_name, domains, keywords against the whole user message; ALL matches inject their full instructions block)
- Seeder: `src/vault/webapp-template-seeds.ts` (repo `webapp-templates/` + `~/.jarvis/webapp-templates/` overrides; override dir currently empty)
- Browser tools: `src/actions/tools/builtin.ts:553-759`, `src/actions/browser/session.ts`
- Desktop keys: `src/actions/tools/desktop.ts:447`

## Verdict summary

| Template | Size (instr) | Verdict | Executable core? | State recognition |
|---|---|---|---|---|
| gmail.yaml (v4) | 13.4KB | **needs-fixes** | ✅ yes | ✅ present |
| whatsapp.yaml (v3) | 11.7KB | **needs-fixes** | ✅ yes | ✅ present |
| gcalendar.yaml (v1) | 37.7KB | **needs-fixes** | ✅ URL-first backbone | ✅ present |
| gsheets.yaml (v2) | 19.8KB | **needs-fixes** | ◐ read/nav yes, half of writes keyboard-gated | ❌ missing |
| gslides.yaml (v1) | 19.6KB | **needs-rewrite** | ❌ cannot edit slide content in-surface | ❌ missing |
| gdocs.yaml (v1) | 18.0KB | **needs-rewrite** | ❌ editor iframe invisible to snapshot | ❌ missing |
| gdrive.yaml (v1) | 17.6KB | **needs-rewrite** | ◐ nav/search yes, ALL mutations keyboard-gated | ❌ missing |
| notion.yaml (v1) | 19.5KB | **needs-rewrite** | ❌ create-page path can never work | ❌ missing |
| slack.yaml (v1) | 19.5KB | **needs-rewrite** | ◐ only via discouraged Send-button click | ❌ missing |

Pattern: **the two iterated templates (gmail v4, whatsapp v3) were written against the real tool API; the seven v1/v2 templates were largely written against an imagined one.**

---

## Systemic root causes (fix these BEFORE writing new templates)

### RC1 — Templates depend on capabilities the browser surface doesn't have
Actual browser tool surface: `browser_navigate(url, headless?)`, `browser_snapshot()`, `browser_click(element_id)`, `browser_type(element_id, text, submit?)` (submit = Enter only), `browser_scroll`, `browser_upload_file(file_path, selector?)`, `browser_evaluate`, `browser_screenshot`.
**No hover, no key presses (arrows/Tab/Escape/Ctrl+…), no right-click, no double-click, no drag, no wait, no tab switching.** Most templates also BAN `browser_evaluate`, removing the only escape hatch.

- gdocs/gdrive/gsheets/gslides/notion/slack build their golden paths on `desktop_press_keys`. That tool exists (`desktop.ts:447`) but is an **OS-level injector to the focused desktop window** — not the CDP browser session. It breaks silently if the browser is headless (Chrome auto-falls back to `--headless=new` with no DISPLAY, `chrome-launcher.ts:205`), unfocused, remote (browser and desktop can route to different sidecars), or under `--no-local-tools`. No template checks any of these preconditions. Keystrokes landing in the wrong window can be destructive.
- **Chrome-reserved shortcuts can NEVER work even with desktop keys**: Ctrl+N (notion "create page" — opens a browser window instead), Ctrl+Shift+N (incognito), Ctrl+1..9 (slack workspace switch — switches browser tabs), Ctrl+F5.
- **Hover-gated dead ends** (button not in DOM until mouseover, so never in a snapshot — `session.ts:35-38`): whatsapp reply/react/forward/delete/star; slack react/save/first-thread-reply; notion block handles.

### RC2 — `browser_type` CLEARS the element before typing (`session.ts:300-319`)
Select-all + delete, then paste-like `Input.insertText` (no per-char keydowns). Consequences no template acknowledges:
- Every two-step typing recipe is wrong (notion `"# "` then title; slack multi-line "First line" then "Second line"; mention `"@"` then name) — the second call wipes the first.
- **Data-loss bugs**: notion "append to page" clears the last block's existing content; gmail "forward with a note" clears the quoted message in the body.
- Markdown/slash autoformat triggers that depend on real keystrokes may not fire on insertText at all (notion Pattern D premise unverified).

### RC3 — Snapshot is iframe-blind and canvas-blind (`session.ts:30-87`)
Top document only, `innerText` capped at 8000 chars. Google Docs' typing target lives in `docs-texteventtarget-iframe` and its page is canvas-rendered — **gdocs' promised "editor contenteditable in the snapshot" can never appear, and document text can't be read**. gslides' central "contenteditable appears in edit mode" mechanism is asserted, never captured.

### RC4 — Wrong `browser_upload_file` signature documented in 3 templates
Real: `(file_path, selector?)` — CSS selector, defaults to `input[type="file"]`, works via `DOM.setFileInputFiles` **without clicking the attach button** (clicking may open a native OS picker that CDP can't drive — gmail's attach flow does exactly this). notion.yaml:63, slack.yaml:62, gdrive.yaml:65 all document `browser_upload_file(element_id, path)`. whatsapp.yaml has it right.

### RC5 — Keyword/matching hygiene causes false and contradictory injection
- Generic keywords hijack unrelated requests: whatsapp `send a message to` / `check messages`; gdrive `find a file` / `create a folder` / `delete the file` (local-filesystem ops in a desktop-agent product!); gslides `presentation`; gcalendar `create event` / `what do i have` / `reschedule`; gsheets `enter data` / `add a row` / `find and replace` / `add a tab`; gdocs `take notes` / `word count` / `read the doc` (matches "read the docs").
- App names that are English words: "notion", "slack" ("cut me some slack" injects 19.5KB of Slack instructions).
- ~90 keywords are pure dead weight: all 45 notion keywords and 41/43 slack keywords contain the app name, which already substring-matches.
- **Domain collision**: gdocs, gsheets, gslides all claim `docs.google.com` — one pasted Docs link injects all three (~57KB).
- Substring shadowing: "add a row in notion" injects Sheets+Notion; "find and replace in the doc" injects Docs+Sheets.
- **Co-injection is contradictory**: whatsapp/gmail say "NEVER use desktop tools"; gdocs/gsheets/gslides/gdrive/notion/slack mandate `desktop_press_keys`. "send a message to John on Slack" injects both policies into one system prompt.
- Missing obvious triggers: `google doc`/`google sheet` (singular — common phrasing matches nothing), `powerpoint`/`ppt`, `rsvp`/`accept the invite`, gmail task verbs (`archive the email`, `email John`, `draft an email`).

### RC6 — Injection cost
11–38KB (~3–10K tokens) per match, multiplied by co-injection. gcalendar alone is 37.7KB. Templates quadruple-state the same rules (CRITICAL RULES / FORBIDDEN / Gotchas / Rules) and carry 30–60-line shortcut catalogues that are unexecutable dead weight.

---

## Per-template highlights (full details in agent reports, session 2026-07-13)

### gmail.yaml — needs-fixes (best of the nine)
Correct tool whitelist, real-snapshot selectors (`name="q"`, `name="subjectbox"`, href `#sent`), login-wall state recognition, retry cap. Fix: attach flow (drop the button click, call `browser_upload_file(path)` directly); rule 3 "snapshot after EVERY action" contradicts the 10-call budget; forward-body clobber (RC2); positional Delete="4th toolbar button"/Archive="2nd" on destructive actions with verification that can't distinguish delete/archive/spam; star task can't bind star N to row N. Coverage gaps: reply-all, labels (description promises them, zero content), mark read/unread, CC/BCC, drafts, spam, schedule send. Keywords too narrow (see RC5).

### whatsapp.yaml — needs-fixes (the structural exemplar)
Open/send/read/search/media flows are the only ones in the directory that exactly match real tool semantics. Dead: reply/react/forward/delete/star (hover-gated, triple-locked by evaluate ban + "no workarounds" rule). Bugs: line 168 tells the model to use `run_command`, which its own rules ban; `data-testid="selectable-text"` verification selector likely stale (WhatsApp removed most testids in 2023) — success may read as failure and cause double-send; zero locale handling (all selectors English; "Favourites" betrays single-locale capture). Six of eight keywords are generic messaging phrases (RC5).

### gcalendar.yaml — needs-fixes
Excellent URL-first backbone (prefilled `eventedit` create, view/date/search URLs, click-based delete/edit/RSVP) and the only Google template with state recognition. But: flagship create step literally says `browser_type` a "Ctrl+Enter keystroke" — would type that string into the title; ~80 lines of unexecutable keyboard content; **duplicated/misnumbered final rules block (9-12 then 9-10 again)** shipped into the prompt; toast-text verification contradicts its own "never match locale text" rule ×3; Save/Cancel disambiguation underspecified once locale text is banned. 37.7KB — needs a heavy trim. Gaps: find-free-slot across a range, propose-new-time, duplicate event, OOO/focus/tasks.

### gsheets.yaml — needs-fixes
Honest engineering around the canvas grid: Name Box navigation, formula-bar reads, `submit=true` cell writes, URL `#gid`+`range` — all executable and good. But: **raw drafting artifact shipped in the prompt** (lines 277-280: "Wait — B1 needs 'Calories'. Let me navigate…" with duplicated step numbers); "empty" cells written as `" "` (single space — breaks ISBLANK/COUNTA); half the tasks keyboard-gated (formatting, insert/delete rows, sort, filter, find/replace, tabs); keyword "rename the sheet" triggers a task that renames the document, not the tab; positional find/replace dialog selectors. No state recognition, no view-only detection. Gaps: charts, pivot tables, conditional formatting, freeze, export CSV, share.

### gslides.yaml — needs-rewrite
Without desktop keys it can create/open/rename/read decks but **cannot put a single word on a slide** — the entire editing model is Tab/Enter/Escape + Ctrl+M, with evaluate banned. The load-bearing "contenteditable appears in edit mode" claim was never captured from a real snapshot. No content verification (build-deck verifies thumbnail count only). `presentation` is the single worst keyword in the library. No state recognition.

### gdocs.yaml — needs-rewrite
Double-dead: cursor control is 100% keyboard (no menu-click fallback given, though the menu bar IS clickable DOM), AND the editor lives in an iframe the snapshot can never see (RC3), so even the typing path and the "read the doc from Page Text" claims are unfounded. Copy-paste residue from the Slides template ("find the **deck** title INPUT", line 239). Survives: create/open/rename/share. Keywords: `read the doc` matches "read the docs", `insert a comment` matches code requests; `google doc` singular missing.

### gdrive.yaml — needs-rewrite
Split personality: URL navigation + search operators section is the best material in the library (keep verbatim). But **every mutation** (open! rename, move, delete, share, star) routes through single-letter shortcuts — and "open a file" has NO executable path (single click only selects; no Enter, no double-click). The clickable toolbar path its own line 183 describes is never used by any task. Wrong upload signature (RC4). Keyword `restore from trash` has no corresponding task. **Worst trigger set**: `find a file`, `create a folder`, `delete the file`, `list files in` — local-filesystem phrases in a desktop-agent product. Missing: download-a-file (most common Drive task), permission levels, copy link.

### notion.yaml — needs-rewrite
The central task — create a page — is wired through Ctrl+N, which Chrome intercepts (opens a browser window): **can never work, no click fallback given** ("no stable create URL" — but the sidebar "+ New page" button exists). Append-to-page **deletes the last block's content** (RC2). Every two-step typing recipe (markdown prefix, slash menu, @mention, [[link]]) breaks on clear-before-type. Teaches "ids are positional, try [id]+1 optimistically" — the opposite of the exemplar's discipline. All 45 keywords redundant; app_name "notion" matches the English word. No state recognition (no login/SSO handling).

### slack.yaml — needs-rewrite
Both declared golden paths (Ctrl+K Quick Switcher, Ctrl+Enter send) are out-of-surface, while the executable paths (sidebar channel links, Send button — both visible in its own snapshot format) are actively disparaged as fallbacks. Multi-line messages impossible (RC2). Ctrl+1..9 workspace switch is Chrome-intercepted. React/save/first-thread-reply hover-gated with no fallback; the thread "click the timestamp" workaround is dubious (opens permalink, not thread pane). Wrong upload signature. No login/SSO/"open in app?" interstitial handling — a fresh browser hitting app.slack.com almost always lands there. `post to channel` / `post in channel` false-positive on Discord/YouTube/Telegram.

---

## Recommended fix plan

### P0 — platform decisions (block template work on these)
- ☑ **Decide the interaction contract.** DONE 2026-07-13: added CDP-level primitives to the browser tool surface — `browser_press_key` (Input.dispatchKeyEvent incl. modifiers, combo strings like "Ctrl+K"/"Shift+Enter"; parser in `src/actions/browser/keys.ts`), `browser_hover` (trusted mousemove; reveals hover-only UI for the NEXT snapshot), `button: "right"` / `double: true` on `browser_click`. Implemented in `session.ts` + `builtin.ts` (incl. `createBrowserTools` bound set) AND mirrored in the Go sidecar (`sidecar/browser_input.go`, registered in `handlers.go`) so sidecar-routed browsing has the same surface. Verified by integration tests against real headless Chromium (`src/actions/browser/browser-primitives.test.ts`): hover-reveal, modified keys, dblclick/contextmenu all dispatch as trusted events. NOTE for templates: Chrome-reserved shortcuts (Ctrl+N, Ctrl+T, Ctrl+1-9) still never reach the page — the press_key tool description says so.
- ☑ **Fix `browser_type` clear-before-type**: added `append: true` param (caret-to-end for inputs, collapse-selection-to-end for contenteditable); default replace behavior now documented in the tool description. Go sidecar `browser_type` gained the same `append` param. Covered by integration tests (append on input + contenteditable preserves existing content).
- ☑ **Sidecar/local browser parity** DONE 2026-07-13 (`sidecar/browser_snapshot.go` new, `browser.go`/`browser_input.go` rewritten): the Go sidecar now runs the daemon's exact SNAPSHOT_SCRIPT (same selector list incl. role=row/gridcell/textbox/contenteditable, visibility filtering, 1-based ids, `window.__jarvis_elements` refs) and a faithful port of `formatSnapshot`, so sidecar-routed browsing returns the identical "Page: / --- Page Text --- / --- Key Elements --- / --- Interactive Elements ---" text the templates are written against (handlers return STRINGS; `routeToSidecar` passes strings to the LLM verbatim). Click/hover/type resolve ids against snapshot-stored coordinates (no more re-querying a different selector list — clicks land where the snapshot said); click is trusted CDP Input events (not `el.click()`) with right/double support; type has the daemon's clear/append + contenteditable semantics + coordinate-click/Ctrl+A fallback; scroll takes PIXELS (the old sidecar treated amount as "screens" ×100 — silent 100× mismatch, fixed); evaluate unwraps to the daemon's string format; navigate now waits for `Page.loadEventFired` (CDP event waiting added to the pipe client) + 800ms settle instead of a blind 1s sleep. Error strings match the daemon's ("Error: Element [N] not found. Run browser_snapshot first."). Also fixed: `elementCenter` symbol collision with `uia_actions_windows.go` that would have broken the Windows build (function removed in favor of stored coords). Verified by `sidecar/browser_parity_test.go` — a full integration test driving the real RPC handlers against headless Chromium over the CDP pipe (navigate/snapshot format, hover-reveal→click, replace/append type on input+contenteditable, Ctrl+K, right/double-click, scroll, stale-id message) plus formatter unit tests. NOTE: Windows cross-compile can't be verified from WSL (webview_go cgo); the collision fix removes the known breakage, but the next Windows build should confirm.
- ☑ **Matcher hardening** DONE 2026-07-13 (`src/vault/webapp-templates.ts` + tests): word-bounded matching for app names AND keywords ("notions"/"gcalc"/"rescheduled" no longer hit; homonyms like "cut me some slack" still do — word boundaries can't fix those, trigger choice must); scored matches via `matchWebappTemplatesScored` (app name +100, domain +50+len, keywords +5+len capped at 3); **explicit-beats-keyword**: if any template is named explicitly (app name/domain), keyword-only matches are dropped — "send a message to John on Slack" now injects ONLY Slack; keyword-only requests inject the single best match; domain shadowing (docs.google.com/spreadsheets beats docs.google.com); `formatWebappInstructions` caps injection at 40K chars, skipping overflow templates with a visible one-line pointer. `getWebappTemplateByDomain` now supports path-qualified domains, most-specific wins. DATA FIX: gdocs/gsheets/gslides domains are now path-specific (`docs.google.com/document|spreadsheets|presentation` + sheets/slides.google.com aliases) — a pasted link injects exactly one template.
- ☑ **Template lint harness** DONE 2026-07-13 (`scripts/lint-webapp-templates.ts` + tests, `bun run lint:templates`): schema check; unknown `browser_*` tool references; `desktop_press_keys`/`run_command` in browser templates; Chrome-reserved shortcuts (Ctrl+N/T/W/1-9, both "Ctrl+N" and "ctrl,n" syntaxes); wrong `browser_upload_file(element_id, …)` signature; keyword genericity vs a 32-sentence non-webapp corpus; redundant app-name-containing keywords; cross-template keyword shadowing; missing login/state handling; positional selectors on destructive actions; size budget (warn >12KB, error >24KB). **Baseline on current templates: 76 errors / 23 warnings** — this is the P1/P2 debt list; exit code 1 until clean, so don't wire into pre-commit until the rewrites land. New/rewritten templates must be lint-clean.
- ☑ **Snapshot iframe support** DONE 2026-07-13 (both `src/actions/browser/session.ts` and `sidecar/browser_snapshot.go`, kept in lockstep): SNAPSHOT_SCRIPT now traverses same-origin iframes recursively (depth ≤3, ≤10 frames; cross-origin frames skipped safely) with element click coordinates offset into top-page space, an `iframe="true"` attr in the snapshot output (also printed by both formatters), and frame body text appended to Page Text. **Typing-target exemption**: `contenteditable`/`role=textbox` elements are kept even when tiny/clipped/transparent (only `display:none` excludes them) — this is exactly the Google Docs pattern, whose real input hides in a 1×1 clipped iframe. `browser_type`'s contenteditable clearing/append now uses the element's OWN document/window selection (`el.ownerDocument`), so typing into iframe editors works. Verified on both sides against real Chromium: offset-coordinate clicks reach buttons inside frames, inputs in frames are typable, and a simulated Docs 1×1-iframe contenteditable is captured, typable, and append-safe. **Unblocks the gdocs rewrite** (P2) — the editor element the template promised can now actually appear in a snapshot. Note: Docs' canvas-rendered document TEXT still can't be read from innerText; the gdocs rewrite should verify what the texteventtarget iframe exposes during the live-capture pass.

### P1 — fix the salvageable four (ALL DONE 2026-07-14 — lint: 0 errors / 0 warnings for all four; library baseline now 49 errors / 12 warnings, ALL in the P2 five)
- ☑ gmail **v5** (11.7KB, 22 keywords): attach flow no longer clicks the paperclip (direct `browser_upload_file(path)` + chip verification); checkpoint-snapshot rule replaces the contradictory snapshot-after-every-action rule (happy path 8 calls); replace-vs-append semantics stated prominently and enforced in reply/reply-all/forward/draft (forward clobber fixed); Delete/Archive matched by aria-label with outcome-distinguishing verification (#trash / in:anywhere), never positional; star via open-email header star; NEW tasks: reply-all, CC/BCC, label, mark read/unread, resume draft; Escape-to-abort-compose via press_key; task-verb keywords added (archive/delete/star the email, search my email, unread emails, draft an email, reply all, send a mail, inbox zero).
- ☑ whatsapp **v4** (11.7KB, 0 keywords — app name + domain carry the trigger): run_command line removed (file must be under home dir, else tell user + stop); reply/react/forward/delete/star ALL EXECUTABLE now via hover→snapshot→click; NEW edit-sent-message task; verification moved off stale `data-testid` onto Page Text with explicit no-retype/double-send rule; wait-5s rephrased to re-snapshot; locale note added (match by role/structure on non-English UIs); pin/archive upgraded to real right-click on the chat row.
- ☑ gcalendar **v2** (10.3KB — was 37.7KB, 73% cut; 33 keywords): save = `browser_press_key("Ctrl+Enter")` + structural button fallback (the type-the-string-"Ctrl+Enter" bug is dead); duplicated rules footer deleted; shortcut catalogue + Quick Add section cut (only Ctrl+Enter/Escape/e/Delete/t// survive inline); Ctrl+A edit recipes replaced by browser_type's replace-default; toast verification replaced by URL/tree state; URL-patterns table kept intact; NEW free-slot task; coding-collision keywords removed (`create event`, `what do i have`, bare `reschedule`, …) and intent keywords added (rsvp, accept/decline the invite, calendar invite, find a time for, book a call).
- ☑ gsheets **v3** (9.2KB — was 19.8KB; 23 keywords): shipped drafting artifact + 63-line calorie walkthrough replaced by a 9-step generic table pattern; fake-empty `" "` cells banned (Tab/Name-Box past instead, ISBLANK rationale); every desktop_press_keys → browser_press_key or a menu-click path (insert/delete rows, sort, filter, number formats via menus); find/replace label-based with outcome verification; NEW State Recognition incl. view-only detection + 2-retry stop; document-rename vs sheet-TAB-rename split (tab rename uses real double-click); `google sheet` singular + `pivot table` keywords added, 13 generics removed.

REMAINING P1 SUB-ITEM:
- ☐ **Live-capture pass for the four fixed templates**: re-verify every element reference from real `browser_snapshot`s on the current app UIs (WhatsApp aria-labels were captured from an en-GB build; Gmail selectors predate this rewrite). Needs the user's logged-in browser on the Windows side. Record locale variance while at it.

### P2 — rewrite the five (ALL DONE 2026-07-14 — **library-wide lint: 0 errors / 0 warnings across all 9 templates**, was 76/23 at audit; lint now wired into `.githooks/pre-commit`)
- ☑ gdrive **v2** (11.4KB, 11 keywords): URL-patterns + search-operators kept verbatim; mutations are SELECT→ACT (click row → aria-label toolbar; single-letter press_key secondary; right-click context menu third); open-a-file finally works (double-click or select+Enter, URL-verified); upload = direct `browser_upload_file(path)` with never-click-New→File-upload rule; NEW: download, restore-from-trash, share-with-role, copy-link tasks + State Recognition; local-filesystem keyword hijackers replaced with drive-scoped set.
- ☑ slack **v2** (10.7KB, 1 keyword: `huddle`): click-first nav (sidebar links primary, Ctrl+K secondary with confirm-before-Enter); sends via submit:true or Send button as equals; multi-line via Shift+Enter + append:true; react/thread-reply/save/edit/delete all real via hover→snapshot→click (timestamp hack deleted); workspace switch = left rail click (Ctrl+1..9 gone); NEW State Recognition incl. SSO/interstitial/never-type-credentials + wrong-recipient rule #1.
- ☑ notion **v2** (9.2KB, 0 keywords): create-page via sidebar button (Ctrl+N eradicated); TYPING MODEL section with RECIPE A (safe append: last block → End → Enter → type new block; data-loss bug dead) and RECIPE B (slash menu via real "/" keydown → click entry); insertText-may-not-trigger-autoformat warning encoded; id-guessing advice removed; State Recognition added.
- ☑ gslides **v2** (9.1KB, 17 keywords): Tab/Enter/Escape triad kept but on press_key with EDIT-AND-VERIFY (text must appear in Page Text/thumbnail text — count-only verification banned); present via Slideshow button (Ctrl+F5 gone); reorder via right-click/menu; upload direct; bare `presentation` keyword killed; State Recognition + view-only detection added.
- ☑ gdocs **v2** (9.6KB, 26 keywords incl. `google doc` singular): HONEST contract — reading/summarizing body text explicitly unsupported (canvas; old claims deleted), comments dropped, mid-document edits limited to find-replace; THE WRITE RECIPE: cursor via press_key (Ctrl+End/Home) → type into the `iframe="true"` contenteditable with append:true ALWAYS → verification declared weak where it is; Slides "deck title" residue fixed; State Recognition + Viewing/Suggesting detection added.
- ☐ **Live-capture pass** (LAST OPEN ITEM before P3): re-verify element references from real snapshots on current app UIs. The five P2 rewrites carry **56 `[LIVE-VERIFY]`-marked lines** as the worklist (slack 17, gdocs 11, gdrive 10, notion 10, gslides 8; grep `LIVE-VERIFY` webapp-templates/). The two critical items: (1) real Google Docs — does the texteventtarget iframe contenteditable appear in snapshots and does append-typing reach the document; (2) WhatsApp/Gmail label refresh + locale variance (en-GB capture noted). Needs the user's logged-in browser on the Windows side (daemon routes browser to the Windows sidecar).

### P3 — library expansion (launch)
☑ DONE 2026-07-14: all 14 candidates written; **library is now 23 templates, 0 lint errors / 0 warnings, 234KB instructions total, zero cross-template keyword/domain collisions**. Written WITHOUT live snapshots (user defers testing) — structured URL-first with `[LIVE-VERIFY]` markers on every uncaptured element claim.

| new template | size | kw | notes |
|---|---|---|---|
| github v1 | 11.1KB | 7 | read-anonymous OK; merge task refuses blocked PRs, never looks for override paths |
| twitter v1 | 11.1KB | 3 | app_name "Twitter" not "X" (single-letter hijack); verify-before-Post, no blind retry |
| linkedin v1 | 11.6KB | 7 | authwall/checkpoint handling; Apply/Easy-Apply gated behind explicit request |
| youtube v1 | 11.0KB | 3 | transcript task = the summarization path; player keys k/m/f/arrows; toggle-state guards |
| gmeet v1 | 8.5KB | 3 | presence safety: mute mic+cam pre-join, never join uninvited, never Admit/Deny unasked |
| discord v1 | 10.8KB | 0 | slack-v2 model; channel URLs primary |
| telegram v1 | 9.2KB | 0 | whatsapp-v4 model; right-click context menus; A/K client caveat |
| outlook v1 | 11.3KB | 4 | gmail-v5 mirror; consumer vs work host detection; kw: hotmail/o365/office 365 mail/microsoft mail |
| trello v1 | 10.8KB | 2 | no-drag rule #2 — all movement via card modal Move |
| jira v1 | 10.0KB | 3 | /browse/{KEY} + JQL URLs backbone; workspace-unknown → ask user; no-drag status dropdown |
| airtable v1 | 7.7KB | 0 | most conservative: grid = scan only, all reads/writes via expanded-record modal |
| reddit v1 | 10.1KB | 5 | "subreddit" kw carries real recall (not word-bounded-contained by app name); shreddit shadow-DOM caveat + old.reddit fallback |
| gmaps v1 | 7.5KB | 6 | URL-first (search/dir/place); canvas explicitly non-automatable; no-GPS ask-the-user rule |
| amazon v1 | 9.9KB | 4 | MONEY SAFETY rule #1: hard stop at cart, never checkout/Buy Now/payment, overrides "buy it" |

`[LIVE-VERIFY]` totals: 314 marked lines library-wide — this is the live-capture worklist (old + new together).

### P3.2 — expansion batch 2 (23 → 36 templates)
☑ DONE 2026-07-15: all 13 written; **library is now 36 templates, 0 lint errors / 0 warnings, 365KB instructions, zero cross-template keyword/domain collisions, 609 [LIVE-VERIFY] markers** (the live-capture worklist).

| new template | size | kw | notes |
|---|---|---|---|
| gitlab v1 | 11.7KB | 3 | github mirror; merge gate reports blockers incl. RUNNING pipelines and stops; self-hosted note |
| hackernews v1 | 8.3KB | 4 | friendliest DOM in the library; Algolia search; kw incl. "hn"/"ask hn"/"show hn" |
| stackoverflow v1 | 9.5KB | 1 | read-first (find + extract the fix); "stack trace" keyword deliberately rejected |
| linear v1 | 9.8KB | 0 | Ctrl+K palette as first-class pattern (click the entry, never blind-Enter); "linear" homonym noted |
| asana v1 | 10.5KB | 0 | no-drag via task fields; fragile date-picker flagged |
| confluence v1 | 10.3KB | 2 | domain `atlassian.net/wiki` (path-qualified so jira keeps bare atlassian.net); notion-style append-safe editing |
| dropbox v1 | 9.9KB | 0 | gdrive mirror: SELECT→ACT, no local-filesystem keywords |
| spotify v1 | 10.4KB | 5 | playback verified via player bar; volume slider honestly unsupported (drag) |
| instagram v1 | 12.0KB | 1 | GO SLOW rule (anti-automation flags): one action per request, refuse bulk like/follow/DM; challenge/rate-limit → STOP |
| wikipedia v1 | 7.8KB | 2 | read-only research; 2000-char Page-Text window scroll technique; editing unsupported |
| booking v1 | 9.0KB | 5 | search URL carries dates/guests; money hard-stop BEFORE the details form |
| ebay v1 | 10.8KB | 4 | bids are BINDING → refuse-safely task with watchlist alternative; cart hard-stop |
| zoom v1 | 11.2KB | 2 | /wc/ web-client URL rewrite; gmeet presence model; hard NEVER on recordings |

Batch-2 note: the launch hit a session usage limit twice — 11 files were written before the cut, ebay/zoom were written on resume, gitlab/instagram trimmed on resume. All agents completed after resume.

### P3.3 — expansion batch 3 (36 → 48 templates)
☑ DONE 2026-07-15: all 12 written, no session-limit interruptions this round. **Library is now 48 templates, 0 lint errors / 0 warnings, 480KB instructions, zero cross-template keyword/domain collisions, 902 [LIVE-VERIFY] markers.**

| new template | size | kw | notes |
|---|---|---|---|
| teams v1 | 11.6KB | 3 | slack-chat + zoom-presence fusion; "Start a post ≠ reply" trap; never recordings/organizer controls |
| twitch v1 | 10.9KB | 5 | Subscribe-is-paid never-click; chat-firehose honesty; mature gate asks first |
| gphotos v1 | 9.4KB | 4 | /search/{query} deep link is the killer feature; delete gated (named-in-this-request + 60-day note) |
| shopify v1 | 11.1KB | 3 | merchant money safety: never refund/cancel/payout/fulfill; edits explicit-only with save verification |
| figma v1 | 8.1KB | 0 | canvas = WebGL, contributes nothing; comments sidebar is the automatable surface |
| keep v1 | 8.9KB | 2 | Escape-is-save; append mandatory on existing notes; "sticky note(s)" recall keywords |
| todoist v1 | 9.4KB | 0 | quick-add natural language with parse-chip verification + explicit-buttons fallback |
| bluesky v1 | 11.5KB | 3 | twitter mirror; handles-are-domains; feed-pinning gated; kw bsky/skeet(s) |
| netflix v1 | 9.4KB | 0 | account/plan/profile pages banned; DRM errors report-and-stop; region check carefully hedged |
| stripe v1 | 10.8KB | 2 | STRICTLY read-only; /apikeys off-limits entirely; live-vs-test mode is a first-class state; kw mrr/failed payments |
| calendly v1 | 10.0KB | 4 | booking gate: slot+name+email from the user this conversation; timezone-led reporting; cancel only via pasted links |
| translate v1 | 6.0KB | 4 | smallest in library; URL-is-the-API with encoding table; happy path = 2 calls |

### P3.4 — expansion batch 4 (48 → 61 templates)
☑ DONE 2026-07-15: all 13 written. **Library is now 61 templates, 0 lint errors / 0 warnings, 608KB instructions, zero cross-template keyword/domain collisions, 1192 [LIVE-VERIFY] markers.**

| new template | size | kw | notes |
|---|---|---|---|
| facebook v1 | 12.0KB | 2 | Meta GO SLOW posture; audience selector verified before every post; Messenger out of scope; kw fb / fb marketplace |
| tiktok v1 | 10.7KB | 2 | read-first, NO posting; hardest anti-bot stance (CAPTCHA/slider → STOP); kw fyp / for you page |
| airbnb v1 | 10.0KB | 5 | booking-model money stop; TOTAL price not nightly teaser; host contact double-gated; kw disjoint from booking's hotel set |
| gflights v1 | 10.0KB | 5 | form-driven (tfs= blob honestly non-constructable); handoff = results URL + named booking options |
| imdb v1 | 7.9KB | 5 | read-only reference; parental guide + episode guide; write actions refused |
| ubereats v1 | 10.0KB | 4 | cart hard-stop even on "order me X"; address = first-class state; never tips/scheduling |
| medium v1 | 10.9KB | 2 | draft allowed, PUBLISH gated on explicit confirm; paywall never bypassed; "medium" homonym noted |
| vercel v1 | 10.3KB | 3 | read-first infra; env-vars page off-limits (stripe /apikeys pattern); redeploy/promote/cancel gated |
| sentry v1 | 11.8KB | 2 | read+triage; resolve/assign/archive gated with identity confirmation; all /settings/ off-limits |
| npm v1 | 7.4KB | 0 | 2nd-smallest; read-only; deprecation banners quoted verbatim |
| huggingface v1 | 9.9KB | 5 | model cards + safetensors size-summing; gated-model wall = first-class state, never auto-request access |
| ganalytics v1 | 10.2KB | 4 | tables-not-charts honesty; /admin off-limits; property+range mandatory in every report; kw ga4/pageviews/… |
| gcontacts v1 | 9.0KB | 4 | "what's X's email" backbone; edits report old→new; deletes gated with 30-day trash note |

### Template style contract (for all new/rewritten templates, distilled from what works)
1. Tool whitelist that matches the REAL surface; never ban a tool a task needs.
2. State Recognition section: login wall, loading, ready markers, view-only/permission detection, explicit "tell the user and stop" conditions.
3. Element references captured from real snapshots; match by role/aria-label/name/href; NEVER positional on destructive actions; note locale variance.
4. Per-task procedures with one verify-snapshot per action and a max-call budget; verification must distinguish success from failure.
5. URL-first where the app supports it (calendar/drive/docs URLs are the most robust selectors that exist).
6. One statement of each rule (no quadruple-stating); ≤12KB instructions.
7. Keywords: specific phrases a user would only say about THIS app; no bare English words; no local-filesystem verbs; include singular/plural and brand synonyms.
