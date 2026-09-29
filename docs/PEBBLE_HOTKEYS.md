# Pebble global hotkeys

Two global hotkeys reach the pebble:

- **summon** - toggles listening and shows the bubble (the same thing a click on
  the disc does).
- **palette** - opens the fuzzy room picker at the cursor.

Both are configurable, and both are registered by the *sidecar*, on the machine
with the keyboard. The daemon only decides which keyspec to ask for.

```yaml
# ~/.jarvis/config.yaml
pebble:
  summon_hotkey: "ctrl+shift+space"   # syntax example, not the shipped default
  palette_hotkey: "ctrl+shift+k"
```

The shipped defaults live in one place,
`PEBBLE_DEFAULT_SUMMON_HOTKEY` / `PEBBLE_DEFAULT_PALETTE_HOTKEY` in
`src/config/pebble-hotkeys.ts`, and are the same on macOS, Windows and Linux.
The resolution path is per-platform capable (it is handed the connecting
sidecar's OS) so a future platform-specific default needs a table entry and no
new plumbing, but nothing ships with three different bindings today.

Set either to `""`, `none` or `off` to register no global hotkey at all. On
macOS that is a reasonable thing to want: see "macOS cannot consume the key".

`pebble:` is a SYSTEM section - it is read from `config.yaml` and is not one of
the `USER_OWNED_SECTIONS` that the dashboard owns, so editing the file is how
you change it, and a daemon restart applies it (the hotkey is registered at
`pebble.spawn`, which happens when a sidecar connects).

A keyspec that is not a hotkey at all (`summon_hotkey: 3`,
`summon_hotkey: "ctrl+"`, `summon_hotkey: "hyper+k"`) is reported at startup
with the reason and the built-in default is used instead. It is never silently
swallowed.

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

The same spelling means the same key on all three platforms. That was not true
before #563: `ctrl+left` and `ctrl+f13` were accepted on Windows and rejected on
Linux and macOS, and `command+k` was accepted on macOS and Windows and rejected
on Linux.

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
problem, which is a reason to prefer them for a default that ships to everybody.

## macOS cannot consume the key

This is the part of #563 that is not a bad key choice but a structural
difference, and it is worth understanding before picking a binding.

| platform | mechanism | consumes the keystroke? | when the combination is already taken |
|---|---|---|---|
| Windows | `RegisterHotKey` | yes, exclusively | registration **fails**, and the sidecar log says so |
| Linux/X11 | `XGrabKey` | yes, while the grab holds | grab is refused; the sidecar currently reports success anyway and the hotkey is simply dead |
| macOS | `NSEvent addGlobalMonitorForEventsMatchingMask` | **no** | nothing happens; both actions fire |

`addGlobalMonitorForEventsMatchingMask` is a passive observer - its handler
returns `void` and there is no way to swallow the event. So on macOS the pebble
hotkey fires **in addition to** whatever the OS or the focused app does with the
same keystroke, and a clash produces no error at all. `ctrl+space`, the old
default, both switched input source and summoned the pebble; `ctrl+k` both
deleted to end of line in any text field and opened the palette.

Consequences for choosing a macOS binding:

- avoid anything the system binds, because you will get both;
- avoid anything that *inserts a character*: every `Control+<letter>` in the
  Emacs-style set honoured by `NSTextView`, and every `Option+<key>` that is a
  dead key or a special character (`Option+Space` is a non-breaking space);
- app-level clashes cannot be avoided in general, which is why the binding is
  configurable and why `""` is a supported value.

## macOS needs Accessibility, and says so now

A global key-down monitor only fires when the process is trusted for
Accessibility. Before #563 the monitor *installed* successfully without it and
then never fired, while the log said `summon hotkey "ctrl+space" registered` -
the worst possible message for someone trying to work out why their hotkey is
dead.

The sidecar now probes `AXIsProcessTrusted()` at registration (a probe, not a
prompt) and the log line says the hotkey will not fire until Jarvis is granted
in System Settings -> Privacy & Security -> Accessibility. Grant it and relaunch
the sidecar; a monitor installed while untrusted does not start working on its
own.

## Exact modifier matching (macOS)

Before #563 the macOS handler tested `(got & want) == want`, which matches any
keystroke that *includes* the wanted modifiers. `ctrl+space` therefore also
fired on Ctrl+Cmd+Space (Character Viewer), Ctrl+Shift+Space and
Ctrl+Option+Space. It is now an exact match on the four intentional modifiers
(Shift, Control, Option, Command).

**This is a behaviour change.** If you have been holding an extra modifier out
of habit - Ctrl+Shift+Space for a `ctrl+space` binding, say - it will stop
summoning the pebble. Press exactly what is configured, or configure exactly
what you press.

Caps Lock, `fn`/Function and the numeric-pad flag are deliberately *not* part of
the comparison: macOS sets the Function flag for F-keys and arrows and the
numeric-pad flag for arrows, so including them would make an `f13` or `up`
binding impossible to trigger, and Caps Lock being on would silently disable
every hotkey.

Windows gets exact matching for free from `RegisterHotKey`; Linux's `XGrabKey`
grabs the exact modifier combination (plus the Lock/NumLock variants, on
purpose, so the lock state does not matter). Neither changes here.

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
  combination - so it would have caught about half of what #563 reports.

The half that carries most of the value - a known-clash list checked in pure Go -
needs no Carbon and is a good follow-up.

### `RegisterEventHotKey` (Carbon)

This is the API that actually *reserves* a combination on macOS: it consumes the
keystroke, it fails with `eventHotKeyExistsErr` when the combination is taken,
and it needs no Accessibility permission. It would close the double-fire, the
silent clash and the permission problem in one move.

It is also a different architecture rather than a patch - a Carbon event handler
on `GetApplicationEventTarget` for `kEventHotKeyPressed`, an `EventHotKeyID`
registry, `UnregisterEventHotKey` teardown, and a main-thread Carbon event loop
that has to coexist with the AppKit run loop the pebble already owns. It replaces
`hotkeys_darwin.go` instead of editing it, and none of it can be compiled off a
Mac. It deserves its own issue, reusing the keyspec layer added here (which
already produces the hardware key code Carbon wants) and keeping the `NSEvent`
monitor as the fallback for a combination Carbon refuses.

### A `CGEventTap`

Strictly worse here. It needs Accessibility (or Input Monitoring) - the
permission we would like to stop depending on - it observes every keystroke on
the machine, which is a real cost for a product that already has an
awareness/OCR trust story to defend, and the system disables a tap whose callback
is slow.

### Layout-aware key names on macOS

`TISCopyCurrentKeyboardLayoutInputSource` + `UCKeyTranslate` could map a
character to the key code that types it in the active layout, removing the
AZERTY/QWERTZ surprise described above. Same verdict for the same reason: Carbon
and uncompilable off a Mac. It is also an argument for preferring `space` or an
F-key in a default, which has no layout question at all.
