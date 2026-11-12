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
   listener and sends no `notch.*` message to any desktop app.
2. **Old desktop apps are left alone.** A desktop app that does not advertise
   `notch` is never sent `notch.*`, whatever the switch says.
3. **The switch does not outlive its connection.** The desktop app keeps it in
   memory and turns it off on disconnect. A brain that reconnects with the
   notch off says nothing, so nothing stale survives a brain restart.
4. **A malformed request changes nothing.** `notch.configure` without a boolean
   `enabled` is refused and the switch stays where it was.
5. **`bun run dev:local` does not turn it on.** The launcher builds its
   environment from scratch and carries `JARVIS_NOTCH` across only when the
   caller set it to exactly `1` (`scripts/integration/dev-env.ts`).

## What it does not protect, and what is missing

- There is no surface yet. `notch.configure` answers `surface: "none"`.
- The dashboard's capability descriptor does not mention the notch.
- There is no per-machine opt-out: every desktop app that advertises the
  capability is told to host it when the brain's switch is on.
- A desktop app built before this change answers `METHOD_NOT_FOUND` only if it
  somehow advertised the capability. It never does, so the brain does not ask.

## Messages

| Direction | Message | Params | Answer |
|---|---|---|---|
| brain to desktop app | `notch.configure` | `{enabled: boolean}` | `{configured: true, enabled, surface: "none"}` |

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
[notch] "notch-dev" ready, surface: none
```

and the desktop app's log has `[notch] switch on (surface: none)`.
