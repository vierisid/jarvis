# The notch

A desktop surface that is still being built: Jarvis in a shape at the top
centre of the screen, one line at a time. It ships dark. This page states what
"dark" guarantees, the messages that exist so far, and how to try a build.

Where things are:

| What | Where |
|---|---|
| The switch, and telling a desktop app to host the notch | `src/notch/switch.ts`, `src/notch/attach.ts` |
| What the brain and the page say to each other | `src/notch/protocol.ts` |
| What the notch is showing, held by the brain | `src/notch/surface.ts` |
| Canned moments for trying it, and their gate | `src/notch/demo.ts`, `src/notch/demo-gate.ts`, `src/cli/notch.ts` |
| The page | `ui/notch.html`, `ui/src/notch/` |
| The window, its shape and its rules | `sidecar/notch*.go` |
| The keys | `sidecar/notch_keys.go` (the deciding), `notch_keyboard.go`, `notch_keys_winlogic.go`, `notch_keys_windows.go`, `notch_keys_darwin.go` |

## The switch

- `JARVIS_NOTCH=1` in the brain's environment turns the notch on. Any other
  value is off, including `true` (`src/notch/switch.ts`).
- It is classified as a setting, not a secret (`JARVIS_SETTINGS_ENV_NAMES` in
  `src/util/model-exec-env.ts`), so a brain restarted from the assistant's own
  shell keeps the owner's choice.
- A desktop app advertises the capability `notch` to say it understands
  `notch.*`. It hosts nothing until the brain tells it to.
- When a desktop app connects, a brain with the switch on sends it
  `notch.configure {enabled: true}` (`src/notch/attach.ts`).

The decision is the brain's alone. A desktop app cannot turn the surface on by
itself, and `sidecar.yaml` has no setting for it.

## Invariants this protects

1. **Off means silent.** With the switch off the brain registers no notch
   listener, sends no `notch.*` message to any desktop app, holds no notch
   state, and has no notch route: absent, not refused. The page's built files
   ship in `ui/dist` like any other asset and are inert: the page draws
   nothing until a brain answers its hello, and a brain with the switch off
   never does.
2. **Old desktop apps are left alone.** A desktop app that does not advertise
   `notch` is never sent `notch.*`, whatever the switch says. One that
   advertises it but reports `surface: "none"` is never asked for a window.
3. **The switch does not outlive its connection.** The desktop app keeps it in
   memory and turns it off on disconnect, which also closes the window. A brain
   that reconnects with the notch off says nothing, so nothing stale survives a
   brain restart.
4. **A malformed request changes nothing.** `notch.configure` without a boolean
   `enabled` is refused and the switch stays where it was. `notch.spawn` is
   refused while the switch is off.
5. **`bun run dev:local` does not turn it on.** The launcher builds its
   environment from scratch and carries `JARVIS_NOTCH` across only when the
   caller set it to exactly `1` (`scripts/integration/dev-env.ts`).
6. **Only the brain's own page renders.** `notch.spawn` pins its URL to the
   brain origin in the enrolment token and signs it in with a short-lived
   access token, exactly as `panel.spawn` does.
7. **The page cannot cut the window to any shape it likes.** An outline is at
   most 16 polygons and 720 points in all. A polygon of fewer than 3 points, a
   malformed point, or a point far outside the window, and the outline is
   refused whole and the previous shape stays. The page sends two outlines at
   a time, and one bad outline refuses both.
8. **Appearing never takes the keyboard.** The window is shown without
   activation. It takes the keyboard only when the page calls
   `__notch_focus(true)`, and gives it back to the window that had it.
9. **It hides for a fullscreen video and only then.** A browser in fullscreen
   that is only being read keeps the notch. When in doubt the notch stays.
   - **Windows:** all three must hold. A fullscreen app is in front. Something
     is keeping the display awake, which every player does while it plays. And
     the app is being watched (`sidecar/notch_video.go`): no mouse or keyboard
     input for 1.2 seconds, the app has hidden the mouse pointer, and either
     the app is playing sound or the picture has moved in the last 3.2
     seconds. Two looks in a row, 400 ms apart, hide the notch. Twelve in a row
     without, about five seconds, bring it back, and leaving fullscreen brings
     it back at once. A pointer in plain view always keeps the notch: that is
     what tells a page being read from a film.
   - **macOS:** a fullscreen app is in front, and that app (itself, a helper
     inside its bundle, or the system's WebKit process) is the one asking for
     the display to stay on.
   - A screen capture choosing its area covers the screen too: while Windows'
     own capture tools are in front the notch stays exactly as it was.

10. **The desktop app carries the messages and reads none.** What the brain
    and the page say to each other passes through it as JSON, at most 64 KB a
    message, in the order it was sent (`notch.push` is handled on the
    connection's own thread for that). It refuses what is not JSON, a push
    with the switch off, and a push with no page up. It never acts on a
    message's content.
11. **What the notch shows lives in the brain.** A page that appears says
    hello and is told everything at once, so a desktop app restarted in the
    middle of a line shows the same line, with the words the person had
    already changed. A page that has not said hello on its present connection
    is sent nothing.
12. **The page decides nothing.** It reports what the person did (yes, no, a
    pick, a changed word, typed text) and the brain decides what that means.
    The brain reads those reports strictly: anything that is not exactly one
    of its four messages is dropped, and an answer about a line that is no
    longer on the notch is dropped as late.
13. **The demo endpoint is shut unless opened on purpose.** `POST
    /api/notch/demo` exists only with the switch on, a `JARVIS_NOTCH_DEMO`
    secret of 16 or more characters, and not on a hosted install, and every
    request must echo the secret. Otherwise it answers 404. It can make the
    notch show sample sentences and nothing else.

14. **The keyboard is watched only while the notch is on screen.** The watch
    starts when the notch's page is attached and ends when it is detached, so
    it cannot outlive the switch. With the switch off nothing looks at the
    keyboard for the notch at all.
15. **What the watch may know.** A key is Esc, one of the eight modifier keys,
    or "another key". Which other key it was is not passed on, kept or logged,
    by construction: the event the deciding code is fed has no field for it.
    On macOS plain typing does not even reach Go. Nothing is logged from
    inside the watch.
16. **What the watch may change.** Esc is kept from the app in front while the
    notch has something Esc would close, and only then (and the second Esc of
    a quick two). No other key is ever kept. When a pair has been understood
    one key that no keyboard has is sent, so that letting go of the Windows
    key or Alt does not open the Start menu or the menu bar.
17. **Only a person talks to the notch.** A key a program sent is not seen
    by the watch at all, on either system. Jarvis itself types and presses
    keys in other apps: an Esc it presses there reaches that app, and a pair
    it presses is never a yes to its own offer.
18. **The watch ends with the switch, at once.** Turning the switch off stops
    the watch before the window is closed, not when it has finished closing.
19. **A message into a closing window is dropped.** Everything sent into the
    page checks first that the window is not on its way out. On Windows a
    script run while the web view is being taken apart is a crash.

## The keys

| What | Keys | How it is told |
|---|---|---|
| Talk | hold Ctrl + Win (Mac: Ctrl + Option) | the pair down alone for 150 ms; ends when either comes up or any other key goes down |
| Yes | tap Win + Alt (Mac: Option + Cmd) | the two down within 0.7 s of each other and up again within 1.5 s, with no other key |
| Esc | Esc | only while the notch has something on it, and never with a modifier |
| Stop everything | Esc twice | the second within 0.4 s of one that was taken |

- A pair is two different modifier keys. Left and right are the same key.
  AltGr is never Ctrl and never Alt.
- A shortcut that begins with the same keys (Ctrl + Win + D, Win + Alt + R)
  is not ours: any other key makes the press somebody else's.
- One press of the modifiers says one thing. Letting go of one talk key and
  pressing Alt does not become a yes.
- The pairs are per machine: `notch_talk_keys` and `notch_yes_keys` under
  `preferences` in `sidecar.yaml`, written like `ctrl+meta`, or the two lists
  in the desktop app's settings window (shown only while the notch is on). An
  unreadable pair, or the same pair twice, falls back to the system's default.
- The page shows the machine's own keys in its hints. With nothing on the
  notch, yes opens Jarvis.
- Windows takes a low-level hook away, without saying so, if its callback is
  ever too slow. The hook is put back once a minute while no key is down.
- Twice a second the watch checks the keys it believes are down against what
  Windows says. A key let go over a window that runs as administrator, or
  while the screen was locked, never reaches the hook; this is what ends a
  talk that such a release left hanging.
- Keys sent by a remapping tool are keys a program sent, so the notch does
  not see them. Someone who remaps Ctrl, Alt or the Windows key in software
  needs to pick pairs from keys that are not remapped.
- A window that runs as administrator in front (Task Manager) does not let
  the hook see keys. Nothing can be done about that from here.
- `notch.configure` answers `keys: "watch" | "blocked" | "none"`. On macOS
  the tap needs the Accessibility permission, asked for in setup and never
  from the watch itself; without it the answer is `blocked` and the notch
  answers to the mouse only.

## What it does not protect, and what is missing

- Nothing real feeds the notch yet. The only thing that puts a line on it is
  the demo (`jarvis notch demo`), with sample data.
- Talking is only seen, not heard: holding the talk keys makes the notch perk
  up. Speech comes in a later pass.
- The keys have not been tried by hand yet on Windows, and the macOS tap has
  never run.
- The existing Ctrl + Shift + Space hotkey is untouched and still does what
  it did.
- What the prototype drew outside the black shape is not there: the soft
  shadow under the notch, and things arriving along the whole top edge of the
  screen. The window is 800 pixels wide, so an arrival starts at its edge.
- A brain that restarts forgets the line. Only the desktop app restarting is
  covered.
- Two desktop apps on one brain show the same line, and the first answer is
  the one that counts. Nothing yet tells the other notch that it was answered.
- On Windows the last 1.5 CSS pixels inside the edge belong to the backdrop
  window, not the page (see "How the edge is drawn"). That band is always
  black, whatever the page paints there.
- The smooth edge and the pointer feed have run on one Windows machine (a
  2560 by 1440 display at 100%). Outline points with fractions of a pixel have
  not: they were added after that run, because corners sent on whole pixels
  read as polygons.
- The fullscreen rule was rebuilt twice on evidence from one machine. "The
  display is being kept awake" alone failed because some other program held
  the display all day, so a browser in fullscreen lost the notch. "The picture
  keeps changing" alone failed because much of what people watch barely moves:
  a fullscreen video kept the notch. What the present rule cannot tell:
  - A muted video that does not move at all keeps the notch.
  - The notch stays over a film until the player hides the pointer, about
    three seconds after the hand leaves the mouse, and returns about five
    seconds after the pointer is back in view.
  - With the pointer resting on another display the rule asks for sound and a
    moving picture together, so a still video keeps the notch then.
  - An app that hides the pointer while typing and is also playing sound (a
    document in a fullscreen browser with music in another tab) reads as a
    video once the typing stops.
  - A Store app's window belongs to a host process, so for it any program's
    sound counts.
  - Sound is asked of the default output device only.
- The log names the program and window class in front each time the rule
  hides the notch, says at start whether the display was already being kept
  awake, and while a fullscreen app is in front writes what it saw every two
  seconds for the first twenty (`looking at chrome: hands off ..., pointer
  hidden ..., app sound ..., picture change ..., video ...`).
- **macOS (`sidecar/notch_host_darwin.go`) compiles in CI and has never been
  run.**
- On Linux the window opens as an ordinary always-on-top panel: no shape, no
  focus rule, no fullscreen rule.
- There is no per-machine opt-out: every desktop app that advertises the
  capability is told to host it when the brain's switch is on.

## Messages

| Direction | Message | Params | Answer |
|---|---|---|---|
| brain to desktop app | `notch.configure` | `{enabled: boolean}` | `{configured: true, enabled, surface: "none" \| "window", keys: "none" \| "watch" \| "blocked"}` |
| brain to desktop app | `notch.spawn` | `{url: string}`, on the brain's origin | `{spawned: true, already: boolean}` |
| brain to desktop app | `notch.close` | none | `{closed: boolean}` |
| brain to desktop app | `notch.push` | `{message: any JSON}`, for the page | `{pushed: true}` |
| desktop app to brain | event `notch.message` | `{message: any JSON}`, from the page | none |

The page talks to the desktop app through six functions on `window`:

| Function | Meaning |
|---|---|
| `__notch_set_outline(shapes, cuts)` | Two lists of closed polygons, each polygon `[[x, y], ...]` in the window's own pixels (CSS pixels times the display scale). Fractions of a pixel are kept and matter: send a curve as it is, with a point about every pixel and a half, not moved onto whole pixels. `shapes` is the notch's true silhouette: its body, and any small shapes on the screen's edge beside it. `cuts` is the same 1.5 CSS pixels in, and may hold fewer polygons or none. Shapes that overlap are joined. Both lists are checked; if either is refused, nothing changes |
| `__notch_focus(true \| false)` | Take the keyboard for a text field, or give it back. Answers whether the notch has it |
| `__notch_send(text)` | One message for the brain, as JSON text |
| `__notch_esc(true \| false)` | Whether Esc would do anything on the notch right now. Only then is it taken from the app in front |
| `__notch_keys()` | Answers the machine's two pairs, `{talk: [a, b], yes: [a, b]}`, each key one of `ctrl`, `alt`, `meta`, `shift` |
| `__notch_log(text)` | One line in the desktop app's log, for test runs |

and the desktop app calls four functions the page defines:

| Function | Meaning |
|---|---|
| `window.__notch_receive(message)` | One message from the brain |
| `window.__notch_key(name)` | What the keys said: `talk-start`, `talk-end`, `yes`, `esc`, `esc-twice` |
| `window.__notch_pairs(pairs)` | The pairs changed in the settings: same shape as `__notch_keys()` answers |
| `window.__notch_cursor(x, y, down)` | Where the pointer is, in the page's own pixels from the window's top left corner, and whether the main mouse button is down (1 or 0). Sent about 30 times a second, and only when something changed. The page hears the mouse only inside its outline, so this is how the eyes follow the pointer across the screen, and how a click in the app underneath closes a sheet |

## What the brain and the page say to each other

Version 1, in full in `src/notch/protocol.ts`. One thing is on the notch at a
time; a new `show` replaces it.

| From | Message | Meaning |
|---|---|---|
| page | `hello {v}` | The page is up. Answered with `state` |
| brain | `state {line, count, born}` | Everything the notch should show, at once |
| brain | `show {line}` | Put this on the notch |
| brain | `rest` | Back to the eyes |
| brain | `count {count}` | How many things wait |
| brain | `update {id, ...}` | Change the line on the notch in place: steps done, a new sentence, words heard, a sheet's content |
| brain | `act {...}` | A face, a movement, a birth, the watching eye, the mouth, sounds. Not remembered |
| page | `answer {id, act, ...}` | What the person did with the line `id` |
| page | `open` | A click on the resting notch, or yes with nothing on it |
| page | `stop` | Esc twice: stop everything, and start nothing until told |

A line is one of seven kinds: `say` (a result that leaves by itself), `offer`
(yes or no, or a row of choices), `sheet`, `ask` (a text field), `work`
(steps), `send` (a window to take it back) and `listen`. A sentence is made
of plain words, `em` words, keycaps and lit words the person can change.

After `no`, `fold`, and a `say` that finished, the page has gone to rest by
itself. After any other answer it keeps the line until the brain says what
comes next.

## How the edge is drawn

A window cut to a polygon has a stepped edge: each pixel is in or out.

- **Windows.** A second window sits directly behind the page's window. It is
  drawn pixel by pixel with partial transparency along the edge
  (`sidecar/notch_raster.go` works out how much of each pixel the shape
  covers, from the outline's exact points), never takes clicks, and never
  takes the keyboard. The page's window
  is cut to `cut`, just inside it, so the stepped cut is hidden on black. The
  two windows are tied together as owner and owned, so they keep their order,
  and they are shown and hidden together.
- **macOS.** The page's window is masked by a shape layer, which is smooth
  already. Only `shape` is used.

## Trying a build

One command builds the desktop app from the checkout and runs the brain with
the switch on, against data kept apart from any installed Jarvis:

```sh
scripts/notch/try.sh
```

- **On WSL** it cross-builds the Windows desktop app into
  `%USERPROFILE%\JarvisNotchDev`, prints an enrolment token the first time,
  starts the brain on port 3143 with its data in `~/.jarvis-notch`, and then
  starts the desktop app. The first time, a window asks for the token. An
  installed Jarvis has to be quit from the tray first; a test build that is
  still running is stopped and replaced.
- **On a Mac** it builds `~/JarvisNotchDev/Jarvis.app` and writes
  `start-sidecar.command` beside it. Quit Jarvis from the menu bar, then run
  that file and paste the token. The Mac path has not been run yet.
- The test build has its own profile folder. It cannot run beside an installed
  Jarvis on Windows (single-instance lock). Leave "start at login" off in it.
- `--token` prints a fresh token, `--no-build` skips the desktop app build.
  `NOTCH_DATA_DIR`, `NOTCH_PORT`, `NOTCH_WIN_DIR` and `NOTCH_MAC_DIR` override
  the defaults.

### Playing the demo

With that brain running, in a second terminal:

```sh
scripts/notch/demo.sh            # a menu of moments
scripts/notch/demo.sh mail       # one moment
scripts/notch/demo.sh stop
```

It is `jarvis notch demo` pointed at the test brain. `try.sh` makes the secret
the first time and keeps it in the test data folder. Against any other brain:
start it with `JARVIS_NOTCH=1` and `JARVIS_NOTCH_DEMO=<16 or more characters>`,
and run `jarvis notch demo <moment>` with the same `JARVIS_NOTCH_DEMO` set.

The page can also be tried without the desktop app or a brain, in a browser.
The preview runs the real page with the brain's own demo scripts, and can draw
the outline the desktop app would be given over what the page paints:

```sh
bun ui/src/notch/preview/serve.ts
```

### When Windows refuses the build

A local build of the desktop app is not signed. On a Windows machine with Smart
App Control switched on, each unsigned program is judged by itself: some builds
run and some are refused with "An Application Control policy has blocked this
file". `try.sh` checks for this after building and stops with a message, and
Windows records it in the event log under Applications and Services Logs,
Microsoft, Windows, CodeIntegrity, Operational (events 3077 and 3033).

There is no way around it from this side, and there should not be. The choices
belong to the machine's owner and to whoever holds the signing key:

- test on a Windows machine where Smart App Control is off, or
- have the test build signed. Release builds are signed in CI by a protected
  `signing` environment that is limited to `main` and release tags, so a branch
  build cannot use it as things stand.

With the switch on and a current desktop app connected, the brain prints:

```
[notch] switch on
[notch] "notch-dev" ready, surface: window
[notch] "notch-dev" is showing the notch
```

and the desktop app's log (`profile\.jarvis\sidecar.log` in the test folder)
has the window's size and place, what the page measured, each time the
keyboard was taken or given back, and each time the fullscreen rule hid or
showed the notch.
