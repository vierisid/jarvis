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
and gets the default back. Use `""`, `none` or `off` to mean off.

> On **Windows** only, `palette_hotkey: ""` also switches off the Ctrl+middle-click
> palette trigger, because the overlay gates its mouse hook on the same value
> (`pebble_overlay_windows.go`). That coupling predates #563 and is deliberate -
> it is how a caller opts out of the global mouse hook - but it means a Windows
> user who disables the palette hotkey loses the mouse gesture with it.

`pebble:` is a SYSTEM section: it is read from `config.yaml` and is not one of
the `USER_OWNED_SECTIONS` the dashboard owns, so editing the file is how you
change it. `loadConfig` deep-merges the file over the defaults and discards only
the listed user-owned sections, so an unlisted top-level section survives - the
same route the system-owned `tools:` section takes (see the note on
`daemon.log_file_path` in `src/config/types.ts`).

**When a change takes effect.** The keyspec is read at `pebble.spawn`, which the
daemon sends when a sidecar connects, so:

- Restarting the **sidecar** always applies it.
- Restarting the **daemon** applies it too: the daemon sends `pebble.close`
  before the first `pebble.spawn` it sends to each sidecar, so a sidecar that
  outlived the daemon drops its old overlay and its old hotkeys instead of
  keeping them. Without that, `Spawn` returns early on its idempotency latch,
  the new keyspec is discarded, and the sidecar answers `{"spawned": true}` - the
  user is told it worked and nothing changed.
- A later **reconnect** does not close anything (the daemon remembers what it
  last asked that sidecar for), so a network blip does not make the pebble blink.
- `SIGHUP` does **not** pick it up. `pebble:` is not one of the sections the
  daemon re-reads on a reload.

A keyspec that is not a hotkey at all (`summon_hotkey: 3`, `"ctrl+"`,
`"hyper+k"`) is logged as an error naming the key and the problem, and the
default is used instead. It is never silently swallowed. Note this is the
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
`pageup`/`pgup`, `pagedown`/`pgdn`, `left`, `right`, `up`, `down`, and the
punctuation keys `minus`, `equal`, `leftbracket`, `rightbracket`, `backslash`,
`semicolon`, `quote`, `comma`, `period`, `slash`, `grave` (with the obvious
symbol aliases: `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `` ` ``).

Platform gaps, all of them the OS's and not ours:

- `insert` does not exist on macOS. The position a PC keyboard labels Insert is
  Help on an Apple Extended Keyboard and absent from every other Apple keyboard,
  so an `insert` binding is refused there rather than aimed at a key you do not
  have.
- `f21`-`f24` work on Windows and Linux but not macOS, which has no key codes
  above F20.
- Linux accepts any X11 keysym name beyond this list (`bracketleft`, `eacute`,
  `yen`, ...), because unknown names are passed straight to `XStringToKeysym`.
  Those will not resolve on the other two.

The same spelling means the same key on all three platforms. That was not true
before #563: `ctrl+left`, `ctrl+f13` and `ctrl+tab` were accepted on Windows and
refused on Linux and macOS, and `command+k` was accepted on macOS and Windows and
refused on Linux.

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
| Linux/X11 | `XGrabKey` | yes, while the grab holds | the grab is refused and the sidecar reports success anyway, so the hotkey is silently dead |
| macOS | `NSEvent addGlobalMonitorForEventsMatchingMask` | **no** | nothing happens; both actions fire |

`addGlobalMonitorForEventsMatchingMask` is a passive observer - its handler
returns `void` and there is no way to swallow the event. So on macOS the pebble
hotkey fires **in addition to** whatever the OS or the focused app does with the
same keystroke, and a clash produces no error at all. `ctrl+space`, the old
default, both switched input source and summoned the pebble; `ctrl+k` both
deleted to end of line in any text field and opened the palette.

**This is why `Ctrl+Shift+K` is still worth knowing about.** Both defaults are
free in all three stock *system* shortcut namespaces, which is why they were
chosen - but `Ctrl+Shift+K` is an application binding in browsers and editors: it
opens the Web Console in Firefox and is bound in Chrome and VS Code. On macOS,
pressing it with a browser focused opens devtools **and** the palette, because
the monitor cannot consume the keystroke. `Ctrl+Shift+Space` has the same shape
of clash with Word and other Office apps, which insert a non-breaking space with
it, and with VS Code's parameter hints.

On Windows and Linux none of that happens: `RegisterHotKey` and `XGrabKey` take
the key exclusively, so the app never sees it. The app-level double-fire is a
macOS-only problem, and it is the same asymmetry the whole issue is about. If it
bothers you, change `pebble.palette_hotkey` - that is exactly what the setting is
for.

Consequences for choosing a macOS binding at all:

- avoid anything the system binds, because you will get both;
- avoid anything that *inserts a character*: every `Control+<letter>` in the
  Emacs-style set honoured by `NSTextView` (Ctrl+A/B/D/E/F/H/K/N/O/P/T/V/Y), and
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
leaves a hotkey that works in some lock states and not others - harder to
diagnose than one that is simply dead. The sidecar installs an X error handler
that swallows `BadAccess` and then reports the registration as successful either
way, so the log does not help; that is a known gap, not a decision.

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
