# The notch

A desktop surface that is still being built: Jarvis in a shape at the top
centre of the screen, one line at a time. It ships dark. This page states what
"dark" guarantees, the messages that exist so far, and how to try a build.

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
   listener, sends no `notch.*` message to any desktop app, and has no notch
   page: the route is absent, not refused.
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
7. **The page cannot cut the window to any shape it likes.** An outline with
   fewer than 3 or more than 720 points, a malformed point, or a point far
   outside the window is refused whole and the previous shape stays. The page
   sends two outlines at a time, and one bad outline refuses both.
8. **Appearing never takes the keyboard.** The window is shown without
   activation. It takes the keyboard only when the page calls
   `__notch_focus(true)`, and gives it back to the window that had it.
9. **It hides for a fullscreen video and only then:** a fullscreen app in front
   AND something keeping the display awake. A browser in fullscreen that is
   only being read keeps the notch. A screen capture choosing its area covers
   the screen too: while Windows' own capture tools are in front the notch
   stays exactly as it was.

## What it does not protect, and what is missing

- The page is a test page (four sizes, eyes that follow the pointer, and a text
  box), not the notch.
- On Windows the last 1.5 CSS pixels inside the edge belong to the backdrop
  window, not the page (see "How the edge is drawn"). That band is always
  black, whatever the page paints there.
- The smooth edge and the pointer feed have run on one Windows machine (a
  2560 by 1440 display at 100%). Outline points with fractions of a pixel have
  not: they were added after that run, because corners sent on whole pixels
  read as polygons.
- The fullscreen rule reads "the display is being kept awake" for the whole
  machine. A video playing in another window while a different app is
  fullscreen in front also hides the notch. Worse, any program that holds the
  display awake all the time turns the rule into "hide for every fullscreen
  app". On the first test machine something did hold it throughout. The log
  says so at start (`at start, display kept awake: true`) and names the
  program and window class in front each time the rule hides the notch. The
  signal may have to be replaced.
- **macOS (`sidecar/notch_host_darwin.go`) has never been compiled or run.**
- On Linux the window opens as an ordinary always-on-top panel: no shape, no
  focus rule, no fullscreen rule.
- There is no per-machine opt-out: every desktop app that advertises the
  capability is told to host it when the brain's switch is on.

## Messages

| Direction | Message | Params | Answer |
|---|---|---|---|
| brain to desktop app | `notch.configure` | `{enabled: boolean}` | `{configured: true, enabled, surface: "none" \| "window"}` |
| brain to desktop app | `notch.spawn` | `{url: string}`, on the brain's origin | `{spawned: true, already: boolean}` |
| brain to desktop app | `notch.close` | none | `{closed: boolean}` |

The page talks to the desktop app through three functions on `window`:

| Function | Meaning |
|---|---|
| `__notch_set_outline(shape, cut)` | Two closed polygons, each `[[x, y], ...]` in the window's own pixels (CSS pixels times the display scale). Fractions of a pixel are kept and matter: send a curve as it is, with a point about every pixel and a half, not moved onto whole pixels. `shape` is the notch's true outline. `cut` is the same outline 1.5 CSS pixels in. Both are checked; if either is refused, nothing changes |
| `__notch_focus(true \| false)` | Take the keyboard for a text field, or give it back. Answers whether the notch has it |
| `__notch_log(text)` | One line in the desktop app's log, for test runs |

and the desktop app calls one function the page defines:

| Function | Meaning |
|---|---|
| `window.__notch_cursor(x, y)` | Where the pointer is, in the page's own pixels from the window's top left corner. Sent about 30 times a second, and only when the pointer has moved. The page hears the mouse only inside its outline, so this is how the eyes follow the pointer across the screen |

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
