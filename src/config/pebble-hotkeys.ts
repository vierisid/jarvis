/**
 * One reading of `pebble.summon_hotkey` / `pebble.palette_hotkey`, shared by
 * every reader of them.
 *
 * Before #563 there was nothing to read: `src/daemon/index.ts` hardcoded
 * `ctrl+space` and `ctrl+k` for every platform, with no config key and no
 * branch, so a Mac user whose `Ctrl+Space` was taken by the system's
 * "select the previous input source" shortcut - which it is, by default,
 * whenever more than one input source exists - had no way to change it short of
 * editing the daemon and rebuilding.
 *
 * Shaped after `src/config/port.ts`: a four-state union so the caller cannot
 * confuse "not configured" with "configured to something unusable", which is
 * the `parsed?.pebble?.x` failure mode a review of #565 asked us to stop
 * writing. The POLICY differs from port.ts on purpose, and the difference is
 * worth stating out loud: `requirePort` throws, because a daemon that binds an
 * unexpected port is worse than one that does not start. A mistyped hotkey is
 * not in that class - it must not stop the daemon booting - so `invalid` is
 * reported loudly and the default is used.
 */

/**
 * The shipped defaults: ONE pair, the same on macOS, Windows and Linux.
 *
 * Both clear all three stock system shortcut namespaces, which is the bar a
 * uniform default has to meet. What is taken, and where:
 *   - `ctrl+space`  - macOS "select the previous input source"; IBus and fcitx
 *                     both default to it on Linux; Chinese/Japanese IMEs use it
 *                     on Windows.
 *   - `alt+space`   - the window system menu on Windows and in most Linux WMs,
 *                     a non-breaking space on macOS, and the default hotkey of
 *                     Raycast, Alfred and the ChatGPT desktop app.
 *   - `super+space` - Spotlight, the Windows language switch, and the GNOME
 *                     input-source switch. All three, independently.
 *   - `cmd+shift+space` - reserved by Apple; macOS 27 uses it for Siri.
 *   - `ctrl+alt+<key>`  - AltGr on European Windows and Linux layouts.
 *   - F13-F19       - genuinely unbound everywhere, and absent from essentially
 *                     every laptop keyboard, so free and unreachable at once.
 *
 * What is NOT clear of `ctrl+shift+k`: browsers and editors bind it at the
 * APPLICATION level (the Firefox Web Console, Chrome, VS Code's delete-line).
 * On macOS the pebble's monitor is passive and cannot consume the keystroke, so
 * with a browser focused it opens devtools AND the palette. On Windows and
 * Linux the key is taken exclusively and the app never sees it. That asymmetry
 * is #563 itself, it is documented in docs/PEBBLE_HOTKEYS.md and in
 * config.example.yaml, and the override below is the answer to it.
 */
export const PEBBLE_DEFAULT_SUMMON_HOTKEY = 'ctrl+shift+space';
export const PEBBLE_DEFAULT_PALETTE_HOTKEY = 'ctrl+shift+k';

/**
 * Per-platform overrides of the defaults above, keyed by the sidecar's reported
 * `runtime.GOOS` ("darwin" / "windows" / "linux").
 *
 * EMPTY ON PURPOSE. The defaults are uniform across the three platforms; this
 * table exists so that a future platform-specific default is one entry rather
 * than new plumbing, and so the resolver's signature already carries the OS.
 */
const PLATFORM_DEFAULT_OVERRIDES: Record<string, { summon?: string; palette?: string }> = {};

/**
 * Spellings that mean "register no global hotkey at all", compared after
 * trimming and lower-casing.
 *
 * Note that YAML keeps all three as strings under the 1.2 core schema the
 * repo's parser uses, so `off` does NOT become a boolean here. A bare
 * `summon_hotkey:` or `summon_hotkey: ~` is null, which is `absent` and gets
 * the default back - if you want it off, say so with one of these.
 */
const DISABLED_SPELLINGS = new Set(['', 'none', 'off']);

/**
 * The modifier names the sidecar's shared grammar accepts
 * (`modifierNames` in sidecar/hotkeys_keyspec.go). Kept in step with that map:
 * a name accepted here and not there would be reported by the daemon as fine
 * and then refused by the sidecar.
 */
const MODIFIER_NAMES = new Set([
  'ctrl', 'control',
  'shift',
  'alt', 'opt', 'option',
  'cmd', 'command', 'super', 'win', 'meta',
]);

/**
 * A sanity bound on the value. "ctrl+shift+space" is 16 characters; anything
 * near this is a mistake or an attack, and the sidecar's parser applies the
 * same limit (`maxKeyspecLen` in sidecar/hotkeys_keyspec.go).
 */
const MAX_KEYSPEC_LENGTH = 128;

/**
 * Keys that are safe to bind with NO modifier at all.
 *
 * A bare key is a real requirement - `f13` is the whole reason F-keys are
 * interesting - but a bare ORDINARY key is a footgun with teeth on macOS.
 * There the monitor is passive, so `summon_hotkey: "a"` does not break typing
 * the way an exclusive `RegisterHotKey`/`XGrabKey` grab would: the letter still
 * types perfectly, and the only symptom is the pebble waking up - and OPENING
 * THE MICROPHONE - on every press of `a` in every application. That is exactly
 * the silent-clash shape #563 is about, so it is refused here, where the
 * message can reach the user.
 */
const BARE_KEY_ALLOWED = /^f([1-9]|[12]\d|3[0-5])$/;

/** What one hotkey key says, once. */
export type HotkeySetting =
  /** Not set at all (missing, or YAML null): the caller applies the default. */
  | { kind: 'absent' }
  /** A syntactically usable keyspec, normalised to lower case and trimmed. */
  | { kind: 'valid'; keyspec: string }
  /** Explicitly turned off ("", "none", "off"): register no hotkey. */
  | { kind: 'disabled' }
  /**
   * Set to something that is not a keyspec. NOT the same as absent: a caller
   * that treats this as "nothing was configured" reports nothing and the user
   * never learns why their hotkey did not change. `problem` completes the
   * sentence "pebble.summon_hotkey ...".
   */
  | { kind: 'invalid'; problem: string };

/**
 * How a rejected value is named back to the user without reproducing it whole -
 * this string reaches the daemon log, and a `summon_hotkey` holding a megabyte
 * of text must not be printed in full. Mirrors `describeValue` in port.ts.
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 37 ? `${value.slice(0, 37)}...` : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return typeof value;
}

/**
 * Read a raw YAML value as a hotkey keyspec.
 *
 * Validates the SHAPE - a `+`-separated list whose last token is a key and
 * whose earlier tokens are all known modifiers - and deliberately does NOT
 * validate the key name. The three backends resolve key names against three
 * different tables (macOS hardware key codes, Win32 virtual keys, X11 keysyms),
 * Linux additionally accepts any keysym name `XStringToKeysym` knows, and the
 * daemon may be resolving for a platform it is not running on. Rejecting a name
 * here that the target platform accepts would be worse than letting the sidecar
 * report it: an unusable key name is logged by the sidecar as
 * `unsupported key "..."` at registration.
 */
export function readHotkeySetting(value: unknown): HotkeySetting {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value !== 'string') {
    return { kind: 'invalid', problem: `must be a hotkey like "ctrl+shift+space", got ${describeValue(value)}` };
  }

  if (value.length > MAX_KEYSPEC_LENGTH) {
    return { kind: 'invalid', problem: `is ${value.length} characters; the limit is ${MAX_KEYSPEC_LENGTH}` };
  }

  const text = value.trim().toLowerCase();
  if (DISABLED_SPELLINGS.has(text)) return { kind: 'disabled' };

  const parts = text.split('+').map((part) => part.trim());
  const key = parts[parts.length - 1] ?? '';
  if (key === '') {
    return { kind: 'invalid', problem: `names no key (${describeValue(value)})` };
  }
  if (/\s/.test(key)) {
    return { kind: 'invalid', problem: `has whitespace inside the key name (${describeValue(value)})` };
  }
  for (const modifier of parts.slice(0, -1)) {
    if (!MODIFIER_NAMES.has(modifier)) {
      return {
        kind: 'invalid',
        problem: `has an unknown modifier ${JSON.stringify(modifier)} (${describeValue(value)});`
          + ` the modifiers are ctrl, shift, alt and cmd`,
      };
    }
  }
  if (parts.length === 1 && !BARE_KEY_ALLOWED.test(key)) {
    return {
      kind: 'invalid',
      problem: `needs at least one modifier (ctrl, shift, alt or cmd) unless the key is an F-key,`
        + ` because a bare ${JSON.stringify(key)} would summon the pebble every time you typed it`,
    };
  }
  // Rebuilt from the trimmed tokens so "Ctrl + Shift + K" and "ctrl+shift+k"
  // reach the sidecar as the same string, which keeps the daemon's
  // "did this change since I last asked?" comparison honest.
  return { kind: 'valid', keyspec: parts.join('+') };
}

/** The `pebble:` section as it arrives from config.yaml. */
export type PebbleHotkeyConfig = {
  summon_hotkey?: unknown;
  palette_hotkey?: unknown;
};

export type PebbleHotkeyResolution = {
  /** The keyspec to send as `summon_hotkey`; "" means register no hotkey. */
  summon: string;
  /** The keyspec to send as `palette_hotkey`; "" means register no hotkey. */
  palette: string;
  /** One sentence per unusable value, for the caller to log. Empty when all is well. */
  problems: string[];
};

function resolveOne(
  key: 'summon_hotkey' | 'palette_hotkey',
  value: unknown,
  fallback: string,
  problems: string[],
): string {
  const setting = readHotkeySetting(value);
  switch (setting.kind) {
    case 'valid':
      return setting.keyspec;
    case 'disabled':
      return '';
    case 'absent':
      return fallback;
    case 'invalid':
      problems.push(`pebble.${key} ${setting.problem} -- using the default ${JSON.stringify(fallback)} instead`);
      return fallback;
  }
}

/**
 * Resolve both pebble hotkeys for one sidecar.
 *
 * `sidecarOS` is the CONNECTING SIDECAR's `runtime.GOOS`, not the daemon's
 * platform: a hosted brain runs on a Linux VPS while the machine with the
 * keyboard is someone's Mac, so `process.platform` would resolve for the wrong
 * computer. It can also be `"unknown"` (that is what the manager stores when a
 * sidecar does not report one) or undefined, which simply misses the override
 * table and lands on the uniform defaults - the right answer while the table is
 * empty, and a safe one afterwards.
 */
export function resolvePebbleHotkeys(
  pebble: PebbleHotkeyConfig | undefined,
  sidecarOS?: string,
): PebbleHotkeyResolution {
  const overrides = (sidecarOS && PLATFORM_DEFAULT_OVERRIDES[sidecarOS]) || {};
  const problems: string[] = [];
  const summon = resolveOne('summon_hotkey', pebble?.summon_hotkey, overrides.summon ?? PEBBLE_DEFAULT_SUMMON_HOTKEY, problems);
  let palette = resolveOne('palette_hotkey', pebble?.palette_hotkey, overrides.palette ?? PEBBLE_DEFAULT_PALETTE_HOTKEY, problems);

  // One keystroke cannot drive both callbacks. Windows would refuse the second
  // RegisterHotKey and say so; macOS installs two monitors quite happily, and
  // the press then starts a listening session AND opens the palette at once -
  // the silent-asymmetry shape #563 is about. Summon wins because it is the one
  // the pebble cannot do without; the palette is also reachable from the tray
  // and, on Windows, from Ctrl+middle-click.
  if (summon !== '' && summon === palette) {
    problems.push(
      `pebble.palette_hotkey is the same key as pebble.summon_hotkey (${JSON.stringify(summon)});`
      + ` one keystroke cannot do both, so the palette hotkey is not registered`,
    );
    palette = '';
  }

  return { summon, palette, problems };
}
