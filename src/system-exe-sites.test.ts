/**
 * #900, #907: no system tool the daemon runs may be named by its bare name,
 * which runs whichever copy comes first on PATH or, on native Windows, can
 * be one in the working directory (see win32SystemExe). They are
 * resolved by linuxSystemExe and win32SystemExe (src/util/system-exe.ts)
 * instead. This scans every non-test
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
 *   - a Bun `$` template starting with the name or with `which <name>`;
 *   - the name held as a value for a later launch: the fallback of `??`,
 *     `||`, `??=` or `||=`, a parameter's default, a returned value or arrow
 *     body, a variable's initializer, a branch of `?:`, a `shell:`-like
 *     property's value, or a plain assignment to a target named like a
 *     program (`shell = ...`; elsewhere a tool's name is also a label).
 *     Brackets, `as`, `satisfies`, `<T>` and `!` around it are seen through.
 * `cmd`, which is also a key in a chord, is caught as an argv only when it
 * is a launcher's first argument (spawn/exec*, runArgv, captureOutput,
 * runCommand), a `cmd:` property or a variable named like an argv, and as a
 * value only as a fallback, a default, or a program-named variable,
 * property or assignment target; a key mapping may return or hold it.
 * Not caught: a name assembled at run time, passed straight to a helper
 * that launches it later, or a `cmd` argv returned from a function or held
 * in a variable not named like one. The vendored activepieces tree is
 * third-party code and not scanned.
 *
 * Next to spawn-env-guard.test.ts, because it covers all of src/.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const SRC = import.meta.dir;

/**
 * Linux tools resolved through linuxSystemExe (#900), and Windows PowerShell,
 * resolved through win32SystemExe natively (#907) and windowsSystemExe from
 * WSL (#896).
 */
const BARE_NAMES = new Set([
  'xdotool', 'xprop', 'wmctrl', 'xclip', 'xsel', 'scrot', 'import', 'notify-send', 'wslpath',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe', 'clip', 'clip.exe',
]);

/** Windows names are case-insensitive, and the Linux ones are all lower case. */
const isBareName = (name: string | null | undefined): name is string => !!name && BARE_NAMES.has(name.toLowerCase());

/**
 * Names that are also a key or a word: `cmd` is the macOS modifier in a key
 * chord (`['cmd', 'c']`). They are caught only where a launch takes them, not
 * in any array or as any value.
 */
const AMBIGUOUS_NAMES = new Set(['cmd']);
const isAmbiguous = (name: string): boolean => AMBIGUOUS_NAMES.has(name.toLowerCase());

/** Calls whose first argument is an argv: Bun's and child_process's, and this repo's argv helpers. */
const LAUNCHERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'runArgv', 'captureOutput', 'runCommand']);

/** A variable that holds an argv for a later launch. */
const ARGV_VARIABLE = /argv|args|cmd|command/i;

/** `node` with any brackets, `as`, `satisfies`, `<T>` or `!` around it: the expression its parent sees. */
function unwrapped(node: ts.Node): ts.Node {
  let outer = node;
  while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent)
    || ts.isTypeAssertionExpression(outer.parent) || ts.isNonNullExpression(outer.parent)) {
    outer = outer.parent;
  }
  return outer;
}

/**
 * Whether `array` is where a launch takes its argv: a launcher's first
 * argument, a `cmd:` property, or a variable named like an argv.
 */
function inLaunchPosition(array: ts.ArrayLiteralExpression): boolean {
  const node = unwrapped(array);
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const name = calleeName(parent.expression);
    return name !== null && LAUNCHERS.has(name);
  }
  if (ts.isVariableDeclaration(parent)) {
    return parent.initializer === node && ts.isIdentifier(parent.name) && ARGV_VARIABLE.test(parent.name.text);
  }
  return ts.isPropertyAssignment(parent) && parent.initializer === node
    && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) && parent.name.text === 'cmd';
}

/**
 * Property names whose value is a program to run. Not `cmd` or `name`, which
 * tables of tools use for a name that is then given to the resolver
 * (cli/deps.ts), nor `command`, which is usually a whole command line.
 */
const PROGRAM_KEYS = new Set(['shell', 'exe', 'executable', 'program', 'binary']);

/**
 * Whether the string literal `node` is a value that can be launched later
 * (#907 re-review): the fallback of `??` or `||`, a returned value or an arrow
 * function's body, a variable's initializer, a branch of `?:`, or the value of a
 * property named in PROGRAM_KEYS (`{ shell: 'cmd.exe' }`). Not a call argument, a comparison or a type.
 */
function inValuePosition(literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
  const node = unwrapped(literal);
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    if (parent.right !== node) return false;
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken
      || op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken) return true;
    // A plain assignment only to a target named like a program: elsewhere a
    // tool's name is also a label (desktop-notify's `method = 'notify-send'`).
    return op === ts.SyntaxKind.EqualsToken && PROGRAM_TARGET.test(assignedName(parent.left) ?? '');
  }
  if (ts.isParameter(parent)) return parent.initializer === node;
  // `cmd` is also a key, which a key mapping returns or keeps in a variable:
  // only the places above, and a variable or property named like a program, count for it.
  if (isAmbiguous(literal.text)) {
    if (ts.isVariableDeclaration(parent)) return parent.initializer === node && ts.isIdentifier(parent.name) && PROGRAM_TARGET.test(parent.name.text);
    return ts.isPropertyAssignment(parent) && parent.initializer === node && PROGRAM_KEYS.has(propertyName(parent) ?? '');
  }
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isArrowFunction(parent)) return parent.body === node;
  if (ts.isVariableDeclaration(parent)) return parent.initializer === node;
  if (ts.isConditionalExpression(parent)) return parent.whenTrue === node || parent.whenFalse === node;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === node && PROGRAM_KEYS.has(propertyName(parent) ?? '');
  return false;
}

/** A variable or property that names a program to run, or an argv. */
const PROGRAM_TARGET = /shell|exe|program|binary|argv|cmd/i;

function propertyName(prop: ts.PropertyAssignment): string | null {
  return ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
}

/** The name an assignment writes: `x` in `x = ...`, `shell` in `opts.shell = ...`. */
function assignedName(target: ts.Expression): string | null {
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

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
  return isBareName(first) ? first : null;
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
      if (isBareName(first) && (!isAmbiguous(first) || inLaunchPosition(node))) report(node, `argv starting with '${first}'`);
      else if (first === 'which' && isBareName(second)) report(node, `argv 'which ${second}'`);
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && isBareName(node.text) && inValuePosition(node)) {
      report(node, `name '${node.text}' as a value`);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const first = literalText(node.arguments[0]);
      if (name === 'which' && isBareName(first)) report(node, `which('${first}')`);
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

describe('system tools are never launched by bare name (#900, #907)', () => {
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
    expect(scanBareNames(`Bun.spawn(['powershell', '-command', 'Get-Clipboard']);`)).toEqual(["1: argv starting with 'powershell'"]);
    expect(scanBareNames(`await captureOutput(['powershell.exe', '-NoProfile']);`)).toEqual(["1: argv starting with 'powershell.exe'"]);
    expect(scanBareNames(`Bun.spawn(['PowerShell.EXE', '-c', x]);`)).toEqual(["1: argv starting with 'PowerShell.EXE'"]);
    expect(scanBareNames(`Bun.spawn(['cmd.exe', '/c', x]);`)).toEqual(["1: argv starting with 'cmd.exe'"]);
  });

  test('a name held as a value, to be launched later, is caught (#907 re-review)', () => {
    expect(scanBareNames(`const shell = process.env.COMSPEC ?? 'powershell.exe';`)).toEqual(["1: name 'powershell.exe' as a value"]);
    expect(scanBareNames(`const shell = env.COMSPEC || 'cmd.exe';`)).toEqual(["1: name 'cmd.exe' as a value"]);
    expect(scanBareNames(`function shell() { return 'pwsh'; }`)).toEqual(["1: name 'pwsh' as a value"]);
    expect(scanBareNames(`const shell = () => 'powershell';`)).toEqual(["1: name 'powershell' as a value"]);
    expect(scanBareNames(`const tool = 'xclip';`)).toEqual(["1: name 'xclip' as a value"]);
    expect(scanBareNames(`const tool = isX ? 'xsel' : 'wl-paste';`)).toEqual(["1: name 'xsel' as a value"]);
    expect(scanBareNames(`spawnIt({ shell: 'cmd.exe' });`)).toEqual(["1: name 'cmd.exe' as a value"]);
    expect(scanBareNames(`const t = [{ name: 'xdotool', cmd: 'xdotool', pkg: 'xdotool' }]; linuxSystemExe(t[0].cmd);`)).toEqual([]);
  });

  test('the value and launch rules see through brackets, `as`, `satisfies`, assignments and defaults (#907 re-review)', () => {
    expect(scanBareNames(`shell = 'powershell.exe';`)).toEqual(["1: name 'powershell.exe' as a value"]);
    expect(scanBareNames(`function f(shell = 'pwsh') {}`)).toEqual(["1: name 'pwsh' as a value"]);
    expect(scanBareNames(`const t = 'xclip' as const;`)).toEqual(["1: name 'xclip' as a value"]);
    expect(scanBareNames(`const s = env.X ?? ('cmd.exe');`)).toEqual(["1: name 'cmd.exe' as a value"]);
    expect(scanBareNames(`Bun.spawn(['cmd', '/c', x] as string[]);`)).toEqual(["1: argv starting with 'cmd'"]);
    expect(scanBareNames(`Bun.spawn({ cmd: ['cmd', '/c'] as const });`)).toEqual(["1: argv starting with 'cmd'"]);
    expect(scanBareNames(`Bun.spawn((['cmd', '/c']) satisfies string[]);`)).toEqual(["1: argv starting with 'cmd'"]);
    expect(scanBareNames(`const argv = ['cmd', '/c', x]; Bun.spawn(argv);`)).toEqual(["1: argv starting with 'cmd'"]);
    expect(scanBareNames(`const shellArgs: string[] = ['cmd', '/c', x];`)).toEqual(["1: argv starting with 'cmd'"]);
    // `cmd` as a fallback, a shell-like property or variable, or a default is a program.
    expect(scanBareNames(`Bun.spawn({ cmd: [env.COMSPEC ?? 'cmd', '/c', x] });`)).toEqual(["1: name 'cmd' as a value"]);
    expect(scanBareNames(`const shell = 'cmd'; Bun.spawn([shell, '/c', x]);`)).toEqual(["1: name 'cmd' as a value"]);
    expect(scanBareNames(`run({ shell: 'cmd' });`)).toEqual(["1: name 'cmd' as a value"]);
    // A label assigned to a variable that is not named like a program passes;
    // an initializer is a value whatever the name.
    expect(scanBareNames(`method = 'notify-send';`)).toEqual([]);
    expect(scanBareNames(`let method = 'notify-send';`)).toEqual(["1: name 'notify-send' as a value"]);
    expect(scanBareNames(`function key(k) { return k === 'meta' ? 'cmd' : k; } const mod = 'cmd';`)).toEqual([]);
    // A helper whose name only contains `run` is not a launcher.
    expect(scanBareNames(`runShortcut(['cmd', 'c']);`)).toEqual([]);
    expect(scanBareNames(`const keys = ['cmd', 'c'];`)).toEqual([]);
  });

  test('a key or a word that is also a program name passes; only a launch of `cmd` is caught (#907 re-review)', () => {
    expect(scanBareNames(`await desktop.pressKeys(['cmd', 'c']);`)).toEqual([]);
    expect(scanBareNames(`const MODIFIERS = ['cmd', 'command', 'super'];`)).toEqual([]);
    expect(scanBareNames(`if (key === 'cmd') return 'meta';`)).toEqual([]);
    // Only the initializer is a value; the names in types are not.
    expect(scanBareNames(`const tool: LinuxSystemTool = 'xclip'; type T = 'xsel' | 'cmd.exe';`)).toEqual(["1: name 'xclip' as a value"]);
    expect(scanBareNames(`linuxSystemExe('xclip'); log('xclip failed'); throw new SystemExeNotFoundError('xclip', m);`)).toEqual([]);
    expect(scanBareNames(`Bun.spawn(['cmd', '/c', x]);`)).toEqual(["1: argv starting with 'cmd'"]);
    expect(scanBareNames(`Bun.spawn({ cmd: ['cmd', '/c', x] });`)).toEqual(["1: argv starting with 'cmd'"]);
    expect(scanBareNames(`execFileSync('cmd', ['/c', x]);`)).toEqual(["1: execFileSync('cmd')"]);
    expect(scanBareNames(`Bun.spawnSync(['which', 'cmd']);`)).toEqual(["1: argv 'which cmd'"]);
  });

  test('the resolver form, and names that are only words, pass', () => {
    expect(scanBareNames(`Bun.spawn([linuxSystemExe('xclip'), '-o'], {});`)).toEqual([]);
    expect(scanBareNames(`const tools = [{ name: 'xdotool' }]; log('xclip failed');`)).toEqual([]);
    expect(scanBareNames(`const s = ['export', 'import'];`)).toEqual([]);
  });
});
