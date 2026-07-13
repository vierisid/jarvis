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
- ☐ **Sidecar/local browser parity** (DISCOVERED during P0): the Go sidecar's snapshot/click/type use a different, cruder implementation than the daemon's local one — different selector list (no role=row/gridcell/textbox/contenteditable!), 0-based ids vs 1-based, raw JSON snapshot output vs the formatted "--- Page Text / Key Elements ---" text, JS `el.click()` (untrusted) vs trusted Input events, `el.value=` typing that can't handle contenteditable. Templates written against the local snapshot format will misbehave when browser routes to a sidecar — which is the REAL deployment (daemon in WSL, browser on Windows). Port the daemon's SNAPSHOT_SCRIPT + formatter + trusted click/type to Go before the live-capture pass.
- ☑ **Matcher hardening** DONE 2026-07-13 (`src/vault/webapp-templates.ts` + tests): word-bounded matching for app names AND keywords ("notions"/"gcalc"/"rescheduled" no longer hit; homonyms like "cut me some slack" still do — word boundaries can't fix those, trigger choice must); scored matches via `matchWebappTemplatesScored` (app name +100, domain +50+len, keywords +5+len capped at 3); **explicit-beats-keyword**: if any template is named explicitly (app name/domain), keyword-only matches are dropped — "send a message to John on Slack" now injects ONLY Slack; keyword-only requests inject the single best match; domain shadowing (docs.google.com/spreadsheets beats docs.google.com); `formatWebappInstructions` caps injection at 40K chars, skipping overflow templates with a visible one-line pointer. `getWebappTemplateByDomain` now supports path-qualified domains, most-specific wins. DATA FIX: gdocs/gsheets/gslides domains are now path-specific (`docs.google.com/document|spreadsheets|presentation` + sheets/slides.google.com aliases) — a pasted link injects exactly one template.
- ☑ **Template lint harness** DONE 2026-07-13 (`scripts/lint-webapp-templates.ts` + tests, `bun run lint:templates`): schema check; unknown `browser_*` tool references; `desktop_press_keys`/`run_command` in browser templates; Chrome-reserved shortcuts (Ctrl+N/T/W/1-9, both "Ctrl+N" and "ctrl,n" syntaxes); wrong `browser_upload_file(element_id, …)` signature; keyword genericity vs a 32-sentence non-webapp corpus; redundant app-name-containing keywords; cross-template keyword shadowing; missing login/state handling; positional selectors on destructive actions; size budget (warn >12KB, error >24KB). **Baseline on current templates: 76 errors / 23 warnings** — this is the P1/P2 debt list; exit code 1 until clean, so don't wire into pre-commit until the rewrites land. New/rewritten templates must be lint-clean.
- ☐ **Snapshot iframe support** (needed for Docs at all): traverse same-origin iframes in `SNAPSHOT_SCRIPT`, or route Docs through a different strategy.

### P1 — fix the salvageable four
- ☐ gmail: attach flow, rule-3-vs-budget, forward clobber, positional destructive buttons, reply-all/labels/read-unread tasks, task-verb keywords
- ☐ whatsapp: remove/replace run_command line; hover tasks (pending P0 hover) or mark unsupported; refresh `data-testid` selectors from a live snapshot; scope the six generic keywords (prefix "whatsapp" or drop)
- ☐ gcalendar: fix the "type Ctrl+Enter" save step to the click path; delete duplicated rules block; strip keyboard section; de-toast verification; trim to ≤20KB; scope `create event`/`what do i have`/`reschedule`
- ☐ gsheets: remove drafting artifact; fix space-as-empty; state recognition + view-only detection; rename-tab task; convert keyboard tasks to menu clicks or P0 keys; scope generic keywords

### P2 — rewrite the five
- ☐ gdrive: keep URL/search section; rewrite all mutations onto the select→toolbar-click path; fix upload; add download + restore-from-trash tasks; replace the local-filesystem keyword set
- ☐ slack: click-first rewrite (sidebar nav, Send button primary); login/interstitial state recognition; threads/react on P0 hover+keys; prune 41 redundant keywords
- ☐ notion: click-first create ("+ New page"), search-button navigation; typing recipes rewritten for real browser_type semantics; login state recognition
- ☐ gslides: blocked on P0 keys (or live-capture proving the contenteditable path); add state recognition; fix `presentation` keyword
- ☐ gdocs: blocked on P0 iframe snapshot + keys; until then reduce to create/open/rename/share honestly
- ☐ **Live-capture pass**: every element reference in every template re-verified from a real `browser_snapshot` on the current app UI (the exemplar's "from real snapshots" discipline, applied everywhere). Record locale variance.

### P3 — library expansion (launch)
Write new templates ONLY against the post-P0 contract, from live snapshots, with the lint harness green. Candidate order (ICP-driven): GitHub, X/Twitter, LinkedIn, YouTube, Google Meet, Discord, Telegram Web, Outlook web, Trello, Jira, Airtable, Reddit, Google Maps, Amazon.

### Template style contract (for all new/rewritten templates, distilled from what works)
1. Tool whitelist that matches the REAL surface; never ban a tool a task needs.
2. State Recognition section: login wall, loading, ready markers, view-only/permission detection, explicit "tell the user and stop" conditions.
3. Element references captured from real snapshots; match by role/aria-label/name/href; NEVER positional on destructive actions; note locale variance.
4. Per-task procedures with one verify-snapshot per action and a max-call budget; verification must distinguish success from failure.
5. URL-first where the app supports it (calendar/drive/docs URLs are the most robust selectors that exist).
6. One statement of each rule (no quadruple-stating); ≤12KB instructions.
7. Keywords: specific phrases a user would only say about THIS app; no bare English words; no local-filesystem verbs; include singular/plural and brand synonyms.
