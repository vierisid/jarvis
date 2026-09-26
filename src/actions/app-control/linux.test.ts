import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionOutcomeError } from '../action-outcome.ts';
import { toXdotoolKeySequence } from './linux.ts';

// Text and key names come from the model. xdotool reads a leading "-" as an
// option, and `xdotool type --file=PATH` types out PATH (#518), so every one of
// these must reach xdotool as data.
const HOSTILE_TEXT = [
  '--file=/etc/passwd',
  '-file=/etc/passwd',
  '--fi=/etc/passwd',
  '-h',
  '--help',
  '--window 1',
  '--delay 99999',
  '--delay=99999',
  '--terminator=x',
  '--',
  '-',
];

// Legitimate text that happens to start with "-" is typed as is, never refused.
const ORDINARY_TEXT = ['- item', '-5 degrees', 'hello world', 'line one\nline two', ''];

const LINUX_TS = new URL('./linux.ts', import.meta.url).href;

type Action = { op: 'type'; text: string } | { op: 'keys'; keys: string[] };
type Outcome = { ok: boolean; error?: string; code?: string; effect?: string };

/**
 * Run LinuxAppController in a child whose PATH is only `binDir` and which has
 * no DISPLAY, so a tool missing from `binDir` cannot fall through to a real
 * one on the machine running the tests. Bun's `$` resolves commands against
 * the PATH the process started with, which is why this is a child and not an
 * in-process PATH swap.
 */
async function runController(binDir: string, actions: Action[], env: Record<string, string> = {}): Promise<Outcome[]> {
  const script = `
    import { LinuxAppController } from ${JSON.stringify(LINUX_TS)};
    const ctrl = new LinuxAppController();
    const out = [];
    for (const a of ${JSON.stringify(actions)}) {
      try {
        if (a.op === 'type') await ctrl.typeText(a.text);
        else await ctrl.pressKeys(a.keys);
        out.push({ ok: true });
      } catch (e) {
        const o = { ok: false, error: e instanceof Error ? e.message : String(e) };
        if (e && e.outcome) Object.assign(o, { code: e.outcome.code, effect: e.outcome.effect });
        out.push(o);
      }
    }
    console.log('RESULT:' + JSON.stringify(out));
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    env: { PATH: binDir, HOME: binDir, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exit, stderr: exit === 0 ? '' : stderr }).toEqual({ exit: 0, stderr: '' });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  if (!line) throw new Error(`controller child printed no result:\n${stdout}\n${stderr}`);
  return JSON.parse(line.slice('RESULT:'.length)) as Outcome[];
}

/**
 * A /bin/sh stand-in for xdotool that appends each call to `calls`: its
 * arguments, each ended by NUL, then US (\037), its stdin, and RS (\036).
 */
function writeRecordingXdotool(binDir: string): void {
  const path = join(binDir, 'xdotool');
  writeFileSync(path, [
    '#!/bin/sh',
    `{ for a in "$@"; do printf '%s\\000' "$a"; done; printf '\\037'; /bin/cat; printf '\\036'; } >> '${join(binDir, 'calls')}'`,
    '',
  ].join('\n'));
  chmodSync(path, 0o755);
}

function readCalls(binDir: string): { argv: string[]; stdin: string }[] {
  const file = join(binDir, 'calls');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\x1e').slice(0, -1).map((record) => {
    const [args = '', stdin = ''] = record.split('\x1f');
    return { argv: args.split('\0').slice(0, -1), stdin };
  });
}

function refusal(keys: string[]): ActionOutcomeError {
  try {
    toXdotoolKeySequence(keys);
  } catch (error) {
    if (error instanceof ActionOutcomeError) return error;
    throw error;
  }
  throw new Error(`${JSON.stringify(keys)} was accepted`);
}

describe('toXdotoolKeySequence', () => {
  test('joins a chord with "+" and passes keysym names and xdotool aliases through', () => {
    expect(toXdotoolKeySequence(['ctrl', 'shift', 't'])).toBe('ctrl+shift+t');
    expect(toXdotoolKeySequence(['super'])).toBe('super');
    for (const key of ['Return', 'enter', 'Tab', 'minus', 'slash', 'F5', 'KP_Add', 'XF86AudioPlay', 'U20AC', '0x61', '1']) {
      expect(toXdotoolKeySequence([key])).toBe(key);
    }
  });

  test('accepts a chord the model wrote with "+" instead of ","', () => {
    // normalizeKeys splits on "," only, so "ctrl+s" arrives as one key. It
    // worked before the validation existed and must keep working.
    expect(toXdotoolKeySequence(['ctrl+s'])).toBe('ctrl+s');
  });

  test('refuses anything xdotool could read as an option', () => {
    for (const key of ['-h', '--help', '--window=1', '--delay=99999', '--repeat=500', '--file=/etc/passwd', '-', '--']) {
      expect(() => toXdotoolKeySequence([key])).toThrow(/Invalid key name/);
      expect(() => toXdotoolKeySequence(['ctrl', key])).toThrow(/Invalid key name/);
    }
  });

  test('refuses names xdotool cannot press anyway', () => {
    // xdotool itself rejects " .-[]{}\|" and ignores names XStringToKeysym
    // does not know ("/", "@"), so none of these ever pressed a key.
    for (const key of ['a b', 'KP.1', '/', '@', 'é', 'ctrl\ns']) {
      expect(() => toXdotoolKeySequence([key])).toThrow(/Invalid key name/);
    }
  });

  test('refuses a lone key named like an xdotool command, which xdotool would run', () => {
    for (const key of ['exec', 'EXEC', 'selectwindow', 'windowkill', 'type', 'help', 'HELP']) {
      expect(() => toXdotoolKeySequence([key])).toThrow(/xdotool command name/);
    }
    // Inside a chord the argument contains "+" and can never name a command.
    expect(toXdotoolKeySequence(['ctrl', 'exec'])).toBe('ctrl+exec');
  });

  test('lets the Help keysym through, which the trailing "+" keeps from being the help command', () => {
    expect(toXdotoolKeySequence(['Help'])).toBe('Help');
  });

  test('refuses an empty chord', () => {
    expect(() => toXdotoolKeySequence([])).toThrow(/No keys/);
    expect(() => toXdotoolKeySequence(['+'])).toThrow(/No keys/);
  });

  test('refuses a chord long enough to hit libxdo\'s broken array growth', () => {
    // libxdo corrupts its heap once a sequence reaches 10 keys; 8 is the cap.
    expect(toXdotoolKeySequence(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toBe('a+b+c+d+e+f+g+h');
    expect(() => toXdotoolKeySequence(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])).toThrow(/Too many keys in one chord \(9\)/);
    expect(() => toXdotoolKeySequence(['a+b+c+d+e+f+g+h+i+j'])).toThrow(/Too many keys/);
  });

  test('checks names before the count, as the sidecar does', () => {
    expect(() => toXdotoolKeySequence(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '-i'])).toThrow(/Invalid key name "-i"/);
  });

  test('a refusal is a not-started outcome, so the model fixes the name instead of checking what happened', () => {
    for (const keys of [['-h'], [], ['exec'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']]) {
      const error = refusal(keys);
      expect(error.outcome).toMatchObject({ status: 'error', code: 'DESKTOP_INVALID_KEYS', effect: 'not_started' });
      expect(error.message).toMatch(/^Error: .*Nothing was pressed\.$/);
    }
  });
});

describe('LinuxAppController with a recording xdotool on PATH', () => {
  let binDir: string;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'jarvis-xdotool-'));
    writeRecordingXdotool(binDir);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test('typeText passes hostile and ordinary text as one argument after "--"', async () => {
    rmSync(join(binDir, 'calls'), { force: true });
    const texts = [...HOSTILE_TEXT, ...ORDINARY_TEXT];
    const outcomes = await runController(binDir, texts.map((text) => ({ op: 'type', text })));

    expect(outcomes).toEqual(texts.map(() => ({ ok: true })));
    const calls = readCalls(binDir);
    expect(calls.map((c) => c.argv)).toEqual(texts.map((text) => ['type', '--clearmodifiers', '--', text]));
    // The text travels in argv after "--" and nowhere else.
    expect(calls.map((c) => c.stdin)).toEqual(texts.map(() => ''));
  });

  test('pressKeys passes the chord as one argument after "--", ending in "+"', async () => {
    rmSync(join(binDir, 'calls'), { force: true });
    const outcomes = await runController(binDir, [
      { op: 'keys', keys: ['ctrl', 's'] },
      { op: 'keys', keys: ['Return'] },
      { op: 'keys', keys: ['ctrl+shift+t'] },
      { op: 'keys', keys: ['Help'] },
    ]);

    expect(outcomes).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    expect(readCalls(binDir).map((c) => c.argv)).toEqual([
      ['key', '--clearmodifiers', '--', 'ctrl+s+'],
      ['key', '--clearmodifiers', '--', 'Return+'],
      ['key', '--clearmodifiers', '--', 'ctrl+shift+t+'],
      ['key', '--clearmodifiers', '--', 'Help+'],
    ]);
  });

  test('pressKeys refuses option-like and command-like keys, as not started, without running xdotool', async () => {
    rmSync(join(binDir, 'calls'), { force: true });
    const hostile: string[][] = [['--file=/etc/passwd'], ['-h'], ['--window', '1'], ['--delay', '99999'], ['--window=1'], ['exec']];
    const outcomes = await runController(binDir, hostile.map((keys) => ({ op: 'keys', keys })));

    expect(outcomes).toHaveLength(hostile.length);
    for (const o of outcomes) {
      expect(o).toMatchObject({ ok: false, code: 'DESKTOP_INVALID_KEYS', effect: 'not_started' });
      expect(o.error).toMatch(/Nothing was pressed\.$/);
    }
    expect(readCalls(binDir)).toEqual([]);
  });
});

// ── Real xdotool, no X server ────────────────────────────────────────
//
// The recording fake proves what argv we send; this proves what the real
// xdotool does with it. An LD_PRELOAD shim replaces libxdo's X entry points,
// so xdotool parses its arguments exactly as in production and reports what it
// would type instead of touching a display. DISPLAY is unset as well, so if
// the shim ever failed to load, xdo_new() would find no display and type
// nothing. Skipped where xdotool or a C compiler is missing.

const SHIM_C = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct xdo xdo_t;
typedef unsigned long Window;
static void record(const char *kind, const char *s) {
  FILE *f = fopen(getenv("XDO_SHIM_LOG"), "a");
  if (!f) return;
  fprintf(f, "%s ", kind);
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) fprintf(f, "%02x", *p);
  fprintf(f, "\n");
  fclose(f);
}
xdo_t *xdo_new(const char *d) { (void)d; return calloc(1, 4096); }
void xdo_free(xdo_t *x) { free(x); }
int xdo_enter_text_window(const xdo_t *x, Window w, const char *s, unsigned int delay) {
  (void)x; (void)w; (void)delay; record("TYPE", s); return 0; }
int xdo_send_keysequence_window(const xdo_t *x, Window w, const char *s, unsigned int delay) {
  (void)x; (void)w; (void)delay; record("KEY", s); return 0; }
int xdo_get_active_modifiers(const xdo_t *x, void **keys, int *n) { (void)x; *keys = NULL; *n = 0; return 0; }
int xdo_clear_active_modifiers(const xdo_t *x, Window w, void *k, int n) { (void)x; (void)w; (void)k; (void)n; return 0; }
int xdo_set_active_modifiers(const xdo_t *x, Window w, void *k, int n) { (void)x; (void)w; (void)k; (void)n; return 0; }
`;

/**
 * The real xdotool, used only when it is an ELF binary linked against libxdo
 * in a system bin directory. Whatever else answers to `xdotool` on PATH -- a
 * script, or a Wayland compatibility wrapper that types through ydotool or
 * uinput and so ignores DISPLAY -- could reach the desktop the tests run on,
 * so it is never run.
 */
function findRealXdotool(): string | null {
  if (process.platform !== 'linux') return null;
  for (const path of ['/usr/bin/xdotool', '/usr/local/bin/xdotool']) {
    try {
      const bytes = readFileSync(path);
      if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes.includes('libxdo.so')) return path;
    } catch {
      // Not installed here.
    }
  }
  return null;
}

const realXdotool = findRealXdotool();
const compiler = Bun.which('cc') ?? Bun.which('gcc');

/**
 * Build the shim and a wrapper that runs the real xdotool under it, then check
 * the pair works on this machine: another xdotool build may call a libxdo
 * function the shim does not stub, or the compiler may lack headers. Returns
 * the directory holding bin/xdotool and the shim's log, or null to skip.
 */
function prepareShim(): { dir: string; log: string } | null {
  if (!realXdotool || !compiler) return null;
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-xdo-shim-'));
  const log = join(dir, 'shim.log');
  writeFileSync(join(dir, 'shim.c'), SHIM_C);
  const cc = spawnSync(compiler, ['-shared', '-fPIC', '-o', join(dir, 'shim.so'), join(dir, 'shim.c')], { encoding: 'utf-8' });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'xdotool'), [
    '#!/bin/sh',
    'unset DISPLAY WAYLAND_DISPLAY XAUTHORITY',
    `XDO_SHIM_LOG='${log}' LD_PRELOAD='${join(dir, 'shim.so')}' exec '${realXdotool}' "$@"`,
    '',
  ].join('\n'));
  chmodSync(join(bin, 'xdotool'), 0o755);
  const probe = cc.status === 0
    ? spawnSync(join(bin, 'xdotool'), ['type', '--', 'probe'], { encoding: 'utf-8', timeout: 10_000, env: { PATH: bin } })
    : null;
  const works = probe?.status === 0 && existsSync(log) && readFileSync(log, 'utf-8').startsWith('TYPE ');
  if (!works) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  rmSync(log);
  return { dir, log };
}

const shim = prepareShim();

// CI installs xdotool and sets this, so the check above cannot quietly turn
// into a skip there (a runner image whose xdotool the shim cannot stub).
if (process.env.JARVIS_REQUIRE_XDOTOOL_SHIM === '1') {
  test('the real-xdotool shim tests run here', () => {
    expect({ realXdotool, compiler, shimReady: shim !== null }).toMatchObject({ shimReady: true });
  });
}

describe.skipIf(!shim)('real xdotool argument parsing (libxdo stubbed, no display)', () => {
  const { dir, log } = shim ?? { dir: '', log: '' };

  function readShimLog(): string[] {
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((line) => {
      const [kind, hex = ''] = line.split(' ');
      return `${kind} ${Buffer.from(hex, 'hex').toString('utf-8')}`;
    });
  }

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('types option-like text literally and never opens a file', async () => {
    rmSync(log, { force: true });
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET');
    const texts = [`--file=${secret}`, `-file=${secret}`, `--fi=${secret}`, '-h', '--window 1', '--delay=99999', '--', '- item', 'hello world'];

    const outcomes = await runController(join(dir, 'bin'), texts.map((text) => ({ op: 'type', text })));

    expect(outcomes).toEqual(texts.map(() => ({ ok: true })));
    const typed = readShimLog();
    expect(typed).toEqual(texts.map((t) => `TYPE ${t}`));
    expect(typed.join('\n')).not.toContain('TOP-SECRET');
  });

  test('presses the chord it was given, and a lone Help as a key rather than the help command', async () => {
    rmSync(log, { force: true });
    const outcomes = await runController(join(dir, 'bin'), [
      { op: 'keys', keys: ['ctrl', 's'] },
      { op: 'keys', keys: ['ctrl', 'Help'] },
      { op: 'keys', keys: ['Help'] },
    ]);

    expect(outcomes).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    // libxdo receives the argument as is and skips the empty key after "+".
    expect(readShimLog()).toEqual(['KEY ctrl+s+', 'KEY ctrl+Help+', 'KEY Help+']);
  });
});

// ── Real X server ────────────────────────────────────────────────────
//
// Types into an xterm on a private Xvfb display, never the session the tests
// run in. Needs Xvfb, xterm and a real xdotool; skipped otherwise.

const xvfb = Bun.which('Xvfb');
const xterm = Bun.which('xterm');
const timeoutBin = Bun.which('timeout');
const bounded = timeoutBin ? [timeoutBin, '120'] : [];
// An odd size no real monitor has, checked before anything is typed.
const XVFB_WIDTH = 823;
const XVFB_HEIGHT = 617;

describe.skipIf(!xvfb || !xterm || !realXdotool)('typing into an xterm on a private Xvfb display', () => {
  let dir: string;
  let display: string;
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let term: ReturnType<typeof Bun.spawn> | undefined;
  const pathEnv = process.env.PATH ?? '/usr/bin:/bin';

  function onDisplay(args: string[]): string {
    const r = spawnSync(realXdotool!, args, { encoding: 'utf-8', timeout: 10_000, env: { PATH: pathEnv, DISPLAY: display } });
    if (r.status !== 0) throw new Error(`xdotool ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  async function readLines(file: string, count: number): Promise<string[]> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const lines = existsSync(file) ? readFileSync(file, 'utf-8').split('\n').slice(0, -1) : [];
      if (lines.length >= count) return lines;
      await Bun.sleep(100);
    }
    return existsSync(file) ? readFileSync(file, 'utf-8').split('\n').slice(0, -1) : [];
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-xvfb-'));
    // -displayfd makes Xvfb pick a free display and print its number. The
    // `timeout` bounds both helpers, so a killed test run cannot orphan them.
    server = Bun.spawn([...bounded, xvfb!, '-displayfd', '1', '-nolisten', 'tcp', '-screen', '0', `${XVFB_WIDTH}x${XVFB_HEIGHT}x24`], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
    });
    const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
    let buf = '';
    while (!buf.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Xvfb exited before reporting a display');
      buf += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    display = `:${buf.trim()}`;

    // Before any window, focus or keystroke: prove this display is the Xvfb
    // just started. In a private-/tmp namespace Xvfb can claim a display
    // number whose abstract socket belongs to the real server.
    const geometry = onDisplay(['getdisplaygeometry']);
    if (geometry !== `${XVFB_WIDTH} ${XVFB_HEIGHT}`) {
      display = '';
      throw new Error(`display reported ${geometry}, not the private Xvfb; refusing to type into it`);
    }

    const out = join(dir, 'typed.txt');
    term = Bun.spawn([...bounded, xterm!, '-geometry', '80x10+0+0', '-e', 'sh', '-c', `while IFS= read -r l; do printf '%s\\n' "$l" >> '${out}'; done`], {
      env: { PATH: pathEnv, DISPLAY: display, HOME: dir },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    });
    const win = onDisplay(['search', '--sync', '--onlyvisible', '--class', 'xterm']).split('\n')[0]!;
    onDisplay(['mousemove', '--window', win, '20', '20']);
    onDisplay(['windowfocus', '--sync', win]);
  }, 30_000);

  afterAll(() => {
    term?.kill();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test('text that looks like an option arrives in the window literally', async () => {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET\n');
    const texts = [`--file=${secret}`, '-h', '--window 1', '- item'];
    const actions: Action[] = [];
    for (const text of texts) {
      actions.push({ op: 'type', text }, { op: 'keys', keys: ['Return'] });
    }
    // The controller finds only the verified xdotool on its PATH.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    symlinkSync(realXdotool!, join(bin, 'xdotool'));

    const outcomes = await runController(bin, actions, { DISPLAY: display });

    expect(outcomes).toEqual(actions.map(() => ({ ok: true })));
    expect(await readLines(join(dir, 'typed.txt'), texts.length)).toEqual(texts);
  }, 30_000);
});
