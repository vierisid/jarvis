# Pebble Branch Review (`feat/pebble`)

> **!! DELETE THIS FILE BEFORE MERGE.** This is a working review + development hand-off
> for the in-progress `feat/pebble` branch, not product documentation. It records the
> full multi-area code review, the agreed security decisions, and the implementation
> plan. The live status of the fixes lives in `PEBBLE_FIX_PROGRESS.md` (also delete).

## 1. Scope and method

The branch adds the "ambient pebble": a native desktop overlay rendered by the Go
**sidecar**, driven over websocket by the TypeScript **brain**, plus panels (webviews),
voice / TTS / wake-word, a command palette, new UI rooms, tray + settings/setup windows,
telemetry, a brain/sidecar version-compat handshake, CDP browser automation, and CI to
release the sidecar.

- 94 commits off `main` (merge-base `84f24d57`), 206 files, ~53,851 insertions / 721 deletions.
- Reviewable source ~23k lines: Go sidecar ~16.7k, TS ~3.7k, UI ~2.4k, CI ~0.6k.
- Vendored `webview_go` (27.8k) and docs (2.8k) were skimmed, not deep-reviewed.

Reviewed by partitioning the surface across 9 focused agents (one per subsystem + a
cross-cutting security pass). The headline finding in every area was then independently
re-verified by reading source. Findings marked **[verified]** were read directly during
synthesis; the rest are agent-reported with concrete evidence.

## 2. Overall assessment

**Recommendation: Request changes** (fixes to be done in-branch -- see section 8).

The architecture is genuinely good: a clean cross-platform `pebbleCore` / runtime split
with per-OS renderers, disciplined main-thread marshalling (Cocoa main queue, GTK idle,
Windows single `LockOSThread` frame goroutine with synchronous `WndProc`), correct cgo
string/buffer ownership, and a security-aware posture in most places. The previously
reported macOS main-thread-deadlock / destroy-on-close UAF issues are genuinely fixed.

The problems cluster in five places: (1) a security model around the enrollment token
that needs reworking, (2) two ship-blocking native bugs, (3) reconnect-lifecycle races
and leaks in the websocket client, (4) a brain-side voice state-machine bug, and (5) a
near-total absence of tests on the riskiest new code.

## 3. Security workstream (agreed plan -- build in this PR)

Context: this branch already introduces a new sidecar + comms system and is a
breaking change in a fast-delivery state, so the security rework is done **in this
branch** (not a follow-up) to keep it next to the comms code it secures.

### Decisions

- **S1 -- Enrollment JWT has no expiry. ACCEPTED (not a blocker).** `manager.ts:341-352`
  signs with no `setExpirationTime`; `validateToken` (`manager.ts:495-497`) does not
  require/enforce `exp`. Mitigating control verified: `validateToken` re-checks DB
  enrollment on every call (`manager.ts:502`), so revocation is immediate at the
  validation layer -- the token is "valid until revoked," not "valid forever." Once the
  enrollment JWT becomes a mint-only refresh credential (below) and is off the data
  plane, long-lived is defensible. Revisit when an automated token-management/renewal
  system exists.
- **S2 -- Sidecar JWT authenticates the entire API + `/ws`. INTENDED (withdrawn as a
  finding).** `websocket.ts:227` applies the auth gate to every non-public route and
  `accepts()` (`:234-239`) honors any valid sidecar token. This is the intended end
  state: the sidecar and its spawned web panels are the sole access path for the user,
  so they must reach all resources including the `/ws` control socket.

### Target architecture (the actual work)

The risk was never "JWT authenticates the API"; it was "a single, permanent,
webview-embedded token authenticates the API." Split the credential:

1. **Enrollment JWT becomes a refresh-style credential.** Sent by the **sidecar
   process** only to (a) the existing `/sidecar/connect` WS handshake (`Authorization:
   Bearer`, over TLS, process-to-brain, never in a URL) and (b) a new token-mint
   endpoint. Never injected into a page, never in a URL/cookie/log.
2. **New mint endpoint** (e.g. `POST /sidecar/token`), authenticated by the enrollment
   JWT, returns a **short-lived (~5-15 min) scoped access token**. Access token is a
   signed JWT with `aud: brain-api`, short `exp`, carrying `sid`.
3. **Brain auth gate reworked** (`websocket.ts`): accept the dashboard token (existing,
   for the browser during transition) and a valid **access token**. Stop accepting the
   **enrollment JWT** on `/api/*` and `/ws`. Verify access tokens by signature + `exp`
   only -- **stateless, no DB hit**. This also resolves the per-request ES256 + DB
   `isEnrolled` cost flagged as a DoS surface (security pass #7).
4. **Access token reaches the webview.** TARGET = Path A (no token in any URL): the
   sidecar sets the access token as a `Secure; HttpOnly; SameSite=Strict` cookie in the
   webview's native cookie store *before* `Navigate`, so the very first HTML request
   carries it and the cookie also covers the `/ws` upgrade. See
   "### Panel token delivery" below for why this (not `wv.Init`) is required and the
   webview-fork decision it depends on. SHIPPED INTERIM = short-lived access token via
   the existing `?token=` redirect->`HttpOnly` cookie flow (see `PEBBLE_FIX_PROGRESS.md`
   T4): correct and a big improvement (enrollment JWT off the data plane, credential is
   now short-lived + log-redacted), but the token is briefly in the navigation URL and
   long-lived panels can't refresh. Path A supersedes it.
5. **Refresh owned by the sidecar process** (it holds the enrollment JWT). Re-mint and
   re-inject before expiry; the page never holds the enrollment JWT and never refreshes
   itself.
6. **Tests on the auth path are mandatory** (this is net-new control-plane code on a
   branch with ~zero auth-path coverage): mint (valid/invalid/revoked enrollment JWT),
   access-token verify (good/expired/wrong-aud/wrong-alg), and gate behavior
   (enrollment JWT rejected on `/api`+`/ws`, access token accepted, dashboard token
   still accepted).

### Hygiene that carries into the new code (was S3/S4)

- **S3** -- the token-bearing panel URL is logged verbatim: `panels_runtime.go:270`
  logs `spec.URL` which includes `?token=...` (set at `panel_handlers.go:61-65`), and
  the Log Viewer exports it. Generalizes to: **never log a token or `Authorization`
  header anywhere**, including the new mint endpoint. Redact before logging.
- **S4** -- panel cookie lacks `Secure` (`websocket.ts:253`,
  `token=...; Path=/; SameSite=Lax; HttpOnly`). The access-token cookie must be
  `Secure; HttpOnly; SameSite=Strict` with a short `Max-Age`.
- **Invariant to record:** with S2 intended, the brain origin being XSS-free is a hard
  security property -- any script there holds the control plane. The new rooms render
  model output via react-markdown (safe by default, no `rehype-raw` /
  `dangerouslySetInnerHTML` -- verified), but the whole dashboard SPA is now that
  surface. `HttpOnly` stops token theft, not XSS-driven use.

### Must-fix, unrelated to the token work

- **S5 -- AppleScript injection in `type_text` (macOS).** `desktop_darwin.go:283-286`
  escapes only `\` and `"`, then interpolates LLM-controlled text into
  `keystroke "%s"` passed to `osascript -e`. A raw newline terminates the statement;
  trailing bytes execute as AppleScript (`do shell script ...`). Fix: strip control
  chars (`< 0x20`) / pass text via stdin instead of interpolating into the literal.

### Deferred (tracked, NOT in this PR)

- **Path A panel token delivery + the webview fork it needs** (see "### Panel token
  delivery" above). The shipped `?token=` interim is safe; Path A removes the token from
  the URL, gives `HttpOnly`, and adds long-lived-panel refresh (T5). Sequenced after the
  `yourorg/webview_go` fork lands. Largest single follow-up.
- **OS-native at-rest storage of the enrollment JWT.** Currently `sidecar.yaml` at
  `0600` + `O_NOFOLLOW` (verified, keep as the interim floor). Proper storage is
  Keychain (macOS) / DPAPI or Credential Manager (Windows) / Secret Service via
  libsecret (Linux). Deferred because it is highly OS-specific, needs on-device
  testing, and headless Linux has no good session keystore (may need TPM or a hardened
  file fallback). Note: keystores defend against at-rest + other-user theft, not a
  same-user same-session compromise, so this is the lowest-marginal-value item once the
  access-token split lands.

### Panel token delivery -- target Path A (native cookie store) via a webview fork

**The constraint that drives this.** The brain's `isPublicRoute` (`websocket.ts:94`)
gates *everything* except `/health`, `/sidecar/connect`, the JWKS endpoint, and
webhooks -- including the panel's HTML document and static assets. So the **first**
navigation request must already carry a credential. A "load the page, then set the
cookie from a `wv.Init` pre-load script" approach fails: the first HTML GET 401s and the
webview shows the auth-error page, so the injected cookie lands on the wrong document.
=> the token must arrive *before* the first request.

Two ways to satisfy that:

- **Path A (chosen target): native cookie store, set before `Navigate`.** Set the
  access-token cookie directly in the webview's cookie store, then navigate. First HTML
  GET + all `/api` + the `/ws` upgrade carry it. Gives `HttpOnly`. Refresh = re-set the
  cookie via the same native API on a ~TTL/2 timer (no re-navigation). Per-platform APIs:
  WebView2 `ICoreWebView2CookieManager::AddOrUpdateCookie`; WKWebView
  `WKHTTPCookieStore setCookie:`; WebKitGTK `webkit_cookie_manager_add_cookie`.
- **Path B (rejected unless we relax posture): public SPA shell + `wv.Init` cookie.**
  Add the HTML/JS/CSS routes to `isPublicRoute` (gate only `/api`+`/ws`), then `wv.Init`
  sets a non-`HttpOnly` cookie before page scripts; refresh via `wv.Eval`. Cheaper, but
  serves the shell unauthenticated AND loses `HttpOnly`. Acceptable security-wise (the
  shell is non-secret static code; `HttpOnly` only stops token *theft*, not XSS-driven
  *use*, and the origin must be XSS-clean regardless) -- but a deliberate posture change.

**Why a fork is the right home for Path A.** Path A needs the native webview object
(`ICoreWebView2` / `WKWebView` / `WebKitWebView`), which the vendored `webview_go` holds
but does not expose. That work is the same size however we package it -- patch, fork, or
rewrite only change how the *divergence* is maintained, not the native-API effort.

- **Reject "write our own wrapper / drop webview_go":** `webview_go` wraps the
  `webview/webview` C++ core, which encapsulates a lot of hard cross-platform plumbing
  (WebView2 COM bootstrap + loader DLL, WKWebView message bridge, WebKitGTK init,
  transparent compositing, DPI, message-loop integration). Reimplementing it for 3
  platforms is weeks of work + permanent maintenance, and it does NOT avoid the native
  cookie work. Only justified if we needed a fundamentally different webview -- we don't.
- **Adopt "fork in our own repo" (`yourorg/webview_go`), vendored for hermeticity.**
  Our divergence is already growing (SW_HIDE, the Cocoa main-thread + terminate-no-op
  fixes, `__sidecar_set_regions`, click-through, now cookies) and a `.patch` file is the
  wrong tool at this size -- hard to read, fragile to re-apply (the `update-webview.yml`
  verify already only checks 2 of the patch's markers). A fork makes each change a
  reviewable commit with CI on all 3 OSes, and upstream tracking becomes a normal
  `git merge upstream` instead of a patch re-apply. MIT license -- forking is fine.

**Migration (low-risk, reversible):**
1. Create `yourorg/webview_go` from the exact upstream commit in `third_party/webview_go/UPSTREAM_VERSION`.
2. Commit the current `jarvis.patch` onto it => fork == today's vendored state.
3. Add a `SetCookie(host, name, value, opts{HttpOnly, Secure, SameSite, Path})` method
   with the three native implementations; CI builds all platforms on the fork.
4. Point the sidecar at the fork (go.mod require + `go mod vendor`, or keep the
   `third_party/` copy synced from the fork's release tag); retire `jarvis.patch` and the
   patch-apply step; repoint `update-webview.yml` at the fork (it now merges upstream
   into the fork on a cadence).
5. Sidecar then: drop the `?token=` append in `sanitizePanelURL`; call
   `wv.SetCookie(brainHost, "token", access, {HttpOnly:true, Secure: isHTTPS, SameSite:"Strict"})`
   before `Navigate`; add the per-panel refresh timer (tie to `impl.done`). This also
   closes the deferred T5 (long-lived-panel refresh).

If webview divergence is NOT expected to keep growing, the current vendor+patch + the
shipped `?token=` interim are fine and none of this is worth it. Given the trajectory of
native integration, fork before the patch grows further.

### Security surfaces verified CLEAN (do not re-litigate)

CDP runs over an inherited pipe, not a TCP debug port; telemetry opt-out is re-checked
before every send and the payload carries no PII/OCR/token; OCR text is not logged and
is control-char sanitized; cross-sidecar routing is isolated via the JWT-validated
`sid`; the binary ref-protocol uses UUID map keys (no path traversal); inbound sidecar
JSON is stripped of `__proto__`/`constructor`/`prototype`; brain JWT crypto is sound
(ES256, `0600` private key, `algorithms` pinned -> no `alg:none`); autostart / relaunch
/ restart only re-exec the sidecar's own path (no brain string reaches a shell).

## 4. Blocking -- native rendering and audio

- **N1 [Critical] [verified] Per-frame GDI bitmap leak on Windows.**
  `pebble_overlay_windows.go:602` discards the old bitmap returned by `SelectObject`;
  the deferred `DeleteObject(dib)` at `:601` then fails because the DIB is still
  selected into `memDC`, and `DeleteDC` does not free a selected bitmap. ~60 leaked
  HBITMAPs/sec per overlay at the 16ms frame loop; GDI quota (10k) exhausts in minutes.
  Same pattern in `sub_pebble_overlay_windows.go` `paint()` (`:556-581`) and
  `region_select_windows.go`. Fix: save + restore the old bitmap before delete, or
  (preferred) create the DC+DIB once at window creation and reuse it.
- **N2 [Critical] [verified] `WakeListener.Suppress()` is a single shared bool.**
  `pebble_wake.go:177-187` is one CAS'd `atomic.Bool` with two independent callers --
  TTS playback (`client.go:505-507`) and region-selection (`client.go:750-796`). When
  they overlap, whichever calls `Suppress(false)` first re-enables the wake mic while
  the other still needs suppression (e.g. region ends while TTS is still speaking),
  defeating the self-wake guard. Fix: make it a counter (suppressed = count > 0), reset
  segment on the 0->1 and 1->0 edges only; one decrement per increment.
- **N3 [High] Playback worker can block forever.** `pebble_playback.go:218` `<-done`
  is closed only from inside the malgo data callback; a device that opens then stalls /
  errors / disconnects never closes it, hanging the singleton `worker()` and wedging all
  future playback. Fix: bound the wait (`select` + `time.After(clipDuration + grace)`)
  and `device.Stop()` on timeout.
- **N4 [High] `WakeListener.Resume()` can leave the listener running-but-deaf.**
  `pebble_wake.go:145-159`: after flipping `paused=false`, a failed `audioSvc.Start()`
  returns with `running==true` and no device. Reachable on every Ctrl+Space
  (`Pause(); defer Resume()` in `client.go:537`) when the OS has not released the
  capture device. Fix: retry/backoff or re-arm `paused` and surface the failure.
- **N5 [High] Windows bubble text right ~100px rendered transparent.**
  `pebble_text_windows.go:262-283` repairs glyph alpha only for `x in [20, 332)`, but
  body text lays out to `x=434` (bubble widened 328->436). Glyphs in `[332, 434)` keep
  alpha=0 and are invisible. Fix: derive repair bounds from the bubble constants (the
  sub-pebble version already does).
- **N6 [High] Windows region-capture virtual-screen origin sign-extraction wrong.**
  `region_select_windows.go:118-125` truncates `SM_XVIRTUALSCREEN` to 16 bits instead
  of `int32(xRaw)` (the `panels_windows.go:129` sibling is correct). Multi-4K layouts
  with the virtual origin beyond +/-32768px capture the wrong pixels. Fix:
  `x := int32(xRaw)`.
- **N7 [Medium] Audio capture callback races `Stop()`.** `pebble_audio.go:151` reads
  `session.pcm.Bytes()` in `Stop()` without `session.mu` while the malgo callback may
  still be writing; `bytes.Buffer` is not concurrent-safe. Fix: snapshot under
  `session.mu`.
- **N8 [Medium] macOS region overlay may never get key / Escape.**
  `region_select_darwin.go:122-137`: the accessory-policy app never calls
  `activateIgnoringOtherApps:`, so the borderless overlay may not become key and
  Escape-to-cancel may not fire -> potential stuck full-screen dim. Needs on-device
  check. Fix: activate before `makeKeyAndOrderFront`.
- **N9 [Medium] macOS window-close observers + webview leak.**
  `panels_darwin.go:130-138` adds an NSNotificationCenter observer that is never
  removed; `local_webview_darwin.go:42-45` leaks the webview engine. Accumulates per
  Settings/Logs open.

## 5. Blocking -- connection lifecycle (sidecar client)

- **C1 [High] Data race on `c.conn`.** `client.go:222` (`Stop()` sets `c.conn=nil` from
  the signal goroutine) races with `connectAndServe` (`:453`), `readLoop` (`:868`), and
  `sendJSON/sendBinary` (`:989`). `c.mu` deliberately does not guard `c.conn`. (The
  writer is `nhooyr.io/websocket`, which serializes writes internally, so no
  concurrent-writer panic -- but the pointer race is real.) Fix:
  `atomic.Pointer[websocket.Conn]` or guard with the mutex.
- **C2 [High] Wake-listener + audio capture leaked per reconnect.**
  `client.go:486-499` constructs a fresh wake listener and `Start(ctx)`s it inside
  `connectAndServe`, bound to the parent ctx, never `Stop()`ed on disconnect. Each
  reconnect leaks a `coordinate()` goroutine and a held mic; after N reconnects, N
  listeners fight for the microphone. Fix: construct once on the struct, or tie to
  `obsCtx` and stop in the defer.
- **C3 [High] Browser `type`/`scroll` report success on failure.**
  `browser.go:478-493,567` ignore `send` errors in the per-character/scroll loops and
  still return `success:true`. A mid-sequence pipe failure silently drops input while
  telling the model it worked. Fix: propagate send errors.
- **C4 [Medium] `normalizeBrainOverride` downgrades `wss`->`ws` for any `host:port`.**
  `client.go:160` uses `strings.Contains(trimmed, ":")` to detect localhost, so a
  remote `brain.example.com:8443` override becomes unencrypted `ws://` carrying the
  bearer token. Fix: only downgrade for actual loopback hosts.
- **C5 [Medium] `update_config` RPC mutates shared `cfg` without `c.mu`**
  (`handlers.go:772`), racing `editConfig`/`Preferences()`. Route through `editConfig`.
- **C6 [Low] Reload-spawned observers outlive the connection** (`client.go:466-479` vs
  `337-403`); **unbounded per-RPC handler goroutines** (`client.go:903-910`); **restart
  health window only observes the replacement's sleep, not init success**
  (`client.go:303-326` + `main.go:49-52`).

## 6. Blocking -- brain daemon (TypeScript)

- **D1 [High] [verified] `pendingSummons` deleted unconditionally by `sidecarId`.**
  Deletes at `index.ts:2904/2910/2914/3017/3095` have no identity guard. Interleaving
  (dismiss a long answer, immediately re-summon): cycle A's late delete removes the
  brand-new summon B, leaving the pebble stuck `listening` with no backing entry; also
  breaks region-cancel-by-hotkey. Fix: guard every delete with
  `if (pendingSummons.get(id) === ctrl) pendingSummons.delete(id)` and let the region
  `finally` own its teardown. (The disconnect/dismiss deletes at `:667`/`:1101` are
  deliberate.)
- **D2 [Medium] Multi-sentence TTS can play out of order** (`index.ts:2583-2616`): each
  sentence's synth+dispatch runs in a detached IIFE; jobs resolve in completion order,
  not sentence order. Serialize dispatch.
- **D3 [Medium] `flushWindowState()` never called** (`window-state.ts:64-73`): the
  shutdown-flush export has zero callers, so window positions moved within the 400ms
  debounce are lost on quit. Call it in `handleShutdown` (`index.ts:156-239`).
- **D4 [Medium] Bare-"Jarvis" wake can stick `listening` forever**
  (`index.ts:2989-3008`): no daemon-side timeout if `session_end` never arrives. Arm a
  fallback timer.
- **D5 [Medium] Wake claim clobbers concurrent manual summon**
  (`index.ts:2942-2987`): `pendingSummons.set` at `:2987` after async STT with no
  re-check. Re-check before claiming (fold into D1's guard).
- **D6 [Medium] Image queries bypass the conv orchestrator**
  (`agent-service.ts:386-407` vs `270-299`): in conv mode, text turns get tool/action
  narration but image turns do not (and persona diverges). Route images through conv or
  document the split.

## 7. Should-fix and minor

### TS sidecar / comms / LLM
- **E2 [Medium] Screenshot auto-target capability mismatch** (`desktop.ts:520` +
  `:215`): resolves target by `'desktop'` but routes requiring `'screenshot'`; a
  desktop-only sidecar hard-fails with "do NOT retry". Resolve by the required
  capability.
- **E3 [Medium] Binary double-buffered in memory** (`connection.ts:87-92`): keeps both
  the raw `Buffer` (`_binary`) and a base64 copy; a 50MB binary costs ~116MB. Pick one.
- **E4 [Low] `compat.ts` `'suggested'` path is dead today** (MIN==RECOMMENDED) and
  untested (`compat.ts:83-92`, `compat.test.ts:38-51`): add a boundary test before
  bumping RECOMMENDED.
- **E5 [Low]** listener unsubscribe asymmetry (`manager.ts:451-459`); `cleanup()`
  docstring says 10min but default is 60min (`task-manager.ts:187-190`); `schema.ts:444`
  bare `catch {}` hides real ALTER failures.

### Cross-platform Go
- **E1 [Medium] Callback fields raced on reconnect (all 3 platforms).**
  `summonCallback`/`paletteCallback` are plain fields re-assigned every
  `connectAndServe` while the hotkey goroutine reads them
  (`pebble_overlay_windows.go:256/263/270/280`, `pebble_overlay_darwin.go:614-615`,
  `pebble_overlay_linux.go:588-589`). Other callbacks already use `atomic.Value`. Make
  these consistent.
- **P1 [Medium] `panelImpl.wv` unsynchronized** (`panels_runtime.go:140, 262-263,
  452-468`): written by the spawn goroutine, read by close-watcher/hotkey goroutines.
  Use `atomic.Pointer` or gate on `impl.ready`.
- **P2 [Medium] `PointAt` vs `advanceFrame` TOCTOU** (`pebble_runtime.go:121-135,
  248-270`): a `[POINT]` tag issued the frame a previous point expires can be lost.
  Serialize under `c.mu`.
- **P3 [Medium] `decodeWAV` ignores the RIFF pad byte** (`pebble_playback.go:307-348`):
  odd-sized chunks before `data` desync the parser. `pos += size; if size%2==1 { pos++ }`.
- **P4 [Medium] Wake `MinSegmentDur` can drop very short wake words**
  (`pebble_wake.go:264, 271-274`): a clipped "Jarvis" may be discarded. Gate on total
  segment duration / chunk count, add a unit test.
- **P5 [Low]** `panel.spawn` masks a nil-webview spawn failure as success
  (`panels_runtime.go:124-127, 477, 501-507`); GTK loop goroutine not `LockOSThread`'d
  (`gtk_main_linux.go:24-35`); X11 hotkey fires on auto-repeat (`hotkeys_linux.go:80-84`).

### UI (React)
- **UI1 [Medium] AgentStrip overflow** (`AgentStripRoom.css:6-16` + `v2.css:40-43`):
  `100vw/100vh` inside the panel-mode `16px 20px` padding overflows the exactly-sized
  290x440 strip window by 40px. Use `100%`.
- **UI2 [Low] TaskResultRoom polls a terminal task forever**
  (`TaskResultRoom.tsx:30, 54-67`): contradicts its docstring; drop `task?.status` from
  deps and stop scheduling on terminal status.
- **UI3 [Low]** `_room_agent_strip` renders a placeholder, not the strip
  (`router.ts:50`, `RoomDispatcher.tsx:72-86`); `main.tsx:11-13` transparency comment is
  wrong (claims magenta color-key; actual mechanism is WebView2 alpha); strip "show
  more" can reveal nothing (`AgentStripRoom.tsx:238-246`).

### CI / CD
- **CI1 [Medium] Action SHA-pinning inverted**: the privileged publish/push workflows
  (`release-exec.yml`, `sidecar-release.yml`) use floating tags while the unprivileged
  `update-webview.yml` is SHA-pinned. Pin the privileged ones.
- **CI2 [Medium] Go version triplicated** across `test.yml:9-10`, `release-exec.yml:28`,
  `sidecar-release.yml:41`, `update-webview.yml:42` + `go.mod`. Use
  `go-version-file: sidecar/go.mod`.
- **CI3 [Low]** `test.yml` Windows cross-build omits `-H windowsgui` (`:53-63`);
  `update-webview.yml` grants `pull-requests`/`issues: write` to the read-only `check`
  job (`:30-33`); `version.go:9` references a non-existent `release.yml`.

## 8. Cross-cutting themes

1. **Tests on the riskiest code are essentially zero** -- flagged independently by 5
   agents. No coverage for: the websocket client reconnect/handshake/lifecycle, the CDP
   driver framing/correlation, the audio/VAD/wake state machines, the `pebbleCore`
   motion/pointing logic, or the keyspec parsers. Three blocking bugs (C1, C2, N2) are
   exactly what a `-race` reconnect test would catch. The new auth-token path (section 3)
   must ship with tests.
2. **Reconnect lifecycle is the weak spot** -- C1, C2, E1, C5, C6 all stem from
   `connectAndServe` re-running and re-wiring state that outlives the connection.
3. **PR hygiene** -- `docs/PEBBLE_REVIEW_AND_REFACTOR.md` begins
   "DELETE THIS FILE BEFORE MERGE" and is still present (811 lines); plus the
   `AMBIENT_UX_WEEK*` hand-off docs and the "MD File Plan (To be removed)" commit; plus
   stray EOF newline churn in `desktop_darwin.go`/`desktop_linux.go`. Decide which are
   product docs and delete the rest.

## 9. Development plan (implementation order)

Done in-branch, fast-delivery. Tracked in `PEBBLE_FIX_PROGRESS.md`.

- **Phase 0 -- quick self-contained wins (verifiable here):** S5 (AppleScript),
  D1 (pendingSummons), D3 (flushWindowState), E2, E3.
- **Phase 1 -- native ship-blockers:** N2 (Suppress counter), N3 (playback timeout),
  N4 (Resume), N1 (GDI leak, Windows -- edit-only here), N5/N6 (Windows -- edit-only),
  N7 (audio race).
- **Phase 2 -- connection lifecycle:** C1 (`c.conn` atomic), C2 (reconnect leak),
  C3 (browser send errors), C4, C5.
- **Phase 3 -- security token subsystem (section 3):** mint endpoint + short-lived
  scoped access tokens + stateless verify + gate rework + webview injection + sidecar
  refresh + auth-path tests. Drop enrollment JWT from data plane. (S3/S4 hygiene folds
  in here.)
- **Phase 4 -- cross-platform races + mediums:** E1, P1-P4, D2, D4, D5, D6.
- **Phase 5 -- UI + CI + lows + nits:** UI1-UI3, CI1-CI3, E4, E5, P5, C6.
- **Phase 6 -- tests + PR hygiene:** reconnect `-race` test, keyspec parser tests,
  delete the hand-off docs.

Notes: this host is Linux/WSL with no Windows or macOS toolchain, so Windows-only
(`N1, N5, N6`) and macOS-only (`S5, N8, N9`) fixes are edit-and-reason-only -- they
need on-device compile/test before merge. Cross-platform Go and all TS/UI are
verifiable here (`go vet`, `go build` for linux, `bun test`, `tsc`).
