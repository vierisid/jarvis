# Point 10: the desktop app's platform code is written twice, and the Mac half is partly unrun

Working document for the fix branch. It is removed before the feature merge.

## Original issue

What a person would see, by platform. "Traced" means followed through the
code; none of the Mac items has been seen on a Mac.

1. Mac, where-is or a taught job. Jarvis points at something and the person
   keeps moving the mouse, or presses Shift or Esc, as the ring ends or is
   replaced. The notch, the tray and the page freeze for good. Nothing is
   logged and there is no crash report. Traced: sending a pointer home asked
   the main thread for the camera housing and waited, with the look's lock
   and the hands' lock held, and the main thread takes both inside the taps.
   A timer that sends the pointer home holds the hands' lock alone and meets
   the main thread in a waited click.
2. Mac, fullscreen film. The notch hides itself and never said so. Esc did
   nothing in the player while the page wanted Esc, and the yes pair
   answered a sheet nobody saw. Against rule 166 of the README.
3. Both. The page says "Esc wanted" and then hangs. Esc is dead in every app
   until Jarvis is quit.
4. Mac. While the main thread is busy every key waits on the keyboard tap.
5. Mac. Holding the talk pair and circling sometimes does nothing: two
   "watch the pointer" calls land in the wrong order.
6. Both. With the notch switched off after having been on, the where and
   around polls keep running. Against "with the notch off none of it runs".
7. Mac. A job's paste can land in Jarvis's own window, or in another
   program that moved under the place. Windows refuses both.
8. Every rule is written twice (look, act, host). Items 2 and 7 are what
   that produced. No notch test ran on macOS; on Windows only those named
   `TestNotch*`.

## Impact

Item 1 is the worst: a permanent freeze with no trace, on the platform that
has had the least testing. Items 2 and 3 take a key away from other apps.
The rest is cost: every later fix has to be made twice and proven once.

## Possible solutions

- Freeze. (a) Read the housing from a value kept by the poll that already
  reads it every two seconds. (b) Move every hands call outside the look's
  lock: rejected, the look keeps its order by that lock on purpose. (c)
  TryLock inside the taps: rejected, it hides the bug and drops moves.
- Hidden Mac notch. (a) The window's timer tells Go when it hides, as
  Windows does. (b) Move the whole hide rule into shared Go now: that is the
  host controller (step 4), larger, and it changes Windows too.
- Hung page. (a) Ask the page once a second whether it is there, and stop
  believing what it said about Esc after five seconds of silence. Needs
  nothing from the page. (b) An Esc lease the page renews: cleaner, but the
  page ships with the brain, so it cannot land alone (step 5, point 7).
- Duplication. One shared implementation behind small interfaces for the
  element tree, the act verbs and the host window, with the platform files
  kept to fetching and drawing. Rejected: Go generics over the two element
  structs (the Windows COM thread hop does not fit); merging the three
  Windows hooks now (proven code, no gain this round).
- Never-run Mac code. Fix and prove on a Mac before shipping; or keep the
  Mac notch behind its own switch until a hand checklist passes; or cut it.

## Chosen solution

Safety first, in three small steps that change no Windows behaviour, then
the shared seams.

1. The housing is kept in an atomic (`notchHousingKept`, notch_host.go) and
   the Mac's `home()` reads that. It was the only wait for the main thread
   that a goroutine could reach with the look's or the hands' lock held. One
   more wait sits under the look's lock: `Own`, asked in `Down` and
   `Clicked`. It is safe only because on a Mac both are called by the tap, on
   the main thread, where it is answered in place. That rule is written at
   `Own` and at both callers.
2. The Mac window's timer reports hide and show through `goNotchHidden`,
   which only puts the word down (`notchHideRelay`, notch.go); a goroutine
   tells `NotchService.setHidden`. A hidden window refuses the keyboard.
3. A pulse (notch_pulse.go). From attach the page is asked once a second
   until it has answered once: that proves asking works in this web view.
   After that it is asked only while it wants Esc, and silent for 5 s it
   holds no Esc until it gives a sign again. A page that never answers
   within 30 s is not watched: one log line, and Esc stays as the page says,
   as before the pulse. Known small limit: a page that hangs before its
   very first answer after loading keeps Esc. Something is put on the window's thread every second either
   way; once that thread has run and then stops for 5 s, the log gets every
   goroutine's stack (at most once in ten minutes, five times per run) and
   on the Mac the three taps are held off until it runs again. Afterwards
   the keyboard is asked what is down and only what differs is put right,
   so a hold that was not needed ends nobody's talking.
4. Host controller: one `notchHost` (notch_host_ctl.go) owning loaded,
   hidden, asking and holding the keyboard. A platform reads facts
   (`notchHostFacts`: fullscreen app in front, display kept awake, video
   playing, capture overlay) and offers Show, Hide and Focus; the host
   decides and tells the service. Esc stays with the service and the pulse
   (`takesEsc`), which hear only "hidden" from the host: one owner for Esc,
   and step 5 adds the lease there. The Mac timer only reports facts through
   `notchFactsRelay`; showing and hiding is always queued on the main thread.
5. Esc lease on the sidecar side (the page side is point 7). The page half
   landed with protocol v2 (26 November 2026): the page renews
   `__notch_esc(true)` every 2 s while it wants Esc, says `false` once, and
   calls `__notch_esc_lease(6000)` once if the desktop app has it. What is
   left here: bind `__notch_esc_lease(ms)` and let a claim lapse when no
   `__notch_esc` came for that long. No message or argument changes: the
   binding of `__notch_esc` keeps its one bool (a second argument would be
   refused). 6 s is three renewals, longer than the pulse's 5 s on purpose,
   so the pulse still lets go first on a proven page and the lease covers
   the page the pulse gave up on.
6. Element interface, then the act platform, verb by verb.
7. Mac input thread with listen-only taps.
8. One session object per connection with real stops for where and around.
9. CI: macOS runs the root package's tests (done with step 1); Windows runs
   the root package with a skip list in place of the name pattern.

## Owner decisions

- Bump sidecar/VERSION to 0.14.0 now: yes (2026-11-26). Done.
- macOS `go test` in CI now: yes. Done.
- Mac notch behind its own switch until the checklist passes: NOT decided.
  Nothing is built for it. Until it is decided the Mac notch ships as it is,
  with steps 1 to 3 unproven by hand.
- Still open: lease numbers (6 s / 2 s); fixing the Mac paste difference now
  or with the act seam.
- To confirm: a question brings the Mac notch back over a film (design open
  decision 3, recommended yes). Built in step 4, so the Mac now does what
  Windows does; README's limit line says so.
- To confirm (step 4): the host does what it decides one caller at a time,
  re-reading the state before it stops, so a question that arrives while
  the watch is hiding the window is no longer lost (on notch/main Windows
  could end hidden with a question up). The call that arrives meanwhile
  returns at once and the show is done by the caller already at work.
- To confirm (step 4): a window never shown is not hidden again (a film seen
  before the page loads); nothing on screen differs.

## Status

- Step 1, freeze: done in "notch: a Mac that cannot freeze on its pointer, a
  hidden Mac notch that takes nothing, and a hung page that keeps no Esc".
  Proven on Linux with a model of the Mac's hands round the real look and
  keyboard (23 orders, plus Own off the main thread); the Mac code itself
  was never compiled.
- Step 2, hidden Mac notch: done in the same commit. Never compiled.
- Step 3, pulse: done in the same commit, reworked after review in "notch:
  the pulse holds a page to answering from when it wants Esc, and a window
  that has not started is not gone". Shared part tested on Linux and run on
  Windows; the Mac tap hold was never compiled. The proof that asking works
  before silence counts: done in "notch: a page keeps Esc until it has
  answered the pulse once". Whether a real WebView2 or WKWebView answers at
  all has never been seen.
- VERSION 0.14.0: done in "sidecar: 0.14.0".
- macOS go test in CI: done in "ci: the sidecar's tests run on macOS", with
  a job limit in "ci: the macOS sidecar job has a limit". Never run by a
  runner.
- Windows half of step 9: done in "ci: the Windows sidecar job runs the
  root package with a skip list", after "sidecar: six tests that assumed
  Linux hold on Windows". Skip list: the Chromium tests (run on linux),
  two launch_app tests that start /bin/sleep, one that reads
  /etc/localtime. Run on a Windows 11 desktop: 923 tests, 9 listed, 905
  pass, 9 skip themselves, 0 fail. One other run died with an access
  violation inside SHGetFileInfo (exeIconPNG, notch_where_windows.go, on a
  thread with no COM set up); not seen again alone or in a later full run.
  Never run by a runner: whether windows-latest gives the window, pointer
  and hotkey tests a desktop.
- Step 4, host controller: done in "notch: one window rule for Windows and
  the Mac, and a question brings the Mac notch back over a film". First
  pinned in "notch: the Windows window rule pinned as a table, on a copy of
  today's code": the tables run against that copy and against `notchHost`,
  and the counted run (shows, hides, tells) matches it step by step. The
  source-text pin in desktop_wiring_test.go is gone. Proven on Linux (with
  -race) and run on Windows from WSL (the tables, plus the screen and sound
  reads); Windows vet and test build clean. Not seen by hand on Windows (try.sh:
  film hides, question brings back, Esc leaves fullscreen, no keyboard while
  hidden). The Mac code was never compiled; its wiring is held by a text test.
- Steps 5 to 8: pending.

## Only a Mac can say (and one look on Windows)

Nothing below has been seen. The first four need no person, only the CI job.

- It compiles for arm64 and amd64 (the C added to four files, the new
  bridge file, the darwin test, `_Atomic int` under Objective-C with ARC).
- Which shared tests fail or hang on their first run on macOS. A test that
  waits for the main thread hangs until the 10 minute limit.
- The darwin test passes, and fails with the old `home()`.
- `CGEventTapEnable` called from a goroutine, not the main thread, takes
  effect and does no harm.
- A hidden (ordered out) WKWebView still answers the pulse while it wants
  Esc. If not: Esc is the app's while hidden anyway, and for up to a second
  after the notch comes back.
- App Nap during a long film: the pulse's own goroutine and the page are
  both slowed. A slowed pulse rebases after a 3 s gap and blames nobody; a
  slowed page alone would read as silent.
- Sleep and wake with a sheet up: no "has not answered" line, Esc still the
  notch's after waking.
- By hand, on Windows as well as on the Mac: after start, sidecar.log says
  "the page answers when asked" (and never "nothing watches this page");
  and Esc still cancels a fuse 10 s after a sheet comes up.
- Step 4 on a Mac: it compiles (the new `jarvis_notch_show`, `goNotchFacts`
  export); a film hides the notch within about 400 ms; `fixture.sh approval`
  during the film brings it back, and it hides again once answered; the
  log says "hidden: a video is playing" and "shown again".
- By hand: where-is ten times while circling the mouse and tapping Shift and
  Esc, with two waits left to time out (no freeze); a fullscreen film with a
  sheet up that asks nothing (Esc leaves fullscreen, yes does nothing, a text
  field does not bring the notch back); kill the WebKit content process with a sheet up
  (Esc works elsewhere within about 6 s, and the log says why).
