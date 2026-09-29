# Pebble global hotkeys

Two global hotkeys reach the pebble:

- **summon** - `Ctrl+Shift+Space`. Toggles listening and shows the bubble, the
  same thing a click on the disc does.
- **palette** - `Ctrl+Shift+K`. Opens the fuzzy room picker at the cursor.

The same pair on macOS, Windows and Linux. Both are configurable, and both are
registered by the *sidecar*, on the machine with the keyboard; the daemon only
decides which keyspec to ask for.

```yaml
# ~/.jarvis/config.yaml
pebble:
  summon_hotkey: "ctrl+shift+space"
  palette_hotkey: "ctrl+shift+k"
```

The defaults live in exactly one place - `PEBBLE_DEFAULT_SUMMON_HOTKEY` and
`PEBBLE_DEFAULT_PALETTE_HOTKEY` in `src/config/pebble-hotkeys.ts`. The
resolution path is per-platform capable (it is handed the connecting sidecar's
OS, so a hosted brain on a Linux VPS resolves for the Mac that actually has the
keyboard), but the override table is empty: one pair ships to all three.

## Changing them

Set either to `""`, `none` or `off` to register no global hotkey at all. On macOS
that is a reasonable thing to want - see "macOS cannot consume the key".

Leaving a key **empty** is not the same as disabling it: a bare `summon_hotkey:`
and `summon_hotkey: ~` both parse as YAML null, which counts as "not configured"
and gets the default back. Use `""`, `none` or `off` to mean off - and only
those three. `no` is not one of them: YAML keeps it as the string `"no"`, which
is read as a key name, and since it carries no modifier it is refused and
reported like any other unusable value.

> On **Windows** only, disabling the palette hotkey by any of the three
> spellings also switches off the Ctrl+middle-click
> palette trigger, because the overlay gates its mouse hook on the same value
> (`pebble_overlay_windows.go`). That coupling predates #563 and is deliberate -
> it is how a caller opts out of the global mouse hook - but it means a Windows
> user who disables the palette hotkey loses the mouse gesture with it.

**One setting, every machine.** There is a single `pebble:` section and it
applies to every connected sidecar, so a Mac and a Windows box on the same brain
cannot have different bindings. That matters here more than it usually would,
because the app-level cost below lands on only one of them. If you need
per-machine bindings, say so on the issue - the resolver is already handed the
connecting sidecar's OS, so the hook exists.

`pebble:` is a SYSTEM section: it is read from `config.yaml` and is not one of
the `USER_OWNED_SECTIONS` the dashboard owns, so editing the file is how you
change it. `loadConfig` deep-merges the file over the defaults and discards only
the listed user-owned sections, so an unlisted top-level section survives - the
same route the system-owned `tools:` section takes (see the note on
`daemon.log_file_path` in `src/config/types.ts`).

**When a change takes effect: restart the daemon** (`jarvis restart`). Nothing
less will do, and it is worth knowing why, because two separate caches are
involved:

- The **daemon** reads `config.yaml` once, at boot. Restarting only the sidecar
  makes the daemon re-send the keyspec it resolved when it started, which is the
  old one, so the edit appears to do nothing. `SIGHUP` does not help either -
  `pebble:` is not one of the sections the daemon re-reads on a reload.
- The **sidecar** reads the keyspec at `pebble.spawn`, and `Spawn` is idempotent:
  it returns early on a `spawned` latch and discards the spec. So a sidecar that
  outlived the daemon restart would keep its old hotkeys while answering
  `{"spawned": true}` - the user told it worked while nothing changed. The daemon
  therefore sends `pebble.close` before the first `pebble.spawn` it sends to each
  sidecar, which drops the stale overlay and its hotkey registrations.
- A later **reconnect** does not close anything, because the daemon remembers
  what it last asked that sidecar for. A network blip does not make the pebble
  blink.
- That memory is per daemon *process*, so **every** daemon restart closes and
  respawns the overlay, whether or not the config changed: the disc blinks once
  and there is a brief window with no hotkey registered. That is deliberate -
  `pebble.spawn` answers `{"spawned": true}` without saying which keyspec it is
  actually running, so the daemon cannot tell a stale binding from a current one
  and closes defensively rather than silently keeping the old key. Having the
  sidecar echo the keyspec it registered would remove the need, and is the
  obvious follow-up.

### What a keyspec may not be

Three rules beyond the grammar, all enforced by the daemon so the message
reaches you rather than a sidecar log:

- **At least one modifier**, unless the key is an F-key. `summon_hotkey: "a"`
  is refused. On Windows and Linux binding a bare letter would seize it and
  break typing immediately and loudly; on macOS the monitor is passive, so the
  letter keeps typing normally and the only symptom is the pebble waking up -
  and opening the microphone - every time you press `a` in any application.
  `f13` is exactly the case the exception exists for.
- **The two hotkeys may not be the same key.** Windows refuses the second
  registration; macOS installs two monitors and fires both callbacks on one
  press. If they collide, the summon hotkey wins, the palette hotkey is not
  registered, and it is reported.
- **128 bytes**, which no real keyspec approaches. Bytes, not characters, so
  the daemon and the sidecar agree on the limit.

On the F-key exception: it exists because a bare F-key is a normal binding on
every platform, but only **F13 and above** are actually free on stock macOS.
Bare `f1`-`f12` there drive brightness, Mission Control and the media keys, and
since the macOS monitor cannot consume a keystroke you would get both. `f13` and
`f16`-`f19` are the clean ones, and they need an external full-size keyboard.

A keyspec that is not a hotkey at all (`summon_hotkey: 3`, `"ctrl+"`,
`"hyper+k"`) is logged as an error naming the key and the problem, and the
default is used instead. It is never silently swallowed.

A keyspec that is the right *shape* but names a key the platform does not have
is a different case, and a quieter one. The daemon deliberately does not check
key names - the three platforms resolve them against three different tables, and
a hosted daemon may be resolving for a machine it is not running on - so
`ctrl+shift+zzz`, or `ctrl+insert` on macOS, is passed through as valid. The
**sidecar** then refuses it at registration with `unsupported key "..."`, and the
result is no hotkey and no fall back to the default. If a hotkey is dead and the
daemon log is clean, that message is in the *sidecar* log. Note this is the
opposite policy to `daemon.port`, which aborts startup rather than guessing
(`src/config/port.ts`): a mistyped hotkey must not stop the daemon booting. The
error is emitted when a sidecar connects, not at boot, so look in the log around
the sidecar's connection rather than in the startup banner.

## Keyspec grammar

`modifier+modifier+key`, case-insensitive, the last `+`-separated token is the
key. A key with no modifier (`f13`) is allowed.

| modifier | spellings | macOS | Windows | Linux/X11 |
|---|---|---|---|---|
| Control | `ctrl`, `control` | Control | Ctrl | Control |
| Shift | `shift` | Shift | Shift | Shift |
| Option/Alt | `alt`, `option`, `opt` | Option | Alt | Mod1 |
| Command/Super | `cmd`, `command`, `super`, `win`, `meta` | Command | Win | Mod4 |

Keys: `a`-`z`, `0`-`9`, `f1`-`f20`, `space`/`spacebar`, `enter`/`return`, `tab`,
`esc`/`escape`, `backspace`, `delete`/`del`, `insert`/`ins`, `home`, `end`,
`pageup`/`pgup`, `pagedown`/`pgdn`/`pagedn`, `left`, `right`, `up`, `down`, and the
punctuation keys `minus`, `equal`, `leftbracket`, `rightbracket`, `backslash`,
`semicolon`, `quote`, `comma`, `period`, `slash`, `grave` (with the obvious
symbol aliases: `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `` ` ``).

Platform gaps, all of them the OS's and not ours:

- `insert` does not exist on macOS. The position a PC keyboard labels Insert is
  Help on an Apple Extended Keyboard and absent from every other Apple keyboard,
  so an `insert` binding is refused there rather than aimed at a key you do not
  have.
- Linux accepts other X11 keysym names beyond this list (`bracketleft`,
  `eacute`, `yen`, ...), because unknown names are passed straight to
  `XStringToKeysym`. Only the **lowercase** half of that namespace is reachable,
  since the whole keyspec is lower-cased first - `Menu`, `Print` and
  `Scroll_Lock` do not resolve. None of them resolve on the other two platforms.
- `f21`-`f24` are Windows and Linux; `f25`-`f35` are Linux only.

The same spelling means the same key on all three platforms. That was not true
before #563: `ctrl+left` and `ctrl+f13` were accepted on Windows and refused on
Linux and macOS, `ctrl+tab` was accepted on Windows and macOS and refused on
Linux, and `command+k` was accepted on macOS and Windows and refused on Linux.
All three Linux refusals were the same cause - `XStringToKeysym` is
case-sensitive and the keyspec had already been lower-cased.

### What a key NAME addresses is not the same on every platform

This matters on a non-US keyboard layout, and it cannot be fixed by naming keys
differently - it is what the three OS APIs take:

- **macOS** takes a *hardware key code*. `k` means **the physical position of K
  on a US-ANSI keyboard**. On AZERTY that position is labelled `k` as well, but
  `q` means the position labelled `a`, and `a` means the position labelled `q`.
- **Windows** takes a *virtual-key code*, which the active layout produces. `k`
  means **the key that types `k` in your layout**.
- **Linux/X11** resolves a keysym through `XKeysymToKeycode` against the active
  layout, so `k` also means **the key that types `k` in your layout**.

So a letter-based binding can land on a different physical key on macOS than on
the other two for the same user. `space`, `tab`, `enter`, the arrows and
`f1`-`f20` sit in the same physical place in every layout and do not have this
problem, which is why the shipped summon default is on Space.

## macOS cannot consume the key

This is the part of #563 that is not a bad key choice but a structural
difference, and it is worth understanding before picking a binding.

| platform | mechanism | consumes the keystroke? | when the combination is already taken |
|---|---|---|---|
| Windows | `RegisterHotKey` | yes, exclusively | registration **fails**, and the sidecar log says so |
| Linux/X11 | `XGrabKey` | yes, while the grab holds | the grab is refused, and the sidecar log says so |
| macOS | `NSEvent addGlobalMonitorForEventsMatchingMask` | **no** | nothing happens; both actions fire |

`addGlobalMonitorForEventsMatchingMask` is a passive observer - its handler
returns `void` and there is no way to swallow the event. So on macOS the pebble
hotkey fires **in addition to** whatever the OS or the focused app does with the
same keystroke, and a clash produces no error at all. `ctrl+space`, the old
default, both switched input source and summoned the pebble; `ctrl+k` both
deleted to end of line in any text field and opened the palette.

### The app-level cost, and which platform actually pays it

Both defaults are free in all three stock *system* shortcut namespaces, which is
why they were chosen. Neither is free of **application** bindings, and because
the three platforms grab keys differently the consequence is different on each -
in the opposite direction to everything else on this page, so it is worth
reading carefully.

**On Windows and Linux you lose those app shortcuts.** `RegisterHotKey` and
`XGrabKey` take the combination exclusively, so while the sidecar is running the
focused application never sees it:

| binding | what stops working |
|---|---|
| `Ctrl+Shift+K` | the Web Console in Firefox; delete-line in VS Code |
| `Ctrl+Shift+Space` | parameter hints in VS Code; a non-breaking space in Word |

That is a real cost, and it is silent in the worst way: the app stops responding
to a shortcut its own menus still advertise. If you use any of them, change the
binding.

**On macOS those two combinations happen to be clean at the app level too**,
because those apps use Command on the Mac: Firefox's Web Console is
`Cmd+Opt+K`, VS Code's delete-line is `Cmd+Shift+K`, its parameter hints are
`Cmd+Shift+Space`, and Word for Mac inserts a non-breaking space with
`Option+Space` (`Ctrl+Shift+Space` does not do it there at all). So the one
platform that *cannot* consume a keystroke is, for this particular pair, the one
with nothing to double-fire against.

The asymmetry still matters the moment you choose your own binding, and it is
the whole subject of #563: on macOS a combination that is already taken gives
you both actions and no error at all, while on Windows and Linux it gives you a
loud registration failure. Whichever platform you are on,
`pebble.summon_hotkey` / `pebble.palette_hotkey` is the answer.

Consequences for choosing a macOS binding at all:

- avoid anything the system binds, because you will get both;
- avoid anything that *inserts a character*: every `Control+<letter>` in the
  Emacs-style set honoured by `NSTextView` (Ctrl+A/B/D/E/F/H/K/L/N/O/P/T/V/Y), and
  every `Option+<key>` that is a dead key or a special character (`Option+Space`
  is a non-breaking space);
- F13 and F16-F19 are unbound on stock macOS and are the cleanest choice
  available - but no current Apple keyboard has them, so they are only useful
  with an external full-size keyboard. F14 and F15 are **not** free: stock macOS
  binds them to decrease/increase display brightness.

### A note on the Linux row

`XGrabKey` is issued four times, for the plain modifier combination and for its
`LockMask` / `Mod2Mask` (Caps Lock / Num Lock) variants, so the hotkey works
whatever the lock state. A conflicting client may hold only some of those, which
would leave a hotkey that works in some lock states and not others - harder to
diagnose than one that is simply dead.

So the four grabs are **all-or-nothing**: if any variant is refused, the ones
that were granted are released again and the whole registration fails with a
message naming which variants clashed. A partial grab is never kept. The
alternative - keep what the server gave us and warn - was rejected because an
intermittent, lock-state-dependent hotkey is the same silent failure one layer
down, and because holding passive grabs we have just reported as unregistered
would sit on those combinations for every other client while doing nothing with
them.

Detecting the refusal at all takes a round trip. `XGrabKey` is asynchronous and
has no useful return value; a refusal arrives later as a `BadAccess` error
event. The sidecar therefore installs an X error handler that **records**
rather than ignores, and forces the round trip with `XSync` after each variant.
Until #574 that handler discarded everything it caught and the registration was
reported as successful either way, so a taken combination was announced as
`registered` and then never fired. The no-crash reason the handler existed in
the first place is still honoured - XLib's default handler calls `exit(1)` - but
it no longer costs the diagnosis.

One consequence worth knowing: `pebble.summon_hotkey` and
`pebble.palette_hotkey` open separate X connections, so they are separate X
clients. Setting them to the **same** keyspec now fails the second one with
"already held", where it used to be silently accepted and dead. That is the
same thing Windows has always done with a duplicate `RegisterHotKey`.

`XGrabKey` also only reaches X11 and XWayland clients. Under a **native Wayland**
session a global grab needs the compositor's own shortcuts protocol, which the
sidecar does not speak, so the pebble hotkeys do not work there at all.

## macOS needs Accessibility, and says so now

A global key-down monitor only fires when the process is trusted for
Accessibility. Before #563 the monitor *installed* successfully without it and
then never fired, while the log said `summon hotkey "ctrl+space" registered` -
the worst possible message for someone trying to work out why their hotkey is
dead.

The sidecar now probes `AXIsProcessTrusted()` at registration (a probe, never a
prompt - the onboarding wizard owns the prompt) and the log line says the hotkey
will not fire until Jarvis is granted in System Settings -> Privacy & Security ->
Accessibility. Grant it and relaunch the sidecar; a monitor installed while
untrusted does not start working on its own.

The probe can also be wrong the other way: macOS keeps a stale Accessibility
record when an app is moved or re-signed, so `AXIsProcessTrusted()` can answer
yes for a monitor that will never fire. Nothing detects that - a passive
monitor gives no delivery feedback at all - so the ABSENCE of the caveat below
is not proof that the hotkey works. If a hotkey is dead and the log says
nothing, remove Jarvis from the Accessibility list and add it back.

The monitor is still installed when the probe says no. A machine where the
monitor works but `AXIsProcessTrusted()` reports false - Input Monitoring granted
instead of Accessibility, for instance - must still get its hotkey, so this is a
caveat on a successful registration and not a refusal to register.

## Exact modifier matching (macOS)

Before #563 the macOS handler tested `(got & want) == want`, which matches any
keystroke that *includes* the wanted modifiers. `ctrl+space` therefore also fired
on Ctrl+Cmd+Space (Character Viewer), Ctrl+Shift+Space and Ctrl+Option+Space. It
is now an exact match on the four intentional modifiers (Shift, Control, Option,
Command).

**This is a behaviour change.** If you have been holding an extra modifier out of
habit - Ctrl+Shift+Space for a `ctrl+space` binding, say - it will stop summoning
the pebble. Press exactly what is configured, or configure exactly what you
press.

Caps Lock, `fn`/Function, the numeric-pad flag and the device-dependent
left-versus-right modifier bits are deliberately *not* part of the comparison:
macOS sets the Function flag for F-keys and arrows and the numeric-pad flag for
arrows, so including them would make an `f13` or `up` binding impossible to
trigger, and Caps Lock being on would silently disable every hotkey. The
comparison rule lives in `darwinHotkeyMatches` in `sidecar/hotkeys_keyspec.go`,
which carries no build tag and is table-tested on Linux; the `NSEvent` block is
handed both the mask and the wanted flags from Go so the two cannot disagree.

Windows gets exact matching for free from `RegisterHotKey`; Linux's `XGrabKey`
grabs the exact modifier combination (plus the lock variants, on purpose).
Neither changes here.

The monitor also ignores OS auto-repeat (`[e isARepeat]`), which is what
Windows gets from `MOD_NOREPEAT`. Holding the summon key used to fire it about
thirty times a second, and every fire put an event on the wire to the brain
before the microphone's in-flight guard could stop it.

## Known gaps

Two things this change deliberately did not fix, recorded so the next person
does not have to rediscover them:

- **`Spawn` and `Close` are guarded by an atomic latch that covers the entry
  and not the body**, in all three `pebble_overlay_*.go`. A `pebble.close`
  overlapping a `pebble.spawn` can therefore skip the hotkey teardown and leave
  a global key monitor installed that nothing can remove for the life of the
  process. The daemon is the only caller and it awaits the close before
  spawning, so the race is not reachable today - the `await` in
  `src/daemon/index.ts` is load-bearing and says so. The real fix is a mutex
  held across the whole of `Spawn` and `Close`, which means editing three
  overlay files that cannot be compiled outside their own platforms.
- **`addGlobalMonitorForEventsMatchingMask:` and `removeMonitor:` are called
  from an RPC goroutine**, while the rest of `pebble_overlay_darwin.go`
  marshals AppKit work to the main queue. Wrapping both in
  `dispatch_sync(dispatch_get_main_queue(), ...)` would match the file's own
  convention and remove the question of whether `removeMonitor:` can race a
  block mid-invocation; it also risks a deadlock if `stop()` is ever reached
  from the main thread, and neither the problem nor the fix can be observed
  off a Mac.

## Alternatives considered on macOS, and why they are not here

### `CopySymbolicHotKeys` collision detection

Asking macOS for its reserved symbolic hotkeys at registration would restore the
loud failure Windows gives, and it is the biggest gap still open on macOS. It is
not in #563 because:

- it is Carbon (`HIToolbox`), so a new `-framework Carbon` link plus CFDictionary
  unwrapping in a file that cannot be compiled or run outside a Mac - exactly the
  shape of change that should not ship unverified;
- its modifier field is a Carbon mask (`cmdKey` 0x0100, `shiftKey` 0x0200,
  `optionKey` 0x0800, `controlKey` 0x1000), not the `NSEventModifierFlags` this
  code already uses, so it needs a second modifier table and gives a key-mapping
  bug a second place to live;
- it only knows *system symbolic* hotkeys. It would not have caught `ctrl+k`,
  which is an `NSTextView` key binding, nor another launcher sitting on the same
  combination, nor the `Ctrl+Shift+K` devtools clash described above - so it would
  have caught about half of what #563 reports.

The half that carries most of the value - a known-clash list checked in pure Go -
needs no Carbon and is a good follow-up.

### `RegisterEventHotKey` (Carbon)

This is the API that actually *reserves* a combination on macOS: it consumes the
keystroke and it needs no Accessibility permission. It would end the double-fire
outright, including the `Ctrl+Shift+K` devtools case above, which a passive
monitor cannot do anything about - that is the strongest argument for it.

Two things it does *not* do, which are worth being accurate about:

- `eventHotKeyExistsErr` only reports a conflict with another **Carbon hot key
  registration**. Registering a system symbolic hotkey such as Cmd+Space
  succeeds and then simply never fires - the system wins - and a clash with an
  app using an `NSEvent` monitor or a `CGEventTap` is not detected either. So it
  narrows the silent-clash problem rather than closing it.
- It does not need a second event loop. `InstallEventHandler` on
  `GetApplicationEventTarget` dispatches from the ordinary main-thread
  `CFRunLoop` that AppKit already runs.

It is still a different architecture rather than a patch - a Carbon event handler
for `kEventHotKeyPressed`, an `EventHotKeyID` registry, `UnregisterEventHotKey`
teardown - and it replaces `hotkeys_darwin.go` instead of editing it, none of
which can be compiled off a Mac. It deserves its own issue, reusing the keyspec
layer added here (which already produces the hardware key code Carbon wants) and
keeping the `NSEvent` monitor as the fallback for a combination Carbon refuses.

### A `CGEventTap`

Strictly worse here. It needs Accessibility (or Input Monitoring) - the
permission we would like to stop depending on - it observes every keystroke on
the machine, which is a real cost for a product that already has an
awareness/OCR trust story to defend, and the system disables a tap whose callback
is slow (`kCGEventTapDisabledByTimeout`).

### Layout-aware key names on macOS

`TISCopyCurrentKeyboardLayoutInputSource` + `UCKeyTranslate` could map a
character to the key code that types it in the active layout, removing the
AZERTY/QWERTZ surprise described above. Same verdict for the same reason: Carbon
and uncompilable off a Mac. It is also an argument for preferring `space` or an
F-key in a default, which has no layout question at all.
