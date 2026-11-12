# The notch

A desktop surface that is still being built: Jarvis in a shape at the top
centre of the screen, one line at a time. It ships dark. This page states what
"dark" guarantees, the messages that exist so far, and how to try a build.

## The switch

- `JARVIS_NOTCH=1` in the brain's environment turns the notch on. Any other
  value is off, including `true` (`src/notch/switch.ts`).
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
   outside the window is refused whole and the previous shape stays.
8. **Appearing never takes the keyboard.** The window is shown without
   activation. It takes the keyboard only when the page calls
   `__notch_focus(true)`, and gives it back to the window that had it.
9. **It hides for a fullscreen video and only then:** a fullscreen app in front
   AND something keeping the display awake. A browser in fullscreen that is
   only being read keeps the notch.

## What it does not protect, and what is missing

- The page is a test page (three sizes and a text box), not the notch.
- The window's edge is cut by a region, so it is not anti-aliased.
- The fullscreen rule reads "the display is being kept awake" for the whole
  machine. A video playing in another window while a different app is
  fullscreen in front also hides the notch.
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
| `__notch_set_outline([[x, y], ...])` | The notch's outline, in the window's own pixels (CSS pixels times the display scale). The window is cut to it |
| `__notch_focus(true \| false)` | Take the keyboard for a text field, or give it back. Answers whether the notch has it |
| `__notch_log(text)` | One line in the desktop app's log, for test runs |

## Trying a build

One command builds the desktop app from the checkout and runs the brain with
the switch on, against data kept apart from any installed Jarvis:

```sh
scripts/notch/try.sh
```

- **On WSL** it cross-builds the Windows desktop app into
  `%USERPROFILE%\JarvisNotchDev`, prints an enrolment token the first time, and
  starts the brain on port 3143 with its data in `~/.jarvis-notch`. On Windows,
  quit Jarvis from the tray, then run
  `%USERPROFILE%\JarvisNotchDev\start-sidecar.cmd` and paste the token.
- **On a Mac** it builds `~/JarvisNotchDev/Jarvis.app` and writes
  `start-sidecar.command` beside it. Quit Jarvis from the menu bar, then run
  that file and paste the token. The Mac path has not been run yet.
- The test build has its own profile folder. It cannot run beside an installed
  Jarvis on Windows (single-instance lock). Leave "start at login" off in it.
- `--token` prints a fresh token, `--no-build` skips the desktop app build.
  `NOTCH_DATA_DIR`, `NOTCH_PORT`, `NOTCH_WIN_DIR` and `NOTCH_MAC_DIR` override
  the defaults.

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
