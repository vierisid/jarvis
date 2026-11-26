# Point 10: the desktop app's platform code is written twice, and the Mac half is partly unrun

Working document for the fix branch. It is removed before the feature merge.
Full design: `.claude/notch-fixes/fix-10-sidecar-platform.md` (local, not tracked).

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
   reachable under the look's or the hands' lock.
2. The Mac window's timer reports hide and show through `goNotchHidden`,
   which only puts the word down (`notchHideRelay`, notch.go); a goroutine
   tells `NotchService.setHidden`. A hidden window refuses the keyboard.
3. A pulse (notch_pulse.go) asks the page once a second on the window's
   thread. A page that answered before and is silent for 5 s holds no Esc
   until it answers again. If the window's thread itself stands still, the
   log gets every goroutine's stack once, and on the Mac the three taps are
   held off until it runs again.
4. Host controller: one `notchHost` owning loaded, hidden, asking, focus.
5. Esc lease on the sidecar side (the page side is point 7).
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
- Still open: lease numbers (6 s / 2 s); a question bringing the Mac notch
  back over a film; fixing the Mac paste difference now or with the act seam.

## Status

- Step 1, freeze: done in "notch: a Mac that cannot freeze on its pointer, a
  hidden Mac notch that takes nothing, and a hung page that keeps no Esc".
  Proven on Linux with a model of the Mac's hands round the real look and
  keyboard (23 orders); the Mac code itself was never compiled.
- Step 2, hidden Mac notch: done in the same commit. Never compiled.
- Step 3, pulse: done in the same commit. Shared part tested on Linux and
  run on Windows; the Mac tap hold was never compiled.
- VERSION 0.14.0: done in "sidecar: 0.14.0".
- macOS go test in CI: done in "ci: the sidecar's tests run on macOS". Not
  yet run by a runner; the first run may find shared tests that fail there.
- Steps 4 to 8 and the Windows half of step 9: pending.
- Mac hand checks owed for steps 1 to 3: where-is ten times while circling
  the mouse and tapping Shift, with two waits left to time out; a fullscreen
  film with a sheet up (Esc leaves fullscreen, yes does nothing, a text
  field does not bring the notch back); kill the WebKit content process
  with a sheet up (Esc works elsewhere within 6 s).
