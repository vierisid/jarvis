import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import YAML from 'yaml';
import {
  PEBBLE_DEFAULT_PALETTE_HOTKEY,
  PEBBLE_DEFAULT_SUMMON_HOTKEY,
  MODIFIER_NAMES,
  pebbleHotkeyRequestKey,
  readHotkeySetting,
  resolvePebbleHotkeys,
  shouldCloseBeforeSpawn,
} from './pebble-hotkeys.ts';

describe('readHotkeySetting', () => {
  test('a keyspec is valid, normalised to lower case and trimmed', () => {
    expect(readHotkeySetting('ctrl+shift+space')).toEqual({ kind: 'valid', keyspec: 'ctrl+shift+space' });
    expect(readHotkeySetting('  Ctrl + Shift + K  ')).toEqual({ kind: 'valid', keyspec: 'ctrl+shift+k' });
    // A key with no modifier is legal: f13 is a perfectly good binding.
    expect(readHotkeySetting('f13')).toEqual({ kind: 'valid', keyspec: 'f13' });
  });

  test('the modifier vocabulary matches the sidecar grammar exactly', () => {
    // EXACT, in both directions. A name accepted in Go and refused here is
    // reported to the user as broken config for a hotkey that works; a name
    // accepted here and refused in Go is the reverse - the daemon says fine and
    // the sidecar refuses it in a log nobody reads. Kept in step with
    // `modifierNames` in sidecar/hotkeys_keyspec.go.
    const inGo = ['ctrl', 'control', 'shift', 'alt', 'opt', 'option', 'cmd', 'command', 'super', 'win', 'meta'];
    expect([...MODIFIER_NAMES].sort()).toEqual([...inGo].sort());
    for (const modifier of inGo) {
      expect(readHotkeySetting(`${modifier}+k`).kind).toBe('valid');
    }
    // Plausible names that are NOT modifiers, so the set cannot quietly grow.
    for (const notAModifier of ['fn', 'caps', 'hyper', 'mod4', 'ctl', 'altgr']) {
      expect(readHotkeySetting(`${notAModifier}+k`).kind).toBe('invalid');
    }
  });

  test('absent is not the same as disabled', () => {
    expect(readHotkeySetting(undefined)).toEqual({ kind: 'absent' });
    // YAML null: `summon_hotkey:` with nothing after it, and `summon_hotkey: ~`.
    expect(readHotkeySetting(null)).toEqual({ kind: 'absent' });

    for (const off of ['', '   ', 'none', 'off', 'None', 'OFF']) {
      expect(readHotkeySetting(off)).toEqual({ kind: 'disabled' });
    }
  });

  test('a value that is not a hotkey is invalid, never absent', () => {
    // The distinction this whole module exists for: a caller that folds these
    // into "not configured" reports nothing and the user never learns why
    // their hotkey did not change.
    for (const value of [3, true, ['ctrl', 'k'], { ctrl: true }, 'ctrl+', '+', 'hyper+a', 'ctrl+shift+']) {
      const setting = readHotkeySetting(value);
      expect(setting.kind).toBe('invalid');
      if (setting.kind === 'invalid') expect(setting.problem).toBeTruthy();
    }
  });

  test('the problem names the offending modifier and the value', () => {
    const setting = readHotkeySetting('hyper+a');
    expect(setting.kind).toBe('invalid');
    if (setting.kind !== 'invalid') return;
    expect(setting.problem).toContain('hyper');
    expect(setting.problem).toContain('"hyper+a"');
  });

  test('a huge value is clamped rather than reproduced in the log line', () => {
    const setting = readHotkeySetting(`ctrl+${'k'.repeat(5000)} oops`);
    expect(setting.kind).toBe('invalid');
    if (setting.kind !== 'invalid') return;
    expect(setting.problem.length).toBeLessThan(200);
  });

  test('a bare ordinary key is refused; a bare F-key is not', () => {
    // On macOS the monitor is passive, so `summon_hotkey: "a"` does not break
    // typing the way an exclusive grab would -- the letter still types, and the
    // pebble just opens the microphone every time you press it. Silent, which
    // is the shape of clash #563 exists to stop.
    for (const bare of ['a', 'space', 'return', '1', 'k', 'tab']) {
      const setting = readHotkeySetting(bare);
      expect(setting.kind).toBe('invalid');
      if (setting.kind === 'invalid') expect(setting.problem).toContain('at least one modifier');
    }
    // The case the allowance exists for.
    for (const fkey of ['f1', 'f13', 'f19', 'f35']) {
      expect(readHotkeySetting(fkey)).toEqual({ kind: 'valid', keyspec: fkey });
    }
    // Not F-keys, so still refused bare.
    for (const notAnFKey of ['f0', 'f36', 'f', 'f13x']) {
      expect(readHotkeySetting(notAnFKey).kind).toBe('invalid');
    }
    // A modifier makes any of them fine again.
    expect(readHotkeySetting('ctrl+shift+a').kind).toBe('valid');
  });

  test('a lone modifier gets its own message', () => {
    // The likeliest mistake of all, because the LAST token is always the key:
    // `summon_hotkey: ctrl` asks to bind Control itself.
    for (const lone of ['ctrl', 'shift', 'alt', 'cmd', 'super']) {
      const setting = readHotkeySetting(lone);
      expect(setting.kind).toBe('invalid');
      if (setting.kind === 'invalid') expect(setting.problem).toContain('no key after it');
    }
  });

  test('an absurdly long value is refused before it is parsed', () => {
    const setting = readHotkeySetting(`ctrl+${'a'.repeat(200)}`);
    expect(setting.kind).toBe('invalid');
    if (setting.kind === 'invalid') expect(setting.problem).toContain('limit is 128');
  });

  test('key names are NOT validated here', () => {
    // On purpose: the three backends resolve names against three different
    // tables, Linux additionally takes any keysym XStringToKeysym knows, and
    // the daemon may be resolving for a platform it is not running on.
    // The sidecar reports an unusable name at registration.
    expect(readHotkeySetting('ctrl+eacute').kind).toBe('valid');
    expect(readHotkeySetting('ctrl+f24').kind).toBe('valid');
  });
});

describe('the YAML spellings behave as documented', () => {
  // The disable sentinels only work if YAML leaves them as strings. Checked
  // against the parser the loader actually uses rather than assumed.
  test('off / none / no stay strings, and a bare key is null', () => {
    const parsed = YAML.parseDocument([
      'pebble:',
      '  a: off',
      '  b: none',
      '  c: no',
      '  d:',
      '  e: ~',
      '  f: ""',
    ].join('\n'), { merge: true }).toJS().pebble;

    expect(typeof parsed.a).toBe('string');
    expect(typeof parsed.b).toBe('string');
    expect(typeof parsed.c).toBe('string');
    expect(parsed.d).toBeNull();
    expect(parsed.e).toBeNull();
    expect(parsed.f).toBe('');

    expect(readHotkeySetting(parsed.a).kind).toBe('disabled');
    expect(readHotkeySetting(parsed.b).kind).toBe('disabled');
    expect(readHotkeySetting(parsed.f).kind).toBe('disabled');
    // `no` is a string but not one of the disable spellings, so it is read as
    // a key name -- and refused, because it carries no modifier. Pinned so the
    // asymmetry with `none` and `off` is deliberate rather than discovered,
    // and so someone who writes `no` gets told rather than getting a hotkey
    // bound to a key called "no" that the sidecar would then reject in a log
    // nobody reads.
    expect(readHotkeySetting(parsed.c).kind).toBe('invalid');
    // A bare key is "use the default", NOT "off" -- documented in
    // docs/PEBBLE_HOTKEYS.md because it is the obvious way to try to disable one.
    expect(readHotkeySetting(parsed.d).kind).toBe('absent');
    expect(readHotkeySetting(parsed.e).kind).toBe('absent');
  });
});

describe('resolvePebbleHotkeys', () => {
  test('the shipped defaults are the same on every platform', () => {
    // The owner's requirement: ONE pair, not three. If a platform override is
    // ever added, this test is the one that should fail first and be updated
    // on purpose.
    for (const os of ['darwin', 'windows', 'linux', 'unknown', undefined]) {
      expect(resolvePebbleHotkeys(undefined, os)).toEqual({
        summon: PEBBLE_DEFAULT_SUMMON_HOTKEY,
        palette: PEBBLE_DEFAULT_PALETTE_HOTKEY,
        problems: [],
      });
    }
  });

  test('the defaults are the pair the owner confirmed', () => {
    // Pinned by value so changing them is a deliberate edit in two places
    // rather than a drift. Both clear all three stock system shortcut
    // namespaces; see the comment on the constants for what does not.
    expect(PEBBLE_DEFAULT_SUMMON_HOTKEY).toBe('ctrl+shift+space');
    expect(PEBBLE_DEFAULT_PALETTE_HOTKEY).toBe('ctrl+shift+k');
  });

  test('an empty pebble section is the same as no pebble section', () => {
    expect(resolvePebbleHotkeys({}, 'darwin')).toEqual(resolvePebbleHotkeys(undefined, 'darwin'));
  });

  test('a configured keyspec wins on every platform', () => {
    for (const os of ['darwin', 'windows', 'linux']) {
      expect(resolvePebbleHotkeys({ summon_hotkey: 'alt+f13', palette_hotkey: 'cmd+shift+p' }, os)).toEqual({
        summon: 'alt+f13',
        palette: 'cmd+shift+p',
        problems: [],
      });
    }
  });

  test('each key is resolved independently', () => {
    const resolved = resolvePebbleHotkeys({ summon_hotkey: 'alt+f13' }, 'darwin');
    expect(resolved.summon).toBe('alt+f13');
    expect(resolved.palette).toBe(PEBBLE_DEFAULT_PALETTE_HOTKEY);
    expect(resolved.problems).toEqual([]);
  });

  test('disabled resolves to "", which registers no hotkey', () => {
    // "" is what PebbleSpec already reads as "no hotkey" -- every overlay gates
    // its registration on `!= ""` -- so this needs no wire change.
    expect(resolvePebbleHotkeys({ summon_hotkey: 'off', palette_hotkey: '' }, 'darwin')).toEqual({
      summon: '',
      palette: '',
      problems: [],
    });
  });

  test('an unusable value falls back to the default and SAYS SO', () => {
    // The failure this module exists to prevent is the silent one: falling
    // back with nothing reported is indistinguishable from the config having
    // been ignored entirely.
    const resolved = resolvePebbleHotkeys({ summon_hotkey: 'hyper+a', palette_hotkey: 42 }, 'darwin');
    expect(resolved.summon).toBe(PEBBLE_DEFAULT_SUMMON_HOTKEY);
    expect(resolved.palette).toBe(PEBBLE_DEFAULT_PALETTE_HOTKEY);
    expect(resolved.problems).toHaveLength(2);
    expect(resolved.problems[0]).toContain('pebble.summon_hotkey');
    expect(resolved.problems[0]).toContain('hyper');
    expect(resolved.problems[0]).toContain(PEBBLE_DEFAULT_SUMMON_HOTKEY);
    expect(resolved.problems[1]).toContain('pebble.palette_hotkey');
  });

  test('a good value next to a bad one still applies', () => {
    const resolved = resolvePebbleHotkeys({ summon_hotkey: 'ctrl+alt+j', palette_hotkey: 'ctrl+' }, 'linux');
    expect(resolved.summon).toBe('ctrl+alt+j');
    expect(resolved.palette).toBe(PEBBLE_DEFAULT_PALETTE_HOTKEY);
    expect(resolved.problems).toHaveLength(1);
  });

  test('one key cannot drive both hotkeys', () => {
    // Windows refuses the second RegisterHotKey and says so; macOS installs
    // two monitors and fires both callbacks on one press. Caught here so the
    // behaviour is the same everywhere: summon wins, palette is dropped, and
    // the user is told.
    const resolved = resolvePebbleHotkeys(
      { summon_hotkey: 'ctrl+shift+j', palette_hotkey: 'Ctrl + Shift + J' },
      'darwin',
    );
    expect(resolved.summon).toBe('ctrl+shift+j');
    expect(resolved.palette).toBe('');
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toContain('same key');
  });

  test('both disabled is not treated as a collision', () => {
    // "" === "" must not trip the duplicate check, or turning both off would
    // report a spurious problem.
    expect(resolvePebbleHotkeys({ summon_hotkey: 'off', palette_hotkey: 'off' }, 'linux')).toEqual({
      summon: '',
      palette: '',
      problems: [],
    });
  });

  test('the shipped defaults are not a collision', () => {
    expect(resolvePebbleHotkeys(undefined, 'darwin').problems).toEqual([]);
    expect(PEBBLE_DEFAULT_SUMMON_HOTKEY).not.toBe(PEBBLE_DEFAULT_PALETTE_HOTKEY);
  });

  test('the resolved value is stable for the same input', () => {
    // The daemon compares this string against what it last asked a sidecar for
    // to decide whether to close the old overlay; an unstable normalisation
    // would make it close and respawn the pebble on every reconnect.
    const a = resolvePebbleHotkeys({ summon_hotkey: 'Ctrl + Shift + Space' }, 'darwin');
    const b = resolvePebbleHotkeys({ summon_hotkey: 'ctrl+shift+space' }, 'darwin');
    expect(a.summon).toBe(b.summon);
  });
});

describe('the pebble section survives loadConfig', () => {
  // The whole design rests on this: `pebble:` is SYSTEM-owned, so it must NOT
  // be discarded the way the USER_OWNED_SECTIONS are. loadConfig deep-merges
  // the file over DEFAULT_CONFIG and strips only the listed sections, but that
  // is a property of code that can change, so it is pinned here rather than
  // assumed.
  let dir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    dir = await mkdtemp(join(tmpdir(), 'jarvis-pebble-hotkeys-'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  async function loadWith(lines: string[]) {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { loadConfig } = await import('./loader.ts');
    const path = join(dir, 'config.yaml');
    await writeFile(path, lines.join('\n'));
    return loadConfig(path);
  }

  test('a configured pair reaches the resolver', async () => {
    const config = await loadWith([
      'daemon:',
      '  port: 3142',
      'pebble:',
      '  summon_hotkey: "alt+f13"',
      '  palette_hotkey: "off"',
      '',
    ]);

    expect(config.pebble).toEqual({ summon_hotkey: 'alt+f13', palette_hotkey: 'off' });
    expect(resolvePebbleHotkeys(config.pebble, 'darwin')).toEqual({
      summon: 'alt+f13',
      palette: '',
      problems: [],
    });
  });

  test('pebble is not a user-owned section', async () => {
    const { USER_OWNED_SECTIONS } = await import('./types.ts');
    // If it is ever added there, config.yaml stops being authoritative and the
    // test above starts failing for a reason nobody would guess from it.
    expect(USER_OWNED_SECTIONS as readonly string[]).not.toContain('pebble');
  });

  test('no pebble section leaves it undefined rather than defaulted in the config object', async () => {
    // The daemon.drain_deadline_ms precedent: absent must stay distinguishable
    // from "set to the default", so there is no DEFAULT_CONFIG entry and the
    // default is applied where the value is consumed.
    const config = await loadWith(['daemon:', '  port: 3142', '']);
    expect(config.pebble).toBeUndefined();
    expect(resolvePebbleHotkeys(config.pebble, 'linux').summon).toBe(PEBBLE_DEFAULT_SUMMON_HOTKEY);
  });

  test('an unusable value survives the load so the resolver can report it', async () => {
    // Rather than being coerced or dropped by the loader, which would leave
    // the resolver unable to tell it apart from "not set".
    const config = await loadWith([
      'daemon:',
      '  port: 3142',
      'pebble:',
      '  summon_hotkey: 42',
      '',
    ]);
    const resolved = resolvePebbleHotkeys(config.pebble, 'windows');
    expect(resolved.summon).toBe(PEBBLE_DEFAULT_SUMMON_HOTKEY);
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toContain('pebble.summon_hotkey');
  });
});

describe('an unusable pebble section is reported, not ignored', () => {
  // The hole the phase-4 review found: reading `pebble?.summon_hotkey` off a
  // string or a list yields undefined, which reads as "absent" and answers with
  // the default and NO problem. Silence is the one outcome this module exists
  // to prevent, and a misspelled KEY NAME is the likeliest mistake of all --
  // the value can be copy-pasted from config.example.yaml, the name is typed.
  test('a section that is not a mapping is reported', () => {
    for (const notAMapping of ['ctrl+k', ['ctrl+k'], 42, true]) {
      const resolved = resolvePebbleHotkeys(notAMapping as never, 'darwin');
      expect(resolved.summon).toBe(PEBBLE_DEFAULT_SUMMON_HOTKEY);
      expect(resolved.palette).toBe(PEBBLE_DEFAULT_PALETTE_HOTKEY);
      expect(resolved.problems).toHaveLength(1);
      expect(resolved.problems[0]).toContain('must be a mapping');
    }
  });

  test('a misspelled key name is reported and names the two real settings', () => {
    const resolved = resolvePebbleHotkeys({ summon_hotkeys: 'alt+f13' } as never, 'darwin');
    expect(resolved.summon).toBe(PEBBLE_DEFAULT_SUMMON_HOTKEY);
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toContain('summon_hotkeys');
    expect(resolved.problems[0]).toContain('summon_hotkey and palette_hotkey');
  });

  test('a nested shape gets the same treatment', () => {
    const resolved = resolvePebbleHotkeys({ hotkeys: { summon: 'alt+f13' } } as never, 'linux');
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toContain('pebble.hotkeys');
  });

  test('an unknown key alongside a good one reports the typo and keeps the good one', () => {
    const resolved = resolvePebbleHotkeys(
      { summon_hotkey: 'alt+f13', palette_hotkeys: 'alt+f14' } as never,
      'windows',
    );
    expect(resolved.summon).toBe('alt+f13');
    expect(resolved.palette).toBe(PEBBLE_DEFAULT_PALETTE_HOTKEY);
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toContain('palette_hotkeys');
  });

  test('null and an empty mapping stay silent', () => {
    // Neither is a mistake: `pebble:` with nothing under it is null, and an
    // empty mapping configures nothing.
    for (const quiet of [undefined, null, {}]) {
      expect(resolvePebbleHotkeys(quiet as never, 'darwin').problems).toEqual([]);
    }
  });
});

describe('the daemon decisions the call site used to inline', () => {
  test('the request key round-trips both hotkeys', () => {
    expect(pebbleHotkeyRequestKey({ summon: 'ctrl+shift+space', palette: 'ctrl+shift+k' }))
      .toBe('ctrl+shift+space\nctrl+shift+k');
    // Disabled is distinguishable from configured, in both slots.
    expect(pebbleHotkeyRequestKey({ summon: '', palette: 'ctrl+shift+k' }))
      .not.toBe(pebbleHotkeyRequestKey({ summon: 'ctrl+shift+k', palette: '' }));
  });

  test('the separator cannot collide with a keyspec', () => {
    // A resolved keyspec can never contain whitespace, which is what makes the
    // newline a safe separator. Pinned here rather than asserted in a comment.
    const resolved = resolvePebbleHotkeys({ summon_hotkey: 'ctrl+shift+space' }, 'darwin');
    expect(resolved.summon).not.toContain('\n');
    expect(resolved.summon).not.toMatch(/\s/);
  });

  test('close before spawn only when the ask changed', () => {
    const pair = pebbleHotkeyRequestKey({ summon: 'ctrl+shift+space', palette: 'ctrl+shift+k' });
    // Nothing asked yet: this is both a fresh sidecar (where the close is a
    // no-op) and one that outlived our restart (where it is the whole point),
    // and the daemon cannot tell them apart.
    expect(shouldCloseBeforeSpawn(undefined, pair)).toBe(true);
    // Same ask: an ordinary reconnect must not blink the pebble.
    expect(shouldCloseBeforeSpawn(pair, pair)).toBe(false);
    // Changed ask: the stale registration has to go.
    expect(shouldCloseBeforeSpawn(pair, pebbleHotkeyRequestKey({ summon: 'alt+f13', palette: 'ctrl+shift+k' }))).toBe(true);
    // Turning one off is a change too.
    expect(shouldCloseBeforeSpawn(pair, pebbleHotkeyRequestKey({ summon: 'ctrl+shift+space', palette: '' }))).toBe(true);
  });
});
