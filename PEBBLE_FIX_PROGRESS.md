# Pebble Branch -- Fix Progress

> **!! DELETE THIS FILE BEFORE MERGE.** Live implementation tracker for the review in
> `PEBBLE_BRANCH_REVIEW.md` (also delete). Updated as fixes land.

Legend: `[ ]` todo - `[~]` in progress - `[x]` done (verified) - `[!]` done, needs
on-device verify (Windows/macOS, no toolchain on this host) - `[-]` deferred / out of PR.

Verifiability on this host (Linux/WSL): TS + UI via `bun test`/`tsc`; cross-platform Go
via `go vet`/`go build`; Windows-only and macOS-only Go = edit-and-reason only.

---

## Phase 0 -- quick self-contained wins  (DONE -- tsc clean, 35 tests pass)
- [!] **S5** AppleScript injection in `type_text` -- fixed via `runOsascriptArgs` (argv, no interpolation) `sidecar/desktop_darwin.go` (macOS, edit-only, needs on-device verify)
- [x] **D1** `pendingSummons` identity-guarded deletes -- added `clearSummon(sidecarId, ctrl)` helper (identity + region-ownership guard), converted all 8 cycle/wake/region delete sites `src/daemon/index.ts`
- [x] **D5** wake handler re-checks `pendingSummons.has` before claim (folded into D1) `src/daemon/index.ts`
- [x] **D3** `flushWindowState()` called in `handleShutdown` before `closeDb()` (static import) `src/daemon/index.ts`
- [x] **E2** screenshot auto-target uses `'screenshot'` capability via parameterized `resolveDesktopTarget` `src/actions/tools/desktop.ts`
- [x] **E3** dropped redundant `event.payload._binary` Buffer (consumers use `event.binary.data` / `result._binary`) `src/sidecar/connection.ts`

## Phase 1 -- native ship-blockers  (DONE -- linux cgo build+vet+test green; Win/macOS parse-checked)
- [x] **N2** `Suppress()` -> `suppressDepth atomic.Int32` counter (edges reset segment); region path balanced via `sync.Once` in `client.go` -- `pebble_wake.go`, `client.go`
- [x] **N3** playback `<-done` bounded by clip-duration + 3s grace, force `device.Stop()` on timeout -- `pebble_playback.go`
- [x] **N4** `Resume()` bounded retry (5x100ms), re-arms `paused` + drops listener on total failure (no longer "running but deaf") -- `pebble_wake.go`
- [x] **N7** audio `Stop()` copies `pcm.Bytes()` under `session.mu` -- `pebble_audio.go`
- [!] **N1** Windows GDI leak fixed at all 4 paint sites: save old bitmap from `SelectObject`, restore before `DeleteObject` -- `pebble_overlay_windows.go`, `sub_pebble_overlay_windows.go`, `region_select_windows.go` x2 (gofmt-clean; cgo can't link here, needs on-device build + GDI-handle verify)
- [!] **N5** alpha-repair x1 derived from `pebbleBubbleX1 - 8` (=440) instead of hardcoded 332 -- `pebble_text_windows.go` (edit-only)
- [!] **N6** virtual-screen origin uses `int32(xRaw)` not 16-bit truncation -- `region_select_windows.go` (edit-only)
- [!] **N8** region overlay: `JarvisRegionWindow` subclass overrides `canBecomeKeyWindow` (borderless can't be key by default) + `activateIgnoringOtherApps:` -- `region_select_darwin.go` (edit-only, needs on-device key/Escape verify)
- [x/-] **N9** observer leak fixed: `NSWindowWillClose` block removes its own observer (one-shot) -- `panels_darwin.go` (parse-checked). Webview-engine leak in `local_webview_darwin.go:40-45` LEFT AS-IS: it is a deliberate, documented UAF-avoidance; a real fix needs cancellable teardown (out of scope for an untested change).

## Phase 2 -- connection lifecycle  (DONE -- linux build+vet+test green)
- [x] **C1** `c.conn` -> `atomic.Pointer[websocket.Conn]`; Stop/connect use Store, readLoop/sendJSON/sendBinary snapshot via Load -- `client.go`
- [x] **C2** `defer wakeListener.Stop()` on disconnect (Stop via stopCh, kept on parent ctx so reloadConfig's obsCancel doesn't kill it) -- `client.go`
- [x] **C3** browser type/scroll/submit now check + propagate every `cdp.send` error instead of returning success -- `browser.go`
- [x] **C4** downgrade to `ws` only for loopback/private/link-local IPs (via `net.SplitHostPort`+`ParseIP`); public stays `wss`. Test still green (LAN `10.0.0.25` -> ws) -- `client.go`
- [x] **C5** `update_config` mutation+save now holds `c.mu` (threaded as `sync.Locker` through `NewHandlerRegistry`); unlocks before `onReloaded()` to avoid self-deadlock -- `handlers.go`, `client.go`
- note: `-race` reconnect test that exercises C1/C2 is Phase 6 (existing tests don't start the client).

## Phase 3 -- security token subsystem  (DONE -- tsc clean, 39 brain tests pass, sidecar build+vet+test green)
- [x] **T1** `POST /sidecar/token` mint endpoint (auth: enrollment JWT Bearer) -> `{access_token, expires_in}` -- `src/comms/websocket.ts`
- [x] **T2** `issueAccessToken`/`verifyAccessToken`: signed JWT, `aud=brain-api`, 10-min `exp`, `sid`; stateless verify (no DB) -- `src/sidecar/manager.ts`
- [x] **T3** gate: `accepts()` = dashboard token OR `verifyAccessToken`; enrollment JWT rejected on `/api/*`+`/ws` (only on `/sidecar/connect`+mint). Hardened `validateToken` to reject access-aud tokens so a leaked access token can't mint fresh ones -- `websocket.ts`, `manager.ts`
- [x] **T4 (pragmatic)** sidecar `accessTokenProvider` mints over HTTP (cached + refresh-ahead) and `sanitizePanelURL` appends THAT short-lived token, not the enrollment JWT -- `sidecar/access_token.go`, `panel_handlers.go`, `client.go`, `handlers.go`. DEVIATION: reused the redirect->`Secure;HttpOnly` cookie flow rather than `wv.Init` injection (no SPA rewrite, keeps HttpOnly). Token in URL is now short-lived + log-redacted, vs the old permanent enrollment JWT.
- [~] **T5** provider re-mints for NEW spawns (covers transient panels). Background refresh of a panel open past the TTL is NOT done in the shipped interim -- it's folded into Phase 7 / F6 (re-`SetCookie` on the live webview once the fork exposes the native cookie store).
- [x] **T6 / S3** `redactPanelURL` masks the token at the one URL log site; mint endpoint logs nothing -- `panel_handlers.go`, `panels_runtime.go`
- [x] **T7 / S4** cookie now `HttpOnly; Secure` when TLS (direct or `x-forwarded-proto`) -- `websocket.ts`
- [x] **T8** brain tests: mint round-trip, unenrolled-rejected, enrollment<->access cross-rejection (cutover), garbage/tampered rejected (4). Sidecar `deriveMintURL` table test.

## Phase 4 -- cross-platform races + mediums  (DONE -- linux build+vet+test green, tsc clean; win/mac parse-checked)
- [x/!] **E1** `summonCallback`/`paletteCallback` -> `atomic.Value` + Store/Load on all 3 platforms (added `sync/atomic` import to darwin/linux) -- `pebble_overlay_{windows,darwin,linux}.go` (linux compiled; win/mac parse-only)
- [x] **P1** `panelImpl.wv` -> `wvVal atomic.Value` with `setWV`/`loadWV`; all ~12 read sites snapshot-once -- `sidecar/panels_runtime.go`
- [x] **P2** `PointAt` snapshot/arm + `advanceFrame` expiry-restore serialized under `c.mu` (only locks while pointing) -- `sidecar/pebble_runtime.go`
- [x] **P3** `decodeWAV` skips the RIFF odd-size pad byte -- `sidecar/pebble_playback.go`
- [x] **P4** wake emit gates on speech-CHUNK count (`minWakeSpeechChunks`, gap-tolerant) not the fragile speech-span; `MinSegmentDur` marked deprecated; unit tests added (`pebble_wake_test.go`) -- `sidecar/pebble_wake.go`
- [x] **D2** multi-sentence TTS dispatch serialized via a promise tail (`ttsTail`), synthesis stays concurrent -- `src/daemon/index.ts`
- [x] **D4** bare-"Jarvis" listening fallback timer (30s) recovers a wedged `listening` state; cleared in onComplete the instant a session is consumed + on disconnect -- `src/daemon/index.ts`
- [x] **D5** re-check `pendingSummons` before wake claim -- done in Phase 0 (folded into D1)
- [x] **D6** documented the intentional conv-orchestrator bypass for image turns (tool_call narration won't fire in conv mode) -- `src/daemon/agent-service.ts`

## Phase 5 -- UI + CI + lows + nits  (high-value done; CI1/CI3/C6 remain)
- [x] **UI1** AgentStrip `100%`/`100%` (was `100vw/100vh`) -- `AgentStripRoom.css`
- [x] **UI2** TaskResultRoom stops polling on terminal status; decides from fresh status; deps `[taskId]` -- `TaskResultRoom.tsx`
- [x] **UI3** fixed the misleading magenta-color-key transparency comment (real mechanism = WebView2/DirectComposition alpha) -- `ui/src/ambient/main.tsx`. (strip show-more gate + `_room_agent_strip` placeholder note = minor, not done)
- [ ] **CI1** SHA-pin privileged workflows -- NOT done: needs network/`gh` to resolve each `action@vN` -> commit SHA; guessing SHAs would break CI. Do with `gh api` access.
- [x] **CI2** 3 `setup-go` steps now use `go-version-file: sidecar/go.mod` -- `test.yml`, `sidecar-release.yml`, `update-webview.yml` (dead `GO_VERSION` envs left in place; trivial follow-up to delete). YAML parses.
- [ ] **CI3** `-H windowsgui` in test gate; least-priv `check` job; `version.go:9` doc ref -- minor, not done (edit-only)
- [x] **E4** added `compareSemver` boundary test pinning the MIN<=v<RECOMMENDED ordering the dead `'suggested'` branch relies on -- `src/sidecar/compat.test.ts`
- [x] **E5** `cleanup()` docstring fixed (60 min + rationale); `schema.ts:444` bare-catch annotated to match the file idiom. (listener-unsubscribe API symmetry = low value, not done)
- [ ] **C6** reload observer lifetime; bounded per-RPC goroutines; restart health signal -- NOT done (more involved Go lifecycle work)
- [x/!] **P5** GTK loop goroutine now `runtime.LockOSThread()` -- `gtk_main_linux.go` (linux build green). (X11 auto-repeat de-bounce + `panel.spawn` nil-webview error = Minor, not done)

## Phase 6 -- tests + PR hygiene
- [ ] reconnect/handshake test under `-race` (pins C1/C2) -- NOT done: needs a fake brain ws server harness. Highest-value remaining test.
- [x] keyspec parser test: `parseLinuxKeyspec` table test (caught the dead `" "` alias) -- `hotkeys_linux_test.go`. (`parseDarwinKeyspec` not testable on this host; browser discovery test not done)
- [ ] delete `docs/PEBBLE_REVIEW_AND_REFACTOR.md` + `AMBIENT_UX_WEEK*` + plan docs -- pre-merge action, intentionally NOT executed now (user may still reference them).
- [ ] drop stray EOF newlines in `desktop_darwin.go`/`desktop_linux.go` -- minor, not done
- [ ] **delete `PEBBLE_BRANCH_REVIEW.md` + `PEBBLE_FIX_PROGRESS.md`** -- pre-merge

---

## Phase 7 -- webview fork + Path A panel token delivery  (PLANNED -- follow-up effort; supersedes the shipped T4 `?token=` interim + the deferred T5 refresh)

DECISION: deliver the panel access token with NO token in any URL, via the webview's
native cookie store (`HttpOnly`, set before `Navigate`), and host the required native
binding in a FORK of `webview_go` rather than growing `jarvis.patch`. Full rationale in
`PEBBLE_BRANCH_REVIEW.md` -> "### Panel token delivery".

WHY this shape (recap):
- Brain gates the panel HTML itself (`isPublicRoute`, `websocket.ts:94` exempts only
  health/connect/jwks/webhooks), so the FIRST navigation must already carry the cookie
  -> it must be set in the cookie store BEFORE `Navigate`, not via a `wv.Init` script
  (the un-authed first HTML GET would 401 to the error page). This rules out Path B
  unless we make the SPA shell public (rejected: deliberate posture change).
- Path A needs the native webview object (`ICoreWebView2`/`WKWebView`/`WebKitWebView`),
  which vendored `webview_go` holds but doesn't expose. The native work is constant
  across patch/fork/rewrite; only maintenance of divergence differs.
- Rewriting our own wrapper is rejected (weeks of work + permanent upkeep, doesn't avoid
  the native cookie work). Fork is chosen because divergence is already growing and a
  `.patch` is fragile at this size; MIT license permits it.

Steps:
- [ ] **F1** create `yourorg/webview_go` from the commit in `third_party/webview_go/UPSTREAM_VERSION`
- [ ] **F2** commit current `jarvis.patch` onto the fork (fork == today's vendored state)
- [ ] **F3** add `SetCookie(host, name, value, opts{HttpOnly, Secure, SameSite, Path})` with 3 native impls: WebView2 `ICoreWebView2CookieManager::AddOrUpdateCookie`, WKWebView `WKHTTPCookieStore setCookie:`, WebKitGTK `webkit_cookie_manager_add_cookie`; CI builds all 3 OSes on the fork
- [ ] **F4** point sidecar at the fork (go.mod require + `go mod vendor`, or sync `third_party/` from the fork tag); retire `jarvis.patch` + the patch-apply step; repoint `update-webview.yml` at the fork (now merges upstream on a cadence)
- [ ] **F5** sidecar Path A: drop the `?token=` append in `sanitizePanelURL`; `wv.SetCookie(brainHost,"token",access,{HttpOnly:true,Secure:isHTTPS,SameSite:"Strict"})` before `Navigate`; verify `Secure`-on-`http://localhost` per platform (omit `Secure` for loopback brains, mirroring C4)
- [ ] **F6 (was T5)** per-panel refresh timer (~TTL/2): re-mint + re-`SetCookie` on the live webview (UI-thread dispatch via `uiSync`/`loadWV()`); stop on `impl.done`. Closes the long-lived-panel gap
- [ ] **F7** keep brain side as-is (mint/verify/gate already shipped); add a sidecar unit test for the cookie opts builder; injection + first-paint + refresh need on-device verification

NOTE: if webview divergence is NOT expected to keep growing, skip the fork -- the shipped
`?token=` interim (short-lived token, `HttpOnly` cookie, log-redacted) is safe on its own.

## Deferred (NOT in this PR)
- [-] OS-native at-rest storage of the enrollment JWT (Keychain/DPAPI/libsecret; headless-Linux caveat). Keep `0600`+`O_NOFOLLOW` interim floor.

## Log
- (init) review + tracker written; starting Phase 0.
- Phase 0 complete: S5, D1, D5, D3, E2, E3. `bunx tsc --noEmit` clean (0 errors), `bun test src/sidecar/` 35 pass. Starting Phase 1.
- Phase 1 complete: N1-N9. linux cgo `go build ./...` + `go vet .` + `go test .` all green. Windows/macOS files gofmt-parse-checked (no local cgo toolchain: mingw g++ rejects webview's -mthreads; darwin not cross-buildable). N1/N5/N6 (win) + N8 (mac) marked on-device-verify. N9 webview-engine leak left as deliberate documented tradeoff.
- Phase 2 complete: C1-C5. linux `go build`+`vet`+`test` green; C4 LAN test still passes. Starting Phase 3 (security token subsystem) -- the large architectural piece.
- Phase 3 complete: T1-T8 (+ validateToken access-aud hardening). Brain tsc 0 errors, `bun test src/sidecar/` 39 pass; sidecar `go build`+`vet`+`test` green. Enrollment JWT is now off the data plane; panels carry short-lived access tokens. Phases 0-3 = the security cluster + all native ship-blockers + all lifecycle races. Remaining: Phase 4 (cross-platform races + mediums), Phase 5 (UI+CI+lows), Phase 6 (tests+hygiene) -- all Medium/Low.
- Phase 4 complete: E1, P1, P2, P3, P4, D2, D4, D6. Sidecar `go build`+`vet`+`test` green (+ new `pebble_wake_test.go`); brain tsc 0 errors, 39 tests pass. All concurrency races from the review are now fixed. Remaining: Phase 5 (UI overflow + CI pinning + lows), Phase 6 (test infra + delete hand-off docs) -- Medium/Low polish.
- Phase 5/6 (high-value done): UI1, UI2, UI3, CI2, E4, E5, P5-GTK + keyspec test (`hotkeys_linux_test.go`). Sidecar build/vet/test green, brain tsc 0 errors, all 4 workflow YAMLs parse. NOT done (Low / needs external resources / pre-merge): CI1 (needs `gh` to resolve action SHAs), CI3, C6, X11 auto-repeat, the `-race` reconnect test (needs a fake-ws harness), and deleting the hand-off docs (pre-merge). These are the only open items and all are Low/polish.
- Decision recorded (Phase 7): panel token delivery target = Path A (native cookie store, HttpOnly, set-before-Navigate, no token in URL) hosted in a FORK of webview_go (not a grown `.patch`, not a from-scratch wrapper). Driven by the brain gating the panel HTML (first request must carry the cookie) + growing native divergence. Supersedes the shipped `?token=` interim (T4) and the deferred refresh (T5/F6). Full detail in `PEBBLE_BRANCH_REVIEW.md` "### Panel token delivery" and Phase 7 above. Not yet implemented.
