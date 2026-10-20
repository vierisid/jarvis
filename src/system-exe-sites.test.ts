/**
 * #900: no system tool the daemon runs may be named by its bare name, which
 * runs whichever copy comes first on PATH. They are resolved by
 * linuxSystemExe (src/util/system-exe.ts) instead. This scans every non-test
 * source file under src/ for the shapes a bare-name launch takes, so a new
 * site that forgets the resolver fails here rather than in a review.
 *
 * Shapes caught, for each name in BARE_NAMES:
 *   - an array literal whose first element is the name (`Bun.spawn(['xclip', ...])`,
 *     `Bun.spawn({ cmd: ['xclip'] })`, `runArgv(['wslpath', ...])`, an argv
 *     built for a later spawn), or that is `['which', <name>]`;
 *   - a PATH lookup of the name (`Bun.which('xclip')`);
 *   - a node:child_process call whose first argument is the name, or a
 *     command string starting with it (`execFileSync('xclip', ...)`,
 *     `execSync('xclip -o')`);
 *   - a Bun `$` template starting with the name or with `which <name>`.
 * Not caught: a name assembled at run time. The vendored activepieces tree is
 * third-party code and not scanned.
 *
 * Next to spawn-env-guard.test.ts, because it covers all of src/.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const SRC = import.meta.dir;

/** Linux tools resolved through linuxSystemExe (#900). */
const BARE_NAMES = new Set(['xdotool', 'xprop', 'wmctrl', 'xclip', 'xsel', 'scrot', 'import', 'notify-send', 'wslpath']);

const CHILD_PROCESS_CALLS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']);

const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /\.test\.(ts|tsx|mts|cts)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(SRC, full).split(sep).join('/') === 'workflows/activepieces') continue;
      out.push(...walk(full));
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** The bare name a command string starts with, or null. */
function leadingName(command: string): string | null {
  const words = command.trim().split(/\s+/);
  const first = words[0] === 'which' ? words[1] : words[0];
  return first !== undefined && BARE_NAMES.has(first) ? first : null;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Each bare-name launch in `source`, as "line: what". */
export function scanBareNames(source: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const report = (node: ts.Node, what: string) => {
    found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const first = literalText(node.elements[0]);
      const second = literalText(node.elements[1]);
      if (first !== null && BARE_NAMES.has(first)) report(node, `argv starting with '${first}'`);
      else if (first === 'which' && second !== null && BARE_NAMES.has(second)) report(node, `argv 'which ${second}'`);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const first = literalText(node.arguments[0]);
      if (name === 'which' && first !== null && BARE_NAMES.has(first)) report(node, `which('${first}')`);
      if (name && CHILD_PROCESS_CALLS.has(name) && first !== null) {
        const bare = leadingName(first);
        if (bare) report(node, `${name}('${first}')`);
      }
    } else if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === '$') {
      const head = ts.isNoSubstitutionTemplateLiteral(node.template) ? node.template.text : node.template.head.text;
      const bare = leadingName(head);
      if (bare) report(node, `$\`${head.trim()}...\``);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('system tools are never launched by bare name (#900)', () => {
  test('no source file under src/ does', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      for (const hit of scanBareNames(readFileSync(file, 'utf8'), rel)) offenders.push(`${rel}:${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  test('the scan sees every shape it claims to', () => {
    expect(scanBareNames(`Bun.spawn(['xclip', '-o'], {});`)).toEqual(["1: argv starting with 'xclip'"]);
    expect(scanBareNames('const argv = [`wslpath`, flag, path];')).toEqual(["1: argv starting with 'wslpath'"]);
    expect(scanBareNames(`execFileSync('scrot', [file]);`)).toEqual(["1: execFileSync('scrot')"]);
    expect(scanBareNames(`cp.execSync('import -window root x.png');`)).toEqual(["1: execSync('import -window root x.png')"]);
    expect(scanBareNames('await $`which ${tool}`;')).toEqual([]);
    expect(scanBareNames('await $`which notify-send`.quiet();')).toEqual(['1: $`which notify-send...`']);
    expect(scanBareNames('await $`xdotool key ${k}`;')).toEqual(['1: $`xdotool key...`']);
    expect(scanBareNames(`Bun.spawnSync(['which', 'notify-send']);`)).toEqual(["1: argv 'which notify-send'"]);
    expect(scanBareNames(`const p = Bun.which('xsel');`)).toEqual(["1: which('xsel')"]);
    expect(scanBareNames(`Bun.spawn({ cmd: ['scrot', file] });`)).toEqual(["1: argv starting with 'scrot'"]);
  });

  test('the resolver form, and names that are only words, pass', () => {
    expect(scanBareNames(`Bun.spawn([linuxSystemExe('xclip'), '-o'], {});`)).toEqual([]);
    expect(scanBareNames(`const tools = [{ name: 'xdotool' }]; log('xclip failed');`)).toEqual([]);
    expect(scanBareNames(`const s = ['export', 'import'];`)).toEqual([]);
  });
});
